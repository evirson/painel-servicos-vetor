import { prisma } from '@vetor/db'
import { runProbe } from '@vetor/probes'

/**
 * Executa a checagem de um alvo: roda a sonda, grava o histórico,
 * atualiza o estado atual e abre/fecha incidentes.
 */
export async function checkTarget(targetId: string) {
  const target = await prisma.target.findUnique({ where: { id: targetId } })
  if (!target) return null

  const result = await runProbe({
    tipo: target.tipo,
    host: target.host,
    porta: target.porta,
    url: target.url,
    timeoutMs: target.timeoutMs,
    config: target.config,
  })

  await prisma.check.create({
    data: {
      targetId: target.id,
      status: result.status,
      latenciaMs: result.latenciaMs ?? null,
      mensagem: result.mensagem ?? null,
    },
  })

  // Incidente é aberto/fechado apenas na transição de/para "down".
  const wasDown = target.lastStatus === 'down'
  const isDown = result.status === 'down'

  if (isDown && !wasDown) {
    await prisma.incident.create({ data: { targetId: target.id, resumo: result.mensagem ?? null } })
  } else if (!isDown && wasDown) {
    const aberto = await prisma.incident.findFirst({
      where: { targetId: target.id, fim: null },
      orderBy: { inicio: 'desc' },
    })
    if (aberto) {
      await prisma.incident.update({ where: { id: aberto.id }, data: { fim: new Date() } })
    }
  }

  await prisma.target.update({
    where: { id: target.id },
    data: { lastStatus: result.status, lastCheckedAt: new Date() },
  })

  return result
}
