import Fastify from 'fastify'
import cors from '@fastify/cors'
import { registerAuth, ensureSeedAdmin } from './auth'
import { registerRoutes } from './routes'
import { startScheduler } from './scheduler'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })
await registerAuth(app)
await registerRoutes(app)
await ensureSeedAdmin(app)

const port = Number(process.env.PORT ?? 4000)
await app.listen({ port, host: '0.0.0.0' })

startScheduler()
app.log.info('Agendador de checagens iniciado.')
