'use client'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'

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

function barColor(uptime: number | null) {
  if (uptime == null) return 'bg-slate-200'
  if (uptime >= 99) return 'bg-emerald-500'
  if (uptime >= 90) return 'bg-amber-500'
  return 'bg-rose-500'
}

export default function Home() {
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const load = () => api('/api/public/status').then(setData).catch((e) => setErr(String(e)))
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [])

  if (err) return <main className="max-w-3xl mx-auto p-8"><p className="text-rose-600">Erro ao carregar: {err}</p></main>
  if (!data) return <main className="max-w-3xl mx-auto p-8 text-slate-500">Carregando…</main>

  const allGroups = [
    ...data.groups,
    ...(data.ungrouped.length ? [{ id: '_', nome: 'Outros', services: data.ungrouped }] : []),
  ]

  return (
    <main className="max-w-3xl mx-auto p-6 sm:p-10">
      <header className="mb-8">
        <h1 className="text-2xl font-bold">Status dos Serviços Vetor</h1>
        <p className="text-sm text-slate-500 mt-1">Disponibilidade dos nossos sistemas em tempo real.</p>
      </header>

      <div className={`rounded-xl p-5 mb-8 text-white ${data.overall === 'operational' ? 'bg-emerald-600' : 'bg-rose-600'}`}>
        <p className="text-lg font-semibold">
          {data.overall === 'operational' ? 'Todos os sistemas operacionais' : 'Há incidentes em andamento'}
        </p>
      </div>

      {allGroups.map((g: any) => (
        <section key={g.id} className="mb-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">{g.nome}</h2>
          <div className="space-y-2">
            {g.services.map((s: any) => (
              <div key={s.id} className="bg-white rounded-lg border border-slate-200 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`w-3 h-3 rounded-full ${DOT[s.status] || DOT.unknown}`} />
                    <span className="font-medium">{s.nome}</span>
                  </div>
                  <span className="text-sm text-slate-500">
                    {LABEL[s.status] || s.status}
                    {s.uptime90d != null ? ` · ${s.uptime90d}% (90d)` : ''}
                  </span>
                </div>
                <div className="flex gap-[2px] mt-3 h-6">
                  {s.history.map((h: any, i: number) => (
                    <span
                      key={i}
                      title={`${h.date}: ${h.uptime == null ? 'sem dados' : h.uptime + '%'}`}
                      className={`flex-1 rounded-sm ${barColor(h.uptime)}`}
                    />
                  ))}
                </div>
              </div>
            ))}
            {g.services.length === 0 && <p className="text-sm text-slate-400">Nenhum serviço.</p>}
          </div>
        </section>
      ))}

      <footer className="mt-10 text-xs text-slate-400">
        <a href="/admin" className="underline">Painel administrativo</a>
      </footer>
    </main>
  )
}
