import { prisma } from '@vetor/db'
import { checkTarget } from './runner'
import { rodarManutencao } from './rollup'

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
  const targets = await prisma.target.findMany({ where: { ativo: true } })
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
}
