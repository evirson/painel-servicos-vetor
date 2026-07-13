import https from 'node:https'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import type { ProbeResult, ProbeTarget } from './types'

/**
 * Sonda SEFAZ — NfeStatusServico4.
 *
 * Monta o envelope SOAP de consulta de status do serviço, envia ao web service
 * da UF e interpreta o cStat de retorno:
 *   107 = Serviço em Operação          -> up
 *   108 = Paralisado Temporariamente   -> down
 *   109 = Paralisado sem Previsão       -> down
 *   demais                             -> degraded (com cStat + xMotivo)
 *
 * config esperado no Target:
 *   uf            sigla da UF (ex.: "SP")            [obrigatório se não vier cUF]
 *   cUF           código IBGE (ex.: "35")           [opcional; derivado da uf]
 *   ambiente      "producao" | "homologacao"        [default: producao]
 *   soapVersion   "1.2" | "1.1"                      [default: 1.2]
 *   certPath      caminho do certificado A1 (.pfx)   [ou env NFE_CERT_PFX_PATH]
 *   certPassphrase senha do .pfx                     [ou env NFE_CERT_PASS]
 *   rejectUnauthorized  valida cadeia TLS            [default: true]
 * url = endpoint do NfeStatusServico da UF/autorizador.
 */

// Código IBGE (cUF) por sigla de UF.
export const CUF: Record<string, string> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17',
  MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35',
  PR: '41', SC: '42', RS: '43',
  MS: '50', MT: '51', GO: '52', DF: '53',
}

const WSDL_NS = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4'
const NFE_NS = 'http://www.portalfiscal.inf.br/nfe'
const SOAP_ACTION = `${WSDL_NS}/nfeStatusServicoNF`

function buildEnvelope(cUF: string, tpAmb: string, soap11: boolean): string {
  const cabec = `<nfeCabecMsg xmlns="${WSDL_NS}"><cUF>${cUF}</cUF><versaoDados>4.00</versaoDados></nfeCabecMsg>`
  const dados =
    `<nfeDadosMsg xmlns="${WSDL_NS}">` +
    `<consStatServ versao="4.00" xmlns="${NFE_NS}"><tpAmb>${tpAmb}</tpAmb><cUF>${cUF}</cUF><xServ>STATUS</xServ></consStatServ>` +
    `</nfeDadosMsg>`

  if (soap11) {
    const env = 'http://schemas.xmlsoap.org/soap/envelope/'
    return `<?xml version="1.0" encoding="utf-8"?>` +
      `<soap:Envelope xmlns:soap="${env}"><soap:Header>${cabec}</soap:Header><soap:Body>${dados}</soap:Body></soap:Envelope>`
  }
  const env = 'http://www.w3.org/2003/05/soap-envelope'
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap12:Envelope xmlns:soap12="${env}"><soap12:Header>${cabec}</soap12:Header><soap12:Body>${dados}</soap12:Body></soap12:Envelope>`
}

function postSoap(
  url: string,
  envelope: string,
  timeoutMs: number,
  cfg: any,
  soap11: boolean,
): Promise<{ status: number; body: string }> {
  const u = new URL(url)
  const headers: Record<string, string> = {
    'Content-Type': soap11
      ? 'text/xml; charset=utf-8'
      : 'application/soap+xml; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(envelope)),
  }
  if (soap11) headers['SOAPAction'] = `"${SOAP_ACTION}"`

  const options: https.RequestOptions = {
    method: 'POST',
    hostname: u.hostname,
    port: u.port || 443,
    path: u.pathname + u.search,
    headers,
    timeout: timeoutMs,
    rejectUnauthorized: cfg.rejectUnauthorized ?? true,
  }

  // Certificado cliente (A1/mTLS), se configurado.
  const pfxPath = cfg.certPath || process.env.NFE_CERT_PFX_PATH
  const pass = cfg.certPassphrase ?? process.env.NFE_CERT_PASS
  if (pfxPath) {
    options.pfx = readFileSync(pfxPath)
    if (pass) options.passphrase = pass
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('timeout', () => req.destroy(new Error(`timeout após ${timeoutMs}ms`)))
    req.on('error', reject)
    req.write(envelope)
    req.end()
  })
}

export async function sefazProbe(t: ProbeTarget): Promise<ProbeResult> {
  const cfg = t.config ?? {}
  if (!t.url) {
    return { status: 'down', mensagem: 'configure a URL do NfeStatusServico da UF' }
  }
  const uf = String(cfg.uf ?? '').toUpperCase()
  const cUF = String(cfg.cUF ?? CUF[uf] ?? '')
  if (!cUF) {
    return { status: 'down', mensagem: `UF desconhecida: "${uf}" (defina config.uf ou config.cUF)` }
  }
  const tpAmb = cfg.ambiente === 'homologacao' || cfg.tpAmb === 2 || cfg.tpAmb === '2' ? '2' : '1'
  const soap11 = cfg.soapVersion === '1.1'

  const envelope = buildEnvelope(cUF, tpAmb, soap11)
  const start = Date.now()
  try {
    const res = await postSoap(t.url, envelope, t.timeoutMs, cfg, soap11)
    const latenciaMs = Date.now() - start

    if (res.status !== 200) {
      return { status: 'down', latenciaMs, mensagem: `HTTP ${res.status} do web service` }
    }

    const cStat = /<cStat>(\d+)<\/cStat>/.exec(res.body)?.[1]
    const xMotivo = /<xMotivo>([^<]*)<\/xMotivo>/.exec(res.body)?.[1]?.trim()
    if (!cStat) {
      return { status: 'degraded', latenciaMs, mensagem: 'resposta sem cStat (SOAP fault?)' }
    }

    const msg = `cStat ${cStat}${xMotivo ? ' - ' + xMotivo : ''}`
    if (cStat === '107') return { status: 'up', latenciaMs, mensagem: msg }
    if (cStat === '108' || cStat === '109') return { status: 'down', latenciaMs, mensagem: msg }
    return { status: 'degraded', latenciaMs, mensagem: msg }
  } catch (err: any) {
    const raw = String(err?.message ?? err)
    // Handshake TLS recusado por certificado de cliente (alert 42 "bad certificate",
    // alert 46 "certificate unknown", alert 116 "certificate required"): problema de
    // configuração nossa, não queda da SEFAZ — reporta degraded para não abrir
    // incidente falso na página pública.
    if (/bad certificate|certificate unknown|certificate required|handshake failure/i.test(raw)) {
      const temCert = Boolean(cfg.certPath || process.env.NFE_CERT_PFX_PATH)
      return {
        status: 'degraded',
        mensagem: temCert
          ? `web service recusou o certificado configurado (mTLS): ${raw}`
          : 'a UF exige certificado digital A1 (mTLS) e nenhum está configurado — defina config.certPath ou NFE_CERT_PFX_PATH',
      }
    }
    return { status: 'down', mensagem: raw }
  }
}
