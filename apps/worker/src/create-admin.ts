import bcrypt from 'bcryptjs'
import { prisma } from '@vetor/db'

// Uso:
//   ADMIN_EMAIL=admin@vetor.com ADMIN_PASSWORD=senha npm --workspace @vetor/worker run create-admin
//   ou: npm --workspace @vetor/worker run create-admin admin@vetor.com senha
const email = process.env.ADMIN_EMAIL || process.argv[2]
const senha = process.env.ADMIN_PASSWORD || process.argv[3]

if (!email || !senha) {
  console.error('Informe e-mail e senha (via ADMIN_EMAIL/ADMIN_PASSWORD ou argumentos).')
  process.exit(1)
}

const senhaHash = bcrypt.hashSync(senha, 10)
await prisma.user.upsert({ where: { email }, update: { senhaHash }, create: { email, senhaHash } })
console.log('Admin criado/atualizado:', email)
await prisma.$disconnect()
