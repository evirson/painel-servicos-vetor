'use client'
import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { api, ApiError } from '../../../../lib/api'
import { getToken, clearToken } from '../../../../lib/auth'

const DOT: Record<string, string> = {
  up: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  down: 'bg-rose-500',
  unknown: 'bg-slate-300',
}
const LABEL: Record<string, string> = {
  up: 'Operacional',
  degraded: 'Degradado',
  down: 'Fora do ar',
  unknown: 'Sem dados',
}
const BADGE: Record<string, string> = {
  up: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  degraded: 'bg-amber-50 text-amber-700 border-amber-200',
  down: 'bg-rose-50 text-rose-700 border-rose-200',
}

const PERIODOS = [
  { horas: 24, l: '24 horas' },
  { horas: 24 * 7, l: '7 dias' },
  { horas: 24 * 30, l: '30 dias' },
]

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })

function duracao(inicio: string, fim: string | null) {
  const ms = (fim ? new Date(fim).getTime() : Date.now()) - new Date(inicio).getTime()
  const min = Math.round(ms / 60000)
  if (min < 1) return '< 1 min'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ${min % 60}min`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export default function TargetDetail() {
  const router = useRouter()
  const { id } = useParams<{ id: string }>()
  const [target, setTarget] = useState<any>(null)
  const [stats, setStats] = useState<any>(null)
  const [checks, setChecks] = useState<any[]>([])
  const [incidents, setIncidents] = useState<any[]>([])
  const [horas, setHoras] = useState(24)
  const [checking, setChecking] = useState(false)
  const [msg, setMsg] = useState('')

  const handleErr = useCallback((e: any) => {
    if (e instanceof ApiError && e.status === 401) {
      clearToken()
      router.replace('/login')
      return
    }
    setMsg('Erro: ' + e)
  }, [router])

  const load = useCallback(async (h: number) => {
    const [t, s, cs, inc] = await Promise.all([
      api(`/api/targets/${id}`),
      api(`/api/targets/${id}/stats?hours=${h}`),
      api(`/api/targets/${id}/checks?limit=100`),
      api(`/api/targets/${id}/incidents?limit=50`),
    ])
    if (!t) {
      setMsg('Serviço não encontrado.')
      return
    }
    setTarget(t)
    setStats(s)
    setChecks(cs)
    setIncidents(inc)
  }, [id])

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login')
      return
    }
    load(horas).catch(handleErr)
  }, [load, horas, router, handleErr])

  const checkNow = async () => {
    setChecking(true)
    try {
      await api(`/api/targets/${id}/check`, { method: 'POST' })
      await load(horas)
    } catch (e) { handleErr(e) } finally { setChecking(false) }
  }

  if (!target) {
    return (
      <main className="max-w-4xl mx-auto p-6 sm:p-10">
        <p className="text-slate-500">{msg || 'Carregando…'}</p>
      </main>
    )
  }

  const status = target.lastStatus ?? 'unknown'

  return (
    <main className="max-w-4xl mx-auto p-6 sm:p-10">
      <div className="mb-6">
        <a href="/admin" className="text-sm underline text-slate-500">← Voltar ao painel</a>
      </div>

      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-3">
            <span className={`w-3 h-3 rounded-full ${DOT[status] || DOT.unknown}`} />
            {target.nome}
            <span className={`text-xs font-medium border rounded-full px-2.5 py-0.5 ${BADGE[status] ?? 'bg-slate-50 text-slate-500 border-slate-200'}`}>
              {LABEL[status] || status}
            </span>
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {target.tipo} · {target.host ? `${target.host}:${target.porta ?? ''}` : target.url}
            {' '}· {target.statusGroup?.nome ?? 'sem grupo'} · a cada {target.intervaloSegundos}s
            {target.lastCheckedAt && ` · última checagem: ${fmt(target.lastCheckedAt)}`}
          </p>
        </div>
        <button onClick={checkNow} disabled={checking}
          className="text-sm border rounded px-4 py-2 disabled:opacity-50">
          {checking ? 'Checando…' : 'Checar agora'}
        </button>
      </div>

      {msg && <p className="text-sm text-rose-600 mb-4">{msg}</p>}

      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Estatísticas</h2>
          <div className="flex gap-1">
            {PERIODOS.map((p) => (
              <button key={p.horas} onClick={() => setHoras(p.horas)}
                className={`text-xs rounded px-3 py-1 border ${horas === p.horas
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-600 border-slate-200'}`}>
                {p.l}
              </button>
            ))}
          </div>
        </div>
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Uptime</p>
              <p className="text-2xl font-bold mt-1">
                {stats.uptimePct != null ? `${stats.uptimePct}%` : '—'}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Latência média</p>
              <p className="text-2xl font-bold mt-1">
                {stats.latenciaMediaMs != null ? `${stats.latenciaMediaMs} ms` : '—'}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Checagens</p>
              <p className="text-2xl font-bold mt-1">{stats.total}</p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Falhas (down / degradado)</p>
              <p className="text-2xl font-bold mt-1">
                <span className={stats.down ? 'text-rose-600' : ''}>{stats.down}</span>
                <span className="text-slate-300 mx-1">/</span>
                <span className={stats.degraded ? 'text-amber-600' : ''}>{stats.degraded}</span>
              </p>
            </div>
          </div>
        )}
        {stats && stats.total === 0 && (
          <p className="text-sm text-slate-400 mt-2">Nenhuma checagem no período selecionado.</p>
        )}
      </section>

      <section className="mb-8">
        <h2 className="font-semibold mb-3">Incidentes ({incidents.length})</h2>
        <div className="space-y-2">
          {incidents.map((i) => (
            <div key={i.id} className="bg-white border border-slate-200 rounded-lg p-4 flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-sm font-medium">
                  {i.fim
                    ? <span className="text-slate-700">Resolvido</span>
                    : <span className="text-rose-600">Em aberto</span>}
                  <span className="text-slate-400 font-normal"> · duração {duracao(i.inicio, i.fim)}</span>
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {fmt(i.inicio)} → {i.fim ? fmt(i.fim) : 'agora'}
                  {i.resumo ? ` · ${i.resumo}` : ''}
                </p>
              </div>
            </div>
          ))}
          {incidents.length === 0 && <p className="text-sm text-slate-400">Nenhum incidente registrado. 🎉</p>}
        </div>
      </section>

      <section>
        <h2 className="font-semibold mb-3">Últimas checagens ({checks.length})</h2>
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                <th className="px-4 py-2 font-medium">Quando</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Latência</th>
                <th className="px-4 py-2 font-medium">Mensagem</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id} className="border-b border-slate-50 last:border-0">
                  <td className="px-4 py-2 whitespace-nowrap text-slate-600">{fmt(c.timestamp)}</td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full ${DOT[c.status] || DOT.unknown}`} />
                      {LABEL[c.status] || c.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-slate-600">{c.latenciaMs != null ? `${c.latenciaMs} ms` : '—'}</td>
                  <td className="px-4 py-2 text-slate-500 max-w-xs truncate" title={c.mensagem ?? ''}>{c.mensagem ?? '—'}</td>
                </tr>
              ))}
              {checks.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-4 text-slate-400">Nenhuma checagem registrada ainda.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}
