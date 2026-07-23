import { prisma } from './src/index'

/**
 * Seed idempotente: pode rodar quantas vezes quiser sem duplicar nada.
 * Popula os grupos da página pública e os alvos de infraestrutura do VPS.
 *
 * Os serviços de cada projeto NÃO entram aqui — cadastre o projeto em
 * /admin/projetos e clique em "Gerar alvos".
 */

// O VPS onde ficam os containers/nginx dos projetos.
const VPS_IP = process.env.SEED_VPS_IP || '77.37.41.177'

async function grupo(nome: string, ordem: number) {
  const existente = await prisma.statusGroup.findFirst({ where: { nome } })
  if (existente) return existente
  return prisma.statusGroup.create({ data: { nome, ordem } })
}

/** Cria o alvo só se ainda não houver um com o mesmo nome. */
async function alvo(nome: string, data: any) {
  const existente = await prisma.target.findFirst({ where: { nome } })
  if (existente) return existente
  return prisma.target.create({ data: { nome, ...data } })
}

async function main() {
  const infra = await grupo('Infraestrutura', 0)
  const fiscal = await grupo('Fiscal', 1)

  // ---- Infraestrutura do VPS ----
  // Tudo publico:false: o cliente não precisa (nem deve) ver IP e porta.
  // ping separado do TCP de propósito: ping up + 443 down = nginx quebrado;
  // ambos down = o servidor caiu.
  await alvo(`VPS ${VPS_IP} — host (ping)`, {
    tipo: 'ping',
    host: VPS_IP,
    config: { pacotes: 3, degradedMs: 300 },
    intervaloSegundos: 60,
    timeoutMs: 5000,
    publico: false,
    statusGroupId: infra.id,
  })

  const portas: [number, string][] = [
    [443, 'HTTPS (nginx)'],
    [80, 'HTTP (nginx)'],
    [22, 'SSH'],
  ]
  for (const [porta, rotulo] of portas) {
    await alvo(`VPS ${VPS_IP} — ${rotulo}`, {
      tipo: 'db_port', // sonda TCP genérica
      host: VPS_IP,
      porta,
      intervaloSegundos: 60,
      timeoutMs: 5000,
      publico: false,
      statusGroupId: infra.id,
    })
  }

  // ---- Fiscal ----
  await alvo('SEFAZ NFe (PR) — status serviço', {
    tipo: 'sefaz',
    url: 'https://nfe.sefa.pr.gov.br/nfe/NFeStatusServico4',
    config: { uf: 'PR', ambiente: 'producao' },
    intervaloSegundos: 300,
    timeoutMs: 15000,
    statusGroupId: fiscal.id,
  })

  const total = await prisma.target.count()
  console.log(`Seed concluído. ${total} alvo(s) cadastrado(s).`)
  console.log('Próximo passo: cadastre os projetos em /admin/projetos e clique em "Gerar alvos".')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
