'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, ApiError } from '../../lib/api'
import { getToken, clearToken } from '../../lib/auth'

const TIPOS = [
  { v: 'http_api', l: 'API HTTP' },
  { v: 'db_port', l: 'Porta de banco (TCP)' },
  { v: 'firebird', l: 'Firebird (TCP 3050)' },
  { v: 'asta', l: 'Asta / Delphi (TCP)' },
  { v: 'sefaz', l: 'SEFAZ (status serviço)' },
]

const emptyForm = () => ({
  tipo: 'http_api',
  intervaloSegundos: 60,
  timeoutMs: 5000,
  publico: true,
  ativo: true,
}) as any

export default function Admin() {
  const router = useRouter()
  const [targets, setTargets] = useState<any[]>([])
  const [groups, setGroups] = useState<any[]>([])
  const [form, setForm] = useState<any>(emptyForm())
  const [msg, setMsg] = useState('')

  // Se um erro for 401, a sessão expirou/é inválida: limpa e volta ao login.
  const handleErr = (e: any) => {
    if (e instanceof ApiError && e.status === 401) {
      clearToken()
      router.replace('/login')
      return
    }
    setMsg('Erro: ' + e)
  }

  const load = async () => {
    setTargets(await api('/api/targets'))
    setGroups(await api('/api/groups'))
  }

  const logout = () => {
    clearToken()
    router.replace('/login')
  }

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login')
      return
    }
    load().catch(handleErr)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const create = async (e: any) => {
    e.preventDefault()
    try {
      const body: any = { ...form }
      if (body.porta) body.porta = Number(body.porta)
      body.intervaloSegundos = Number(body.intervaloSegundos)
      body.timeoutMs = Number(body.timeoutMs)
      await api('/api/targets', { method: 'POST', body: JSON.stringify(body) })
      setForm(emptyForm())
      setMsg('Serviço adicionado.')
      load()
    } catch (e) {
      handleErr(e)
    }
  }

  const checkNow = async (id: string) => {
    try {
      await api(`/api/targets/${id}/check`, { method: 'POST' })
      load()
    } catch (e) { handleErr(e) }
  }
  const remove = async (id: string) => {
    if (!confirm('Remover este serviço?')) return
    try {
      await api(`/api/targets/${id}`, { method: 'DELETE' })
      load()
    } catch (e) { handleErr(e) }
  }
  const addGroup = async () => {
    const nome = prompt('Nome do grupo:')
    if (!nome) return
    try {
      await api('/api/groups', { method: 'POST', body: JSON.stringify({ nome, ordem: groups.length }) })
      load()
    } catch (e) { handleErr(e) }
  }

  const isTcp = ['db_port', 'firebird', 'asta'].includes(form.tipo)
  const isHttp = ['http_api', 'sefaz'].includes(form.tipo)

  return (
    <main className="max-w-4xl mx-auto p-6 sm:p-10">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Painel administrativo</h1>
        <div className="flex items-center gap-4">
          <a href="/" className="text-sm underline">Ver página pública</a>
          <button onClick={logout} className="text-sm border rounded px-3 py-1">Sair</button>
        </div>
      </div>

      <form onSubmit={create} className="bg-white border border-slate-200 rounded-xl p-5 mb-8 grid gap-3 sm:grid-cols-2">
        <h2 className="sm:col-span-2 font-semibold">Adicionar serviço</h2>

        <label className="text-sm">Nome
          <input required className="mt-1 w-full border rounded px-2 py-1" value={form.nome || ''}
            onChange={(e) => setForm({ ...form, nome: e.target.value })} />
        </label>

        <label className="text-sm">Tipo
          <select className="mt-1 w-full border rounded px-2 py-1" value={form.tipo}
            onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
            {TIPOS.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
          </select>
        </label>

        {isTcp && (
          <>
            <label className="text-sm">Host / IP
              <input className="mt-1 w-full border rounded px-2 py-1" value={form.host || ''}
                onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.0.10" />
            </label>
            <label className="text-sm">Porta
              <input className="mt-1 w-full border rounded px-2 py-1" value={form.porta || ''}
                onChange={(e) => setForm({ ...form, porta: e.target.value })}
                placeholder={form.tipo === 'firebird' ? '3050' : ''} />
            </label>
          </>
        )}

        {isHttp && (
          <label className="text-sm sm:col-span-2">URL
            <input className="mt-1 w-full border rounded px-2 py-1" value={form.url || ''}
              onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" />
          </label>
        )}

        <label className="text-sm">Grupo
          <select className="mt-1 w-full border rounded px-2 py-1" value={form.statusGroupId || ''}
            onChange={(e) => setForm({ ...form, statusGroupId: e.target.value || null })}>
            <option value="">— sem grupo —</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.nome}</option>)}
          </select>
        </label>

        <label className="text-sm">Intervalo (segundos)
          <input type="number" className="mt-1 w-full border rounded px-2 py-1" value={form.intervaloSegundos}
            onChange={(e) => setForm({ ...form, intervaloSegundos: e.target.value })} />
        </label>

        <div className="sm:col-span-2 flex items-center gap-4 flex-wrap">
          <label className="text-sm flex items-center gap-2">
            <input type="checkbox" checked={form.publico}
              onChange={(e) => setForm({ ...form, publico: e.target.checked })} />
            Exibir na página pública
          </label>
          <button className="ml-auto bg-slate-900 text-white rounded px-4 py-2 text-sm">Adicionar</button>
          <button type="button" onClick={addGroup} className="border rounded px-4 py-2 text-sm">+ Grupo</button>
        </div>

        {msg && <p className="sm:col-span-2 text-sm text-slate-600">{msg}</p>}
      </form>

      <h2 className="font-semibold mb-3">Serviços monitorados ({targets.length})</h2>
      <div className="space-y-2">
        {targets.map((t) => (
          <div key={t.id} className="bg-white border border-slate-200 rounded-lg p-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="font-medium flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${
                  t.lastStatus === 'up' ? 'bg-emerald-500'
                  : t.lastStatus === 'degraded' ? 'bg-amber-500'
                  : t.lastStatus === 'down' ? 'bg-rose-500' : 'bg-slate-300'}`} />
                {t.nome}
                <span className="text-xs text-slate-400">{t.tipo}</span>
              </div>
              <div className="text-xs text-slate-500 mt-1 truncate">
                {t.host ? `${t.host}:${t.porta ?? ''}` : t.url} · {t.statusGroup?.nome ?? 'sem grupo'} · a cada {t.intervaloSegundos}s
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => checkNow(t.id)} className="text-sm border rounded px-3 py-1">Checar agora</button>
              <button onClick={() => remove(t.id)} className="text-sm text-rose-600 border border-rose-200 rounded px-3 py-1">Remover</button>
            </div>
          </div>
        ))}
        {targets.length === 0 && <p className="text-sm text-slate-400">Nenhum serviço cadastrado ainda.</p>}
      </div>
    </main>
  )
}
