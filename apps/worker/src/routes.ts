import type { FastifyInstance } from 'fastify'
import { prisma } from '@vetor/db'
import { checkTarget } from './runner'

const TARGET_FIELDS = [
  'nome', 'tipo', 'host', 'porta', 'url', 'config',
  'intervaloSegundos', 'timeoutMs', 'ativo', 'publico', 'statusGroupId',
] as const

function pickTarget(body: any, partial = false) {
  const data: any = {}
  for (const f of TARGET_FIELDS) {
    if (body[f] !== undefined) data[f] = body[f]
  }
  if (!partial) {
    if (data.intervaloSegundos === undefined) data.intervaloSegundos = 60
    if (data.timeoutMs === undefined) data.timeoutMs = 5000
  }
  return data
}

// limit de query string: NaN/0/negativo caem no default, teto de 500
function parseLimit(q: any, def = 50) {
  return Math.min(Math.max(Number(q.limit) || def, 1), 500)
}

function computeStats(checks: { status: string; latenciaMs: number | null }[]) {
  const total = checks.length
  const up = checks.filter((c) => c.status === 'up').length
  const degraded = checks.filter((c) => c.status === 'degraded').length
  const down = checks.filter((c) => c.status === 'down').length
  const lats = checks.map((c) => c.latenciaMs).filter((n): n is number => n != null)
  const avg = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null
  return {
    total,
    up,
    degraded,
    down,
    uptimePct: total ? Math.round((up / total) * 10000) / 100 : null,
    latenciaMediaMs: avg,
  }
}

function dailyHistory(checks: { status: string; timestamp: Date }[], dias = 90) {
  const days = new Map<string, { up: number; total: number }>()
  for (const c of checks) {
    const key = c.timestamp.toISOString().slice(0, 10)
    const d = days.get(key) ?? { up: 0, total: 0 }
    d.total++
    if (c.status === 'up') d.up++
    days.set(key, d)
  }
  const out: { date: string; uptime: number | null }[] = []
  for (let i = dias - 1; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 24 * 3600_000)
    const key = dt.toISOString().slice(0, 10)
    const d = days.get(key)
    out.push({ date: key, uptime: d ? Math.round((d.up / d.total) * 10000) / 100 : null })
  }
  return out
}

export async function registerRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true }))

  // ---------- Grupos ----------
  app.get('/api/groups', async () => prisma.statusGroup.findMany({ orderBy: { ordem: 'asc' } }))

  app.post('/api/groups', async (req) => {
    const b = req.body as any
    return prisma.statusGroup.create({ data: { nome: b.nome, ordem: b.ordem ?? 0 } })
  })

  app.patch('/api/groups/:id', async (req) => {
    const { id } = req.params as any
    const b = req.body as any
    const data: any = {}
    if (b.nome !== undefined) data.nome = b.nome
    if (b.ordem !== undefined) data.ordem = b.ordem
    return prisma.statusGroup.update({ where: { id }, data })
  })

  app.delete('/api/groups/:id', async (req) => {
    const { id } = req.params as any
    await prisma.statusGroup.delete({ where: { id } })
    return { ok: true }
  })

  // ---------- Alvos ----------
  app.get('/api/targets', async () =>
    prisma.target.findMany({ include: { statusGroup: true }, orderBy: { nome: 'asc' } }))

  app.get('/api/targets/:id', async (req) => {
    const { id } = req.params as any
    return prisma.target.findUnique({ where: { id }, include: { statusGroup: true } })
  })

  app.post('/api/targets', async (req) => prisma.target.create({ data: pickTarget(req.body) }))

  app.patch('/api/targets/:id', async (req) => {
    const { id } = req.params as any
    return prisma.target.update({ where: { id }, data: pickTarget(req.body, true) })
  })

  app.delete('/api/targets/:id', async (req) => {
    const { id } = req.params as any
    await prisma.target.delete({ where: { id } })
    return { ok: true }
  })

  // Checar agora (manual)
  app.post('/api/targets/:id/check', async (req) => {
    const { id } = req.params as any
    const result = await checkTarget(id)
    return result ?? { status: 'down', mensagem: 'alvo não encontrado' }
  })

  // Histórico de checagens
  app.get('/api/targets/:id/checks', async (req) => {
    const { id } = req.params as any
    const limit = parseLimit(req.query)
    return prisma.check.findMany({
      where: { targetId: id },
      orderBy: { timestamp: 'desc' },
      take: limit,
    })
  })

  // Incidentes por alvo
  app.get('/api/targets/:id/incidents', async (req) => {
    const { id } = req.params as any
    const limit = parseLimit(req.query)
    return prisma.incident.findMany({
      where: { targetId: id },
      orderBy: { inicio: 'desc' },
      take: limit,
    })
  })

  // Estatísticas (para a equipe)
  app.get('/api/targets/:id/stats', async (req) => {
    const { id } = req.params as any
    const hours = Math.max(Number((req.query as any).hours) || 24, 1)
    const since = new Date(Date.now() - hours * 3600_000)
    const checks = await prisma.check.findMany({ where: { targetId: id, timestamp: { gte: since } } })
    return computeStats(checks)
  })

  // ---------- Página pública ----------
  app.get('/api/public/status', async () => {
    const groups = await prisma.statusGroup.findMany({ orderBy: { ordem: 'asc' } })
    const targets = await prisma.target.findMany({
      where: { publico: true, ativo: true },
      orderBy: { nome: 'asc' },
    })
    const since = new Date(Date.now() - 90 * 24 * 3600_000)
    const checks = await prisma.check.findMany({
      where: { timestamp: { gte: since } },
      select: { targetId: true, status: true, timestamp: true },
    })

    const byTarget = new Map<string, { status: string; timestamp: Date }[]>()
    for (const c of checks) {
      const arr = byTarget.get(c.targetId) ?? []
      arr.push({ status: c.status, timestamp: c.timestamp })
      byTarget.set(c.targetId, arr)
    }

    const view = (t: (typeof targets)[number]) => {
      const cs = byTarget.get(t.id) ?? []
      const up = cs.filter((c) => c.status === 'up').length
      return {
        id: t.id,
        nome: t.nome,
        status: t.lastStatus ?? 'unknown',
        uptime90d: cs.length ? Math.round((up / cs.length) * 10000) / 100 : null,
        history: dailyHistory(cs),
      }
    }

    const grouped = groups.map((g) => ({
      id: g.id,
      nome: g.nome,
      services: targets.filter((t) => t.statusGroupId === g.id).map(view),
    }))
    const ungrouped = targets.filter((t) => !t.statusGroupId).map(view)
    const overall = targets.every((t) => (t.lastStatus ?? 'up') === 'up') ? 'operational' : 'incident'

    return { overall, groups: grouped, ungrouped }
  })
}
