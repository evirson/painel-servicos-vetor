import bcrypt from 'bcryptjs'
import { prisma } from '@vetor/db'
import type { ProbeResult } from '@vetor/probes'
import { recordResult } from './runner'

/**
 * Ingestão do relato do agente que roda DENTRO de um servidor monitorado.
 *
 * Existe porque as portas internas do VPS (bancos, containers) ficam fechadas
 * para a internet — de fora elas são invisíveis. O agente empurra os dados por
 * HTTPS, então não é preciso abrir porta nova nem dar credencial de produção
 * ao painel.
 *
 * Cada item relatado vira um `Target` (auto-provisionado no primeiro relato) e
 * passa por `recordResult`, reaproveitando toda a lógica de incidente.
 */

export type RelatoDisco = { mount: string; usadoPct: number; livreGb?: number }
export type RelatoContainer = {
  nome: string
  estado: string // running | exited | restarting | paused | dead
  health?: string | null // healthy | unhealthy | starting | null
  reinicios?: number
  status?: string // texto livre do docker ("Up 3 hours")
}
export type RelatoPorta = { rotulo: string; porta: number; aberta: boolean }

export type RelatoAgente = {
  cpuPct?: number
  memUsadaPct?: number
  uptimeSeg?: number
  load1?: number
  discos?: RelatoDisco[]
  containers?: RelatoContainer[]
  portas?: RelatoPorta[]
}

/** Limiares padrão; sobrescrevíveis pelo `config` de cada alvo. */
const PADRAO = { degradedPct: 85, downPct: 95 }
const INTERVALO_PADRAO_SEG = 60

/**
 * Autentica o agente pelo token Bearer. Compara contra o hash bcrypt de cada
 * host ativo — a comparação é feita em todos os candidatos (poucos hosts) para
 * não vazar, pelo tempo de resposta, qual host existe.
 */
export async function autenticarHost(authorization?: string) {
  const token = authorization?.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const hosts = await prisma.host.findMany({ where: { ativo: true } })
  for (const h of hosts) {
    if (bcrypt.compareSync(token, h.tokenHash)) return h
  }
  return null
}

/**
 * Encontra (ou cria) o alvo de um item relatado pelo agente.
 * Auto-provisionamento: um container novo aparece sozinho no painel, sempre com
 * `publico: false` — quem decide o que o cliente vê é o admin, nunca o agente.
 */
async function alvoDoItem(
  hostId: string,
  chaveAgente: string,
  tipo: 'host_metric' | 'docker_container',
  nome: string,
  intervaloSegundos: number,
) {
  const existente = await prisma.target.findFirst({ where: { hostId, chaveAgente } })
  if (existente) return existente
  return prisma.target.create({
    data: {
      nome,
      tipo,
      hostId,
      chaveAgente,
      intervaloSegundos,
      publico: false,
      ativo: true,
    },
  })
}

function avaliarDisco(d: RelatoDisco, cfg: any): ProbeResult {
  const degradedPct = Number(cfg?.degradedPct) || PADRAO.degradedPct
  const downPct = Number(cfg?.downPct) || PADRAO.downPct
  const livre = d.livreGb != null ? `, ${d.livreGb.toFixed(1)}GB livres` : ''
  const msg = `${d.usadoPct.toFixed(1)}% usado${livre}`
  if (d.usadoPct >= downPct) return { status: 'down', mensagem: `disco cheio: ${msg}` }
  if (d.usadoPct >= degradedPct) return { status: 'degraded', mensagem: `disco enchendo: ${msg}` }
  return { status: 'up', mensagem: msg }
}

function avaliarContainer(c: RelatoContainer, anterior: number | null): ProbeResult {
  const detalhe = c.status ? ` (${c.status})` : ''
  if (c.estado !== 'running') {
    return { status: 'down', mensagem: `container ${c.estado}${detalhe}` }
  }
  if (c.health === 'unhealthy') {
    return { status: 'degraded', mensagem: `healthcheck unhealthy${detalhe}` }
  }
  // Reinício desde o último relato indica crash loop, mesmo com o container "up".
  if (anterior != null && c.reinicios != null && c.reinicios > anterior) {
    return {
      status: 'degraded',
      mensagem: `reiniciou ${c.reinicios - anterior}x desde o último relato (total ${c.reinicios})`,
    }
  }
  return { status: 'up', mensagem: c.status || 'running' }
}

export async function processarRelato(hostId: string, relato: RelatoAgente) {
  const intervalo = INTERVALO_PADRAO_SEG
  let itens = 0

  // ---- Discos ----
  for (const d of relato.discos ?? []) {
    if (!d?.mount || typeof d.usadoPct !== 'number') continue
    const alvo = await alvoDoItem(hostId, `disco:${d.mount}`, 'host_metric', `Disco ${d.mount}`, intervalo)
    await recordResult(alvo.id, avaliarDisco(d, alvo.config))
    itens++
  }

  // ---- CPU / memória ----
  const metricas: [string, number | undefined, string][] = [
    ['cpu', relato.cpuPct, 'CPU'],
    ['mem', relato.memUsadaPct, 'Memória'],
  ]
  for (const [chave, valor, rotulo] of metricas) {
    if (typeof valor !== 'number') continue
    const alvo = await alvoDoItem(hostId, chave, 'host_metric', rotulo, intervalo)
    const cfg: any = alvo.config ?? {}
    const degradedPct = Number(cfg.degradedPct) || 90
    const downPct = Number(cfg.downPct) || 98
    const msg = `${valor.toFixed(1)}% em uso`
    await recordResult(alvo.id, {
      status: valor >= downPct ? 'down' : valor >= degradedPct ? 'degraded' : 'up',
      mensagem: msg,
    })
    itens++
  }

  // ---- Containers ----
  for (const c of relato.containers ?? []) {
    if (!c?.nome) continue
    const alvo = await alvoDoItem(
      hostId,
      `container:${c.nome}`,
      'docker_container',
      `Container ${c.nome}`,
      intervalo,
    )
    const cfg: any = alvo.config ?? {}
    const anterior = typeof cfg.reinicios === 'number' ? cfg.reinicios : null
    await recordResult(alvo.id, avaliarContainer(c, anterior))
    // Guarda a contagem para detectar crash loop no próximo relato.
    if (c.reinicios != null && c.reinicios !== anterior) {
      await prisma.target.update({
        where: { id: alvo.id },
        data: { config: { ...cfg, reinicios: c.reinicios } },
      })
    }
    itens++
  }

  // ---- Portas internas (bancos etc., invisíveis de fora) ----
  for (const p of relato.portas ?? []) {
    if (!p?.porta) continue
    const rotulo = p.rotulo || `porta ${p.porta}`
    const alvo = await alvoDoItem(hostId, `porta:${p.porta}`, 'host_metric', rotulo, intervalo)
    await recordResult(alvo.id, {
      status: p.aberta ? 'up' : 'down',
      mensagem: p.aberta ? `porta ${p.porta} aceitando conexão` : `porta ${p.porta} recusando conexão`,
    })
    itens++
  }

  await prisma.host.update({ where: { id: hostId }, data: { lastSeenAt: new Date() } })
  return { itens }
}
