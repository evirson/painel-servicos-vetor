import type { FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import bcrypt from 'bcryptjs'
import { prisma } from '@vetor/db'
import { bloqueioRestante, registrarFalha, limparFalhas, chaves } from './rate-limit'

// Rotas liberadas sem token.
const PUBLIC_PATHS = new Set(['/health', '/api/auth/login'])

const DEV_SECRET = 'dev-secret-troque-em-producao'

export async function registerAuth(app: FastifyInstance) {
  const secret = process.env.AUTH_SECRET || DEV_SECRET
  if (secret === DEV_SECRET) {
    app.log.warn('AUTH_SECRET não definido — usando segredo de desenvolvimento. Defina-o em produção!')
  }
  await app.register(jwt, { secret })

  // Protege tudo em /api, exceto rotas públicas e a página pública do cliente.
  app.addHook('onRequest', async (req, reply) => {
    const url = (req.raw.url || '').split('?')[0]
    if (PUBLIC_PATHS.has(url)) return
    if (url.startsWith('/api/public/')) return
    // Ingestão do agente tem autenticação própria (token do Host, verificado em
    // ingest.ts) — não usa o JWT do admin.
    if (url.startsWith('/api/ingest/')) return
    if (!url.startsWith('/api/')) return
    try {
      await req.jwtVerify()
    } catch {
      reply.code(401).send({ error: 'não autenticado' })
    }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as any
    if (!email || !password) return reply.code(400).send({ error: 'informe e-mail e senha' })

    // Atrás do nginx, req.ip é o IP do proxy: usa o X-Forwarded-For quando houver.
    const ip = (String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.ip
    const chavesDaTentativa = chaves(ip, email)

    const espera = Math.max(...chavesDaTentativa.map(bloqueioRestante))
    if (espera > 0) {
      app.log.warn(`[login] bloqueado por excesso de tentativas: ${email} de ${ip}`)
      return reply
        .code(429)
        .header('Retry-After', String(espera))
        .send({ error: `muitas tentativas — tente de novo em ${Math.ceil(espera / 60)} min` })
    }

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user || !bcrypt.compareSync(password, user.senhaHash)) {
      chavesDaTentativa.forEach(registrarFalha)
      app.log.warn(`[login] falha de autenticação: ${email} de ${ip}`)
      return reply.code(401).send({ error: 'credenciais inválidas' })
    }
    chavesDaTentativa.forEach(limparFalhas)
    const token = app.jwt.sign(
      { sub: user.id, email: user.email, papel: user.papel },
      { expiresIn: '12h' },
    )
    return { token, user: { email: user.email, papel: user.papel } }
  })

  app.get('/api/auth/me', async (req) => ({ user: req.user }))
}

/**
 * Se ADMIN_EMAIL e ADMIN_PASSWORD estiverem definidos, garante que esse admin exista
 * (cria ou atualiza a senha) no boot. Conveniente para o primeiro acesso via Docker.
 */
export async function ensureSeedAdmin(app: FastifyInstance) {
  const email = process.env.ADMIN_EMAIL
  const senha = process.env.ADMIN_PASSWORD
  if (!email || !senha) return
  try {
    const senhaHash = bcrypt.hashSync(senha, 10)
    await prisma.user.upsert({ where: { email }, update: { senhaHash }, create: { email, senhaHash } })
    app.log.info(`Admin garantido: ${email}`)
  } catch (err) {
    app.log.error({ err }, 'falha ao garantir admin inicial')
  }
}
