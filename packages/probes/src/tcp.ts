import net from 'node:net'
import type { ProbeResult, ProbeTarget } from './types'

/**
 * Sonda TCP: abre um socket em host:porta. Cobre db_port, firebird e asta.
 * "up" = a porta aceitou a conexão (o serviço está de pé).
 */
export async function tcpProbe(t: ProbeTarget): Promise<ProbeResult> {
  if (!t.host || !t.porta) {
    return { status: 'down', mensagem: 'host/porta não configurados' }
  }
  const host = t.host
  const porta = t.porta
  const start = Date.now()

  return await new Promise<ProbeResult>((resolve) => {
    const socket = new net.Socket()
    let done = false
    const finish = (r: ProbeResult) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(r)
    }

    socket.setTimeout(t.timeoutMs)
    socket.once('connect', () => finish({ status: 'up', latenciaMs: Date.now() - start }))
    socket.once('timeout', () => finish({ status: 'down', mensagem: `timeout após ${t.timeoutMs}ms` }))
    socket.once('error', (err) => finish({ status: 'down', mensagem: err.message }))
    socket.connect(porta, host)
  })
}
