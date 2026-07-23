import { prisma } from '@vetor/db'

/**
 * Consolidação diária + retenção do histórico.
 *
 * Motivo: `Check` cresce ~1.440 linhas por alvo por dia. Com o VPS inteiro
 * cadastrado (~30 alvos), 90 dias são ~3,9 milhões de linhas — o suficiente para
 * a página pública derrubar o worker por falta de memória (medido: OOM kill).
 * `CheckDaily` reduz isso a 90 linhas por alvo.
 *
 * A agregação é feita PELO BANCO (groupBy), nunca carregando linhas no Node.
 */

export const RETENCAO_DIAS = Number(process.env.RETENCAO_DIAS) || 90

/** Meia-noite UTC do dia de uma data. UTC para casar com o agrupamento por ISO date. */
export function diaUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

const UM_DIA = 86_400_000

/**
 * Consolida um dia (intervalo [dia, dia+1)) em CheckDaily.
 * Idempotente: reprocessar o mesmo dia atualiza a linha em vez de duplicar.
 */
export async function consolidarDia(dia: Date) {
  const inicio = diaUTC(dia)
  const fim = new Date(inicio.getTime() + UM_DIA)
  const janela = { timestamp: { gte: inicio, lt: fim } }

  const [porStatus, porTarget] = await Promise.all([
    prisma.check.groupBy({ by: ['targetId', 'status'], where: janela, _count: { _all: true } }),
    prisma.check.groupBy({ by: ['targetId'], where: janela, _avg: { latenciaMs: true } }),
  ])
  if (!porStatus.length) return 0

  const acc = new Map<string, { up: number; degraded: number; down: number; total: number }>()
  for (const linha of porStatus) {
    const a = acc.get(linha.targetId) ?? { up: 0, degraded: 0, down: 0, total: 0 }
    const n = linha._count._all
    a[linha.status as 'up' | 'degraded' | 'down'] += n
    a.total += n
    acc.set(linha.targetId, a)
  }
  const medias = new Map(porTarget.map((l) => [l.targetId, l._avg.latenciaMs]))

  for (const [targetId, a] of acc) {
    const media = medias.get(targetId)
    const dados = {
      ...a,
      latenciaMediaMs: media == null ? null : Math.round(media),
    }
    await prisma.checkDaily.upsert({
      where: { targetId_dia: { targetId, dia: inicio } },
      update: dados,
      create: { targetId, dia: inicio, ...dados },
    })
  }
  return acc.size
}

/**
 * Consolida o dia corrente e os anteriores que ainda não foram consolidados.
 * Roda no boot (recuperando o que ficou para trás enquanto o worker esteve fora)
 * e periodicamente depois.
 */
export async function consolidarPendentes() {
  const hoje = diaUTC(new Date())
  const limite = new Date(hoje.getTime() - RETENCAO_DIAS * UM_DIA)

  // Ponto de partida: o check mais antigo ainda dentro da janela de retenção.
  const maisAntigo = await prisma.check.findFirst({
    where: { timestamp: { gte: limite } },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true },
  })
  if (!maisAntigo) return { dias: 0 }

  // Dias já consolidados são pulados — exceto hoje, que ainda está mudando.
  const jaFeitos = new Set(
    (await prisma.checkDaily.findMany({ where: { dia: { gte: limite } }, select: { dia: true } }))
      .map((r) => r.dia.toISOString().slice(0, 10)),
  )

  let dias = 0
  for (let d = diaUTC(maisAntigo.timestamp); d <= hoje; d = new Date(d.getTime() + UM_DIA)) {
    const chave = d.toISOString().slice(0, 10)
    const ehHoje = d.getTime() === hoje.getTime()
    if (!ehHoje && jaFeitos.has(chave)) continue
    await consolidarDia(d)
    dias++
  }
  return { dias }
}

/**
 * Apaga o histórico bruto além da retenção. Roda SEMPRE depois da consolidação,
 * senão apagaríamos linhas que ainda não viraram resumo diário.
 */
export async function podarChecks() {
  const limite = new Date(diaUTC(new Date()).getTime() - RETENCAO_DIAS * UM_DIA)
  const { count } = await prisma.check.deleteMany({ where: { timestamp: { lt: limite } } })
  // O resumo diário fora da janela também deixa de interessar.
  await prisma.checkDaily.deleteMany({ where: { dia: { lt: limite } } })
  return count
}

export async function rodarManutencao(log: { info: (msg: string) => void; error: (o: any, m: string) => void }) {
  try {
    const { dias } = await consolidarPendentes()
    const podados = await podarChecks()
    if (dias || podados) {
      log.info(`[rollup] ${dias} dia(s) consolidado(s), ${podados} checagem(ns) antiga(s) removida(s).`)
    }
  } catch (err) {
    log.error({ err }, '[rollup] falha na manutenção do histórico')
  }
}
