import type { ProbeResult, ProbeTarget } from './types'
import { tcpProbe } from './tcp'
import { httpProbe } from './http'
import { sefazProbe } from './sefaz'
import { pingProbe } from './ping'
import { tlsCertProbe } from './tls-cert'

export * from './types'
export { tcpProbe, httpProbe, sefazProbe, pingProbe, tlsCertProbe }

/**
 * Despacha para a sonda correta conforme o tipo do alvo.
 * Para adicionar um novo tipo de serviço monitorável:
 *   1. adicione o valor no enum ProbeType (schema.prisma)
 *   2. escreva a sonda em packages/probes/src/<tipo>.ts
 *   3. mapeie o novo tipo aqui
 */
export async function runProbe(t: ProbeTarget): Promise<ProbeResult> {
  switch (t.tipo) {
    case 'db_port':
    case 'firebird':
    case 'asta':
      return tcpProbe(t)
    case 'http_api':
      return httpProbe(t)
    case 'sefaz':
      return sefazProbe(t)
    case 'ping':
      return pingProbe(t)
    case 'tls_cert':
      return tlsCertProbe(t)
    default:
      return { status: 'down', mensagem: `tipo desconhecido: ${t.tipo}` }
  }
}
