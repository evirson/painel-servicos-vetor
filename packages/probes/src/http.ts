import type { ProbeResult, ProbeTarget } from './types'

/**
 * Sonda HTTP: faz uma requisição e valida status, latência e (opcional) conteúdo.
 * config: { method, headers, body, expectedStatus, bodyContains, degradedMs }
 */
export async function httpProbe(t: ProbeTarget): Promise<ProbeResult> {
  if (!t.url) return { status: 'down', mensagem: 'url não configurada' }

  const cfg = t.config ?? {}
  const method: string = cfg.method ?? 'GET'
  const expectedStatus: number = cfg.expectedStatus ?? 200
  const degradedMs: number | undefined = cfg.degradedMs

  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), t.timeoutMs)

  try {
    const res = await fetch(t.url, {
      method,
      headers: cfg.headers,
      body: cfg.body,
      signal: controller.signal,
    })
    const latenciaMs = Date.now() - start

    if (res.status !== expectedStatus) {
      return { status: 'down', latenciaMs, mensagem: `HTTP ${res.status} (esperado ${expectedStatus})` }
    }
    if (cfg.bodyContains) {
      const text = await res.text()
      if (!text.includes(cfg.bodyContains)) {
        return { status: 'degraded', latenciaMs, mensagem: `resposta não contém "${cfg.bodyContains}"` }
      }
    }
    if (degradedMs && latenciaMs > degradedMs) {
      return { status: 'degraded', latenciaMs, mensagem: `lento (${latenciaMs}ms > ${degradedMs}ms)` }
    }
    return { status: 'up', latenciaMs }
  } catch (err: any) {
    const isAbort = err?.name === 'AbortError'
    return { status: 'down', mensagem: isAbort ? `timeout após ${t.timeoutMs}ms` : String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}
