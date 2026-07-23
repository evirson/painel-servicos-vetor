import { prisma } from '@vetor/db'
import { checkTarget, recordResult } from './runner'
import { rodarManutencao } from './rollup'
import { TIPOS_PUSH } from './tipos-push'

/**
 * Agendador em processo. Mantém um timer por alvo ativo e ressincroniza
 * a cada 30s para captar alvos novos/editados/removidos.
 *
 * Escala tranquilamente para dezenas/centenas de alvos. Se um dia precisar de
 * múltiplos workers ou filas distribuídas, troque isto por BullMQ + Redis.
 */
type TimerInfo = { timer: NodeJS.Timeout; intervalo: number }
const timers = new Map<string, TimerInfo>()

function run(id: string) {
  checkTarget(id).catch((err) => console.error(`[check] erro em ${id}:`, err))
}

async function sync() {
  // Alvos push não têm sonda para executar — quem os alimenta é o agente.
  const targets = await prisma.target.findMany({
    where: { ativo: true, tipo: { notIn: [...TIPOS_PUSH] } },
  })
  const ativos = new Set(targets.map((t) => t.id))

  // Remove timers de alvos que não estão mais ativos.
  for (const [id, info] of timers) {
    if (!ativos.has(id)) {
      clearInterval(info.timer)
      timers.delete(id)
    }
  }

  // Cria/atualiza timers.
  for (const t of targets) {
    const intervalo = Math.max(5, t.intervaloSegundos)
    const existing = timers.get(t.id)
    if (existing && existing.intervalo === intervalo) continue
    if (existing) clearInterval(existing.timer)

    run(t.id) // roda uma vez imediatamente
    const timer = setInterval(() => run(t.id), intervalo * 1000)
    timers.set(t.id, { timer, intervalo })
  }
}

// Consolidação do histórico + poda. De hora em hora basta: a página pública lê o
// dia corrente direto do bruto, então o atraso do resumo não aparece para o usuário.
const INTERVALO_MANUTENCAO_MS = 3600_000

// Quantos intervalos de silêncio toleramos antes de declarar o alvo push como
// down. 3x dá margem para um relato atrasado sem gerar alarme falso.
const TOLERANCIA_SILENCIO = 3
const INTERVALO_WATCHDOG_MS = 60_000

/**
 * Watchdog dos alvos push. Sem ele, um agente morto (container parado, VPS
 * desligado, token revogado) deixaria os alvos congelados no último estado —
 * tipicamente verde — para sempre. Um painel que mostra verde porque parou de
 * receber notícias é pior do que um painel que não existe.
 */
async function watchdogPush() {
  const agora = Date.now()
  const alvos = await prisma.target.findMany({
    where: { ativo: true, tipo: { in: [...TIPOS_PUSH] } },
    select: { id: true, nome: true, intervaloSegundos: true, lastCheckedAt: true, lastStatus: true },
  })

  for (const a of alvos) {
    const limiteMs = a.intervaloSegundos * 1000 * TOLERANCIA_SILENCIO
    const silencioMs = agora - (a.lastCheckedAt?.getTime() ?? 0)
    if (silencioMs <= limiteMs) continue
    // Já marcado como down por silêncio: não repete o registro a cada minuto.
    if (a.lastStatus === 'down') continue

    const min = Math.round(silencioMs / 60_000)
    await recordResult(a.id, {
      status: 'down',
      mensagem: `sem relato do agente há ~${min} min (esperado a cada ${a.intervaloSegundos}s)`,
    })
    console.warn(`[watchdog] "${a.nome}" sem relato há ~${min} min — marcado como down.`)
  }
}

export function startScheduler() {
  const log = {
    info: (msg: string) => console.log(msg),
    error: (o: any, m: string) => console.error(m, o),
  }

  sync().catch((err) => console.error('[scheduler] sync inicial falhou:', err))
  setInterval(() => sync().catch((err) => console.error('[scheduler] sync falhou:', err)), 30_000)

  // No boot, recupera os dias que ficaram para trás enquanto o worker esteve fora.
  rodarManutencao(log)
  setInterval(() => rodarManutencao(log), INTERVALO_MANUTENCAO_MS)

  setInterval(
    () => watchdogPush().catch((err) => console.error('[watchdog] falhou:', err)),
    INTERVALO_WATCHDOG_MS,
  )
}
