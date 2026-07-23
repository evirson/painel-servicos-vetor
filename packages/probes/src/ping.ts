import { execFile } from 'node:child_process'
import type { ProbeResult, ProbeTarget } from './types'

/**
 * Sonda ICMP: o host responde a ping?
 *
 * Complementa a sonda TCP em vez de substituí-la — é a diferença entre
 * "o servidor caiu" e "o servidor está de pé, mas o serviço morreu":
 *   ping up   + porta down -> nginx/serviço quebrado
 *   ping down + porta down -> host fora do ar (ou rota/firewall)
 *
 * Usa o binário `ping` do sistema (pacote iputils-ping na imagem do worker),
 * evitando socket raw — que exigiria rodar o container como root/CAP_NET_RAW.
 *
 * config: { pacotes, degradedMs }
 */

// RTT do resumo do ping: "rtt min/avg/max/mdev = 18.027/22.105/26.302/3.379 ms"
// (no macOS/BSD o rótulo é "round-trip"). Pegamos a média.
const RTT_RE = /=\s*[\d.]+\/([\d.]+)\//
// Fallback: "time=22.1 ms" de uma linha de resposta individual.
const TIME_RE = /time[=<]\s*([\d.]+)\s*ms/i
const PERDA_RE = /([\d.]+)%\s*packet loss/i

/**
 * Alguns ambientes (notadamente o Docker Desktop no macOS/Windows, que usa uma
 * pilha de rede em espaço de usuário) RESPONDEM ao ICMP em vez de encaminhá-lo.
 * Ali qualquer endereço "responde" e a sonda daria `up` para tudo — falso verde,
 * o pior defeito possível num painel de status.
 *
 * Detectamos isso pingando 192.0.2.1, que é TEST-NET-1 (RFC 5737) e por
 * definição não é roteável na internet: se ele responder, o ICMP é emulado.
 * O resultado é medido uma vez e reaproveitado.
 */
let deteccao: Promise<boolean> | null = null

function icmpEmulado(): Promise<boolean> {
  if (deteccao) return deteccao
  deteccao = new Promise<boolean>((resolve) => {
    execFile('ping', ['-c', '1', '-W', '2', '192.0.2.1'], { timeout: 5000, encoding: 'utf8' }, (_e, stdout, stderr) => {
      const perda = Number(PERDA_RE.exec(`${stdout}${stderr}`)?.[1] ?? '100')
      resolve(perda < 100)
    })
  })
  return deteccao
}

export async function pingProbe(t: ProbeTarget): Promise<ProbeResult> {
  const host = t.host || t.url
  if (!host) return { status: 'down', mensagem: 'host não configurado' }

  if (await icmpEmulado()) {
    return {
      status: 'degraded',
      mensagem:
        'ICMP emulado por este ambiente (Docker Desktop?) — o ping responderia "up" ' +
        'para qualquer endereço. Use a sonda TCP aqui; em host Linux o ping funciona.',
    }
  }

  const cfg = t.config ?? {}
  const pacotes = Math.min(Math.max(Number(cfg.pacotes) || 3, 1), 10)
  const degradedMs: number | undefined = cfg.degradedMs
  // -W é por-resposta e em segundos no iputils (Linux); mínimo de 1s.
  const esperaSeg = Math.max(1, Math.ceil(t.timeoutMs / 1000))

  const args = ['-c', String(pacotes), '-W', String(esperaSeg), host]

  return await new Promise<ProbeResult>((resolve) => {
    execFile(
      'ping',
      args,
      // Teto absoluto: o ping pode ignorar -W em alguns cenários de DNS.
      { timeout: t.timeoutMs * pacotes + 2000, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const saida = `${stdout}${stderr}`

        if (!saida.trim()) {
          // Binário ausente é erro de configuração nossa, não queda do host.
          const msg = String((err as any)?.message ?? 'sem saída do ping')
          const semBinario = /ENOENT|not found/i.test(msg)
          return resolve({
            status: semBinario ? 'degraded' : 'down',
            mensagem: semBinario ? 'binário `ping` indisponível no container' : msg,
          })
        }

        const perda = Number(PERDA_RE.exec(saida)?.[1] ?? '100')
        if (perda >= 100) {
          return resolve({ status: 'down', mensagem: `100% de perda (${pacotes} pacotes)` })
        }

        const rtt = Number(RTT_RE.exec(saida)?.[1] ?? TIME_RE.exec(saida)?.[1])
        const latenciaMs = Number.isFinite(rtt) ? Math.round(rtt) : undefined

        // Perda parcial já indica problema de rede mesmo com o host respondendo.
        if (perda > 0) {
          return resolve({ status: 'degraded', latenciaMs, mensagem: `${perda}% de perda de pacotes` })
        }
        if (degradedMs && latenciaMs != null && latenciaMs > degradedMs) {
          return resolve({ status: 'degraded', latenciaMs, mensagem: `lento (${latenciaMs}ms > ${degradedMs}ms)` })
        }
        return resolve({ status: 'up', latenciaMs })
      },
    )
  })
}
