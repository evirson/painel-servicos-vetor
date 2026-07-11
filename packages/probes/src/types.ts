export type ProbeStatus = 'up' | 'down' | 'degraded'

export interface ProbeResult {
  status: ProbeStatus
  latenciaMs?: number
  mensagem?: string
}

export interface ProbeTarget {
  tipo: string
  host?: string | null
  porta?: number | null
  url?: string | null
  timeoutMs: number
  config?: any
}
