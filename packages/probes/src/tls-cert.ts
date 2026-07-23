import tls from 'node:tls'
import net from 'node:net'
import { URL } from 'node:url'
import type { ProbeResult, ProbeTarget } from './types'

/**
 * Sonda de certificado TLS: quantos dias faltam para expirar e a cadeia é válida?
 *
 * Com um nginx servindo muitos domínios, certificado vencido é uma das quebras
 * mais comuns — e a única 100% previsível. Esta sonda avisa ANTES de quebrar.
 *
 * Conecta com rejectUnauthorized:false de propósito: assim conseguimos LER um
 * certificado expirado/inválido e reportar o motivo exato, em vez de receber um
 * erro opaco de handshake. A validação é feita por nós, olhando `authorized`.
 *
 * config: { avisoDias, servername }
 * Aceita url (https://dominio) ou host+porta.
 */
export async function tlsCertProbe(t: ProbeTarget): Promise<ProbeResult> {
  const cfg = t.config ?? {}
  const avisoDias: number = Number(cfg.avisoDias) || 14

  let host = t.host ?? undefined
  let porta = t.porta ?? 443
  if (t.url) {
    try {
      const u = new URL(t.url)
      host = u.hostname
      porta = u.port ? Number(u.port) : 443
    } catch {
      return { status: 'down', mensagem: `URL inválida: ${t.url}` }
    }
  }
  if (!host) return { status: 'down', mensagem: 'host/url não configurados' }

  // SNI: sem isso o nginx devolve o certificado do primeiro server block.
  // O TLS proíbe SNI com IP literal (Node lança de forma SÍNCRONA), então nesse
  // caso conectamos sem servername — e o que voltar é o certificado default.
  const alvoSni = cfg.servername || host
  const servername = net.isIP(alvoSni) ? undefined : alvoSni
  const start = Date.now()

  return await new Promise<ProbeResult>((resolve) => {
    let done = false
    let socket: tls.TLSSocket
    const finish = (r: ProbeResult) => {
      if (done) return
      done = true
      socket?.destroy()
      resolve(r)
    }

    try {
      socket = tls.connect(
        { host, port: porta, servername, rejectUnauthorized: false, timeout: t.timeoutMs },
        () => {
        const latenciaMs = Date.now() - start
        const cert = socket.getPeerCertificate()

        if (!cert || !cert.valid_to) {
          return finish({ status: 'down', latenciaMs, mensagem: 'servidor não apresentou certificado' })
        }

        const expiraEm = new Date(cert.valid_to)
        if (Number.isNaN(expiraEm.getTime())) {
          return finish({ status: 'down', latenciaMs, mensagem: `validade ilegível: ${cert.valid_to}` })
        }

        const dias = Math.floor((expiraEm.getTime() - Date.now()) / 86_400_000)
        const emissor = cert.issuer?.O || cert.issuer?.CN || 'emissor desconhecido'
        const venc = expiraEm.toISOString().slice(0, 10)

        if (dias < 0) {
          return finish({ status: 'down', latenciaMs, mensagem: `certificado EXPIRADO em ${venc} (${-dias}d atrás)` })
        }
        const erroCadeia = String(socket.authorizationError ?? '')

        // Conexão por IP não manda SNI, então o nginx devolve o certificado
        // default e o nome nunca bate. Isso é esperado, não é uma quebra real:
        // reporta degraded pedindo o domínio, em vez de pintar de vermelho.
        if (!socket.authorized && !servername && erroCadeia === 'ERR_TLS_CERT_ALTNAME_INVALID') {
          return finish({
            status: 'degraded',
            latenciaMs,
            mensagem: `cadastre o domínio em vez do IP para validar o certificado certo ` +
              `(o default expira em ${dias}d, ${venc})`,
          })
        }

        // authorized=false com certificado no prazo = cadeia incompleta, CA
        // desconhecida ou nome que não confere. Quebra o navegador do cliente.
        if (!socket.authorized) {
          return finish({
            status: 'down',
            latenciaMs,
            mensagem: `cadeia inválida: ${erroCadeia || 'motivo desconhecido'}`,
          })
        }
        if (dias <= avisoDias) {
          return finish({ status: 'degraded', latenciaMs, mensagem: `expira em ${dias}d (${venc}) — renovar` })
        }
        return finish({ status: 'up', latenciaMs, mensagem: `${dias}d restantes (${venc}, ${emissor})` })
        },
      )

      socket.once('timeout', () => finish({ status: 'down', mensagem: `timeout após ${t.timeoutMs}ms` }))
      socket.once('error', (err: any) => finish({ status: 'down', mensagem: String(err?.message ?? err) }))
    } catch (err: any) {
      // tls.connect valida as opções de forma síncrona — sem este catch, uma
      // configuração inválida derrubaria o worker inteiro em vez do alvo.
      finish({ status: 'down', mensagem: `conexão TLS inválida: ${String(err?.message ?? err)}` })
    }
  })
}
