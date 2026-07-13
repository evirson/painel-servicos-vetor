import { prisma } from './src/index'

async function main() {
  const fiscal = await prisma.statusGroup.create({ data: { nome: 'Fiscal', ordem: 0 } })
  const interno = await prisma.statusGroup.create({ data: { nome: 'Interno', ordem: 1 } })
  const ecommerce = await prisma.statusGroup.create({ data: { nome: 'E-commerce', ordem: 2 } })

  await prisma.target.create({
    data: {
      nome: 'SEFAZ NFe (PR) — status serviço',
      tipo: 'sefaz',
      url: 'https://nfe.sefa.pr.gov.br/nfe/NFeStatusServico4',
      config: { uf: 'PR', ambiente: 'producao' },
      intervaloSegundos: 300,
      timeoutMs: 15000,
      statusGroupId: fiscal.id,
    },
  })

  await prisma.target.create({
    data: {
      nome: 'Firebird (exemplo)',
      tipo: 'firebird',
      host: '127.0.0.1',
      porta: 3050,
      intervaloSegundos: 60,
      publico: false,
      statusGroupId: interno.id,
    },
  })

  await prisma.target.create({
    data: {
      nome: 'API exemplo (httpbin)',
      tipo: 'http_api',
      url: 'https://httpbin.org/status/200',
      intervaloSegundos: 60,
      statusGroupId: ecommerce.id,
    },
  })

  console.log('Seed concluído.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
