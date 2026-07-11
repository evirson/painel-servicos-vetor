import type { ProbeResult, ProbeTarget } from './types'
import { httpProbe } from './http'

/**
 * Sonda SEFAZ (status serviço).
 *
 * Versão do esqueleto: apenas verifica se o web service da SEFAZ está acessível
 * (requisição HTTP ao endpoint configurado).
 *
 * TODO (Fase 5): enviar o envelope SOAP do NfeStatusServico (por UF/ambiente) e
 * interpretar o cStat de retorno — 107 = "Serviço em Operação". Pode exigir
 * certificado digital A1 dependendo da UF.
 */
export async function sefazProbe(t: ProbeTarget): Promise<ProbeResult> {
  return httpProbe({
    ...t,
    tipo: 'http_api',
    config: { method: 'GET', expectedStatus: t.config?.expectedStatus ?? 200 },
  })
}
