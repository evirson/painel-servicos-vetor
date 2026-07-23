/**
 * Tipos de alvo alimentados por PUSH: o worker não executa sonda para eles.
 * Quem grava o resultado é o agente do servidor, via POST /api/ingest/agent.
 *
 * Consequência importante: sem checagem ativa, um agente que morra deixaria
 * esses alvos congelados no último estado (verde, tipicamente) para sempre —
 * por isso existe o watchdog em scheduler.ts.
 */
export const TIPOS_PUSH = ['host_metric', 'docker_container'] as const

export type TipoPush = (typeof TIPOS_PUSH)[number]

export function ehTipoPush(tipo: string): boolean {
  return (TIPOS_PUSH as readonly string[]).includes(tipo)
}
