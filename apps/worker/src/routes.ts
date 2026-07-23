import type { FastifyInstance } from 'fastify'
import { prisma } from '@vetor/db'
import { checkTarget } from './runner'
import { cofreDisponivel, motivoIndisponivel, encrypt, decrypt, mascara } from './secrets'
import { diaUTC } from './rollup'
import { autenticarHost, processarRelato } from './ingest'
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'

const DIAS_HISTORICO = 90

const TARGET_FIELDS = [
  'nome', 'tipo', 'host', 'porta', 'url', 'config',
  'intervaloSegundos', 'timeoutMs', 'ativo', 'publico', 'statusGroupId', 'projetoId',
] as const

const PROJETO_FIELDS = [
  'nome', 'descricao', 'urlFront', 'urlApi', 'host', 'statusGroupId', 'ativo', 'ordem',
] as const

function pickProjeto(body: any, partial = false) {
  const data: any = {}
  for (const f of PROJETO_FIELDS) {
    if (body?.[f] !== undefined) data[f] = body[f]
  }
  // Strings vazias viram null para não gravar "" em FK/URL opcionais.
  for (const f of ['statusGroupId', 'urlFront', 'urlApi', 'host', 'descricao'] as const) {
    if (data[f] === '') data[f] = null
  }
  if (!partial && data.ordem === undefined) data.ordem = 0
  return data
}

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
    prisma.target.findMany({ include: { statusGroup: true, projeto: true }, orderBy: { nome: 'asc' } }))

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

  // ---------- Projetos ----------
  app.get('/api/projetos', async () =>
    prisma.projeto.findMany({
      orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
      include: {
        statusGroup: true,
        _count: { select: { targets: true, credenciais: true } },
      },
    }),
  )

  app.post('/api/projetos', async (req) => prisma.projeto.create({ data: pickProjeto(req.body) }))

  app.patch('/api/projetos/:id', async (req) => {
    const { id } = req.params as any
    return prisma.projeto.update({ where: { id }, data: pickProjeto(req.body, true) })
  })

  app.delete('/api/projetos/:id', async (req, reply) => {
    const { id } = req.params as any
    await prisma.projeto.delete({ where: { id } })
    return reply.code(204).send()
  })

  /**
   * Deriva os alvos monitorados a partir das URLs cadastradas no projeto.
   * Para cada URL: um http_api (o que o cliente vê) e um tls_cert (interno).
   * Idempotente — rodar de novo não duplica, só cria o que faltar.
   */
  app.post('/api/projetos/:id/gerar-alvos', async (req, reply) => {
    const { id } = req.params as any
    const projeto = await prisma.projeto.findUnique({ where: { id } })
    if (!projeto) return reply.code(404).send({ error: 'projeto não encontrado' })

    const fontes = [
      { url: projeto.urlFront, rotulo: 'Front' },
      { url: projeto.urlApi, rotulo: 'API' },
    ].filter((f): f is { url: string; rotulo: string } => Boolean(f.url))

    if (!fontes.length) {
      return reply.code(400).send({ error: 'cadastre urlFront e/ou urlApi antes de gerar alvos' })
    }

    const criados: string[] = []
    for (const { url, rotulo } of fontes) {
      // Só faz sentido checar certificado de URL https.
      const ehHttps = url.trim().toLowerCase().startsWith('https://')
      const planos: { tipo: 'http_api' | 'tls_cert'; nome: string; publico: boolean; config: any }[] = [
        {
          tipo: 'http_api',
          nome: fontes.length > 1 ? `${projeto.nome} — ${rotulo}` : projeto.nome,
          publico: true,
          config: { expectedStatus: 200, degradedMs: 3000 },
        },
      ]
      if (ehHttps) {
        planos.push({
          tipo: 'tls_cert',
          nome: `Certificado — ${projeto.nome}${fontes.length > 1 ? ` (${rotulo})` : ''}`,
          publico: false,
          config: { avisoDias: 14 },
        })
      }

      for (const p of planos) {
        const existente = await prisma.target.findFirst({
          where: { projetoId: projeto.id, tipo: p.tipo, url },
        })
        if (existente) continue
        await prisma.target.create({
          data: {
            nome: p.nome,
            tipo: p.tipo,
            url,
            config: p.config,
            publico: p.publico,
            projetoId: projeto.id,
            statusGroupId: projeto.statusGroupId,
            // Certificado muda devagar: checar a cada hora basta e evita ruído.
            intervaloSegundos: p.tipo === 'tls_cert' ? 3600 : 60,
            timeoutMs: 10000,
          },
        })
        criados.push(p.nome)
      }
    }
    return { criados, total: criados.length }
  })

  // ---------- Cofre de credenciais ----------
  // Guarda de disponibilidade: sem SECRETS_KEY o cofre falha fechado, para
  // nunca haver a chance de gravar um segredo em texto puro.
  const exigirCofre = (reply: any) => {
    if (cofreDisponivel()) return false
    reply.code(503).send({ error: motivoIndisponivel() })
    return true
  }

  // Nunca devolve o segredo — só metadados e a máscara.
  const viewCredencial = (c: any) => ({
    id: c.id,
    nome: c.nome,
    tipo: c.tipo,
    usuario: c.usuario,
    host: c.host,
    notas: c.notas,
    projetoId: c.projetoId,
    projeto: c.projeto ? { id: c.projeto.id, nome: c.projeto.nome } : null,
    segredo: mascara(),
    updatedAt: c.updatedAt,
  })

  app.get('/api/credenciais', async (req, reply) => {
    if (exigirCofre(reply)) return
    const { projetoId } = req.query as any
    const cs = await prisma.credencial.findMany({
      where: projetoId ? { projetoId } : undefined,
      orderBy: { nome: 'asc' },
      include: { projeto: true },
    })
    return cs.map(viewCredencial)
  })

  app.post('/api/credenciais', async (req, reply) => {
    if (exigirCofre(reply)) return
    const b = (req.body ?? {}) as any
    if (!b.nome || !b.segredo) return reply.code(400).send({ error: 'informe nome e segredo' })
    const c = await prisma.credencial.create({
      data: {
        nome: b.nome,
        tipo: b.tipo ?? 'senha',
        usuario: b.usuario ?? null,
        host: b.host ?? null,
        notas: b.notas ?? null,
        projetoId: b.projetoId || null,
        segredo: encrypt(String(b.segredo)),
      },
      include: { projeto: true },
    })
    return viewCredencial(c)
  })

  app.patch('/api/credenciais/:id', async (req, reply) => {
    if (exigirCofre(reply)) return
    const { id } = req.params as any
    const b = (req.body ?? {}) as any
    const data: any = {}
    for (const f of ['nome', 'tipo', 'usuario', 'host', 'notas'] as const) {
      if (b[f] !== undefined) data[f] = b[f]
    }
    if (b.projetoId !== undefined) data.projetoId = b.projetoId || null
    // Segredo vazio significa "não mexer" — evita apagar por engano ao editar
    // outros campos num formulário que não recarrega o valor.
    if (b.segredo) data.segredo = encrypt(String(b.segredo))
    const c = await prisma.credencial.update({ where: { id }, data, include: { projeto: true } })
    return viewCredencial(c)
  })

  app.delete('/api/credenciais/:id', async (req, reply) => {
    if (exigirCofre(reply)) return
    const { id } = req.params as any
    await prisma.credencial.delete({ where: { id } })
    return reply.code(204).send()
  })

  /**
   * Única rota que devolve o texto puro. É POST (não GET) de propósito:
   * não entra em histórico de navegador nem em log de proxy como URL.
   */
  app.post('/api/credenciais/:id/revelar', async (req, reply) => {
    if (exigirCofre(reply)) return
    const { id } = req.params as any
    const c = await prisma.credencial.findUnique({ where: { id } })
    if (!c) return reply.code(404).send({ error: 'credencial não encontrada' })
    try {
      const valor = decrypt(c.segredo)
      const quem = (req.user as any)?.email ?? 'desconhecido'
      app.log.warn(`[cofre] credencial "${c.nome}" (${c.id}) revelada por ${quem}`)
      return { id: c.id, nome: c.nome, segredo: valor }
    } catch (err: any) {
      return reply.code(500).send({ error: String(err?.message ?? err) })
    }
  })

  // ---------- Servidores com agente ----------
  app.get('/api/hosts', async () => {
    const hosts = await prisma.host.findMany({
      orderBy: { nome: 'asc' },
      include: { _count: { select: { targets: true } } },
    })
    // tokenHash nunca sai da API.
    return hosts.map(({ tokenHash, ...h }) => h)
  })

  /**
   * Cria o servidor e devolve o token do agente **uma única vez** — só o hash
   * fica no banco. Se perder, gere outro: não há como recuperar o original.
   */
  app.post('/api/hosts', async (req, reply) => {
    const b = (req.body ?? {}) as any
    if (!b.nome) return reply.code(400).send({ error: 'informe o nome do servidor' })
    const token = randomBytes(32).toString('base64url')
    const host = await prisma.host.create({
      data: { nome: b.nome, ip: b.ip || null, tokenHash: bcrypt.hashSync(token, 10) },
    })
    const { tokenHash, ...semHash } = host
    return { ...semHash, token, aviso: 'guarde este token agora — ele não será mostrado de novo' }
  })

  /** Gera um token novo, invalidando o anterior. */
  app.post('/api/hosts/:id/rotacionar-token', async (req, reply) => {
    const { id } = req.params as any
    const existe = await prisma.host.findUnique({ where: { id } })
    if (!existe) return reply.code(404).send({ error: 'servidor não encontrado' })
    const token = randomBytes(32).toString('base64url')
    await prisma.host.update({ where: { id }, data: { tokenHash: bcrypt.hashSync(token, 10) } })
    return { id, token, aviso: 'o token anterior deixou de valer' }
  })

  app.delete('/api/hosts/:id', async (req, reply) => {
    const { id } = req.params as any
    await prisma.host.delete({ where: { id } })
    return reply.code(204).send()
  })

  // ---------- Ingestão do agente (token do Host, não JWT) ----------
  app.post('/api/ingest/agent', async (req, reply) => {
    const host = await autenticarHost(req.headers.authorization)
    if (!host) return reply.code(401).send({ error: 'token de agente inválido' })
    try {
      const { itens } = await processarRelato(host.id, (req.body ?? {}) as any)
      return { ok: true, host: host.nome, itens }
    } catch (err: any) {
      app.log.error({ err }, '[ingest] falha ao processar relato')
      return reply.code(500).send({ error: String(err?.message ?? err) })
    }
  })

  // ---------- Página pública ----------
  app.get('/api/public/status', async () => {
    const groups = await prisma.statusGroup.findMany({ orderBy: { ordem: 'asc' } })
    const targets = await prisma.target.findMany({
      where: { publico: true, ativo: true },
      orderBy: { nome: 'asc' },
    })
    const ids = targets.map((t) => t.id)
    const hoje = diaUTC(new Date())
    const desde = new Date(hoje.getTime() - (DIAS_HISTORICO - 1) * 86_400_000)

    // Histórico vem do resumo diário (90 linhas por alvo), e só o dia corrente —
    // ainda não consolidado — vem do bruto. Antes isto carregava TODOS os checks
    // de 90 dias de TODOS os alvos, o que matava o worker por falta de memória.
    const [diarios, hojeAgrupado] = await Promise.all([
      ids.length
        ? prisma.checkDaily.findMany({
            where: { targetId: { in: ids }, dia: { gte: desde } },
            orderBy: { dia: 'asc' },
          })
        : [],
      ids.length
        ? prisma.check.groupBy({
            by: ['targetId', 'status'],
            where: { targetId: { in: ids }, timestamp: { gte: hoje } },
            _count: { _all: true },
          })
        : [],
    ])

    type Dia = { up: number; total: number }
    const porAlvo = new Map<string, Map<string, Dia>>()
    const put = (targetId: string, chave: string, up: number, total: number) => {
      const m = porAlvo.get(targetId) ?? new Map<string, Dia>()
      const d = m.get(chave) ?? { up: 0, total: 0 }
      d.up += up
      d.total += total
      m.set(chave, d)
      porAlvo.set(targetId, m)
    }

    for (const r of diarios) put(r.targetId, r.dia.toISOString().slice(0, 10), r.up, r.total)

    // O dia corrente também aparece no resumo (o rollup roda de hora em hora),
    // mas ali está desatualizado. O bruto é a fonte para hoje: descarta o
    // resumo do dia antes de somar, senão as checagens contariam duas vezes.
    const chaveHoje = hoje.toISOString().slice(0, 10)
    for (const m of porAlvo.values()) m.delete(chaveHoje)
    for (const g of hojeAgrupado) {
      put(g.targetId, chaveHoje, g.status === 'up' ? g._count._all : 0, g._count._all)
    }

    const view = (t: (typeof targets)[number]) => {
      const m = porAlvo.get(t.id) ?? new Map<string, Dia>()
      let up = 0
      let total = 0
      const history: { date: string; uptime: number | null }[] = []
      for (let i = DIAS_HISTORICO - 1; i >= 0; i--) {
        const chave = new Date(hoje.getTime() - i * 86_400_000).toISOString().slice(0, 10)
        const d = m.get(chave)
        history.push({ date: chave, uptime: d?.total ? Math.round((d.up / d.total) * 10000) / 100 : null })
        up += d?.up ?? 0
        total += d?.total ?? 0
      }
      return {
        id: t.id,
        nome: t.nome,
        status: t.lastStatus ?? 'unknown',
        uptime90d: total ? Math.round((up / total) * 10000) / 100 : null,
        history,
      }
    }

    // Grupos sem nenhum serviço público são omitidos: um grupo cujos alvos são
    // todos internos (ex.: "Infraestrutura") apareceria vazio para o cliente,
    // expondo o nome do grupo e dando impressão de tela quebrada.
    const grouped = groups
      .map((g) => ({
        id: g.id,
        nome: g.nome,
        services: targets.filter((t) => t.statusGroupId === g.id).map(view),
      }))
      .filter((g) => g.services.length > 0)
    const ungrouped = targets.filter((t) => !t.statusGroupId).map(view)

    // Três estados, não dois: "degradado" não é queda. Tratar instabilidade como
    // incidente deixaria o banner vermelho de forma permanente (basta um alvo
    // lento ou mal configurado), e um painel sempre vermelho não informa nada.
    const estados = targets.map((t) => t.lastStatus ?? 'up')
    const overall = estados.includes('down')
      ? 'incident'
      : estados.includes('degraded')
        ? 'degraded'
        : 'operational'

    return { overall, groups: grouped, ungrouped }
  })
}
