'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, ApiError } from '../../../lib/api'
import { getToken, clearToken } from '../../../lib/auth'
import { AdminNav } from '../nav'

const TIPOS = [
  { v: 'senha', l: 'Senha' },
  { v: 'token', l: 'Token / chave de API' },
  { v: 'chave_ssh', l: 'Chave SSH' },
  { v: 'certificado', l: 'Certificado (senha do .pfx)' },
  { v: 'outro', l: 'Outro' },
]

const emptyForm = () => ({ tipo: 'senha' }) as any

export default function Credenciais() {
  const router = useRouter()
  const [creds, setCreds] = useState<any[]>([])
  const [projetos, setProjetos] = useState<any[]>([])
  const [form, setForm] = useState<any>(emptyForm())
  const [editId, setEditId] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [cofreOff, setCofreOff] = useState<string | null>(null)
  // Valores revelados nesta sessão de tela, por id. Nunca persistidos.
  const [revelados, setRevelados] = useState<Record<string, string>>({})

  const handleErr = (e: any) => {
    if (e instanceof ApiError && e.status === 401) {
      clearToken()
      router.replace('/login')
      return
    }
    // 503 = cofre sem SECRETS_KEY: é configuração, não erro do usuário.
    if (e instanceof ApiError && e.status === 503) {
      setCofreOff(String(e.message))
      return
    }
    setMsg('Erro: ' + e)
  }

  const load = async () => {
    setProjetos(await api('/api/projetos'))
    setCreds(await api('/api/credenciais'))
    setCofreOff(null)
  }

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login')
      return
    }
    load().catch(handleErr)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const salvar = async (e: any) => {
    e.preventDefault()
    try {
      if (editId) {
        await api(`/api/credenciais/${editId}`, { method: 'PATCH', body: JSON.stringify(form) })
        setMsg('Credencial atualizada.')
      } else {
        await api('/api/credenciais', { method: 'POST', body: JSON.stringify(form) })
        setMsg('Credencial guardada (cifrada).')
      }
      setForm(emptyForm())
      setEditId(null)
      load()
    } catch (e) { handleErr(e) }
  }

  const editar = (c: any) => {
    setEditId(c.id)
    // segredo entra vazio de propósito: em branco = "manter o atual".
    setForm({
      nome: c.nome, tipo: c.tipo, usuario: c.usuario ?? '', host: c.host ?? '',
      notas: c.notas ?? '', projetoId: c.projetoId ?? '', segredo: '',
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const cancelar = () => {
    setEditId(null)
    setForm(emptyForm())
    setMsg('')
  }

  const revelar = async (c: any) => {
    if (revelados[c.id]) {
      setRevelados((r) => {
        const { [c.id]: _, ...resto } = r
        return resto
      })
      return
    }
    try {
      const r = await api(`/api/credenciais/${c.id}/revelar`, { method: 'POST' })
      setRevelados((prev) => ({ ...prev, [c.id]: r.segredo }))
    } catch (e) { handleErr(e) }
  }

  const copiar = async (c: any) => {
    try {
      const valor = revelados[c.id] ?? (await api(`/api/credenciais/${c.id}/revelar`, { method: 'POST' })).segredo
      await navigator.clipboard.writeText(valor)
      setMsg(`"${c.nome}" copiada para a área de transferência.`)
    } catch (e) { handleErr(e) }
  }

  const remover = async (c: any) => {
    if (!confirm(`Remover a credencial "${c.nome}"? Isso não tem volta.`)) return
    try {
      await api(`/api/credenciais/${c.id}`, { method: 'DELETE' })
      load()
    } catch (e) { handleErr(e) }
  }

  if (cofreOff) {
    return (
      <main className="max-w-4xl mx-auto p-6 sm:p-10">
        <AdminNav atual="/admin/credenciais" />
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
          <h2 className="font-semibold text-amber-900">Cofre desativado</h2>
          <p className="text-sm text-amber-800 mt-2">{cofreOff}</p>
          <pre className="mt-3 text-xs bg-white border rounded p-3 overflow-x-auto">
{`# 1. gere a chave
openssl rand -base64 32

# 2. coloque no .env da raiz do projeto
SECRETS_KEY=<a chave gerada>

# 3. reinicie o worker
docker compose up -d worker`}
          </pre>
          <p className="text-xs text-amber-800 mt-3">
            Guarde essa chave fora do banco. Se ela mudar, os segredos já gravados ficam ilegíveis.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="max-w-4xl mx-auto p-6 sm:p-10">
      <AdminNav atual="/admin/credenciais" />

      <form onSubmit={salvar} className="bg-white border border-slate-200 rounded-xl p-5 mb-8 grid gap-3 sm:grid-cols-2">
        <h2 className="sm:col-span-2 font-semibold">
          {editId ? 'Editar credencial' : 'Guardar credencial'}
        </h2>
        <p className="sm:col-span-2 text-sm text-slate-500 -mt-1">
          O segredo é cifrado (AES-256-GCM) antes de ir para o banco e nunca volta em listagens —
          só ao clicar em <strong>Revelar</strong>, o que fica registrado no log.
        </p>

        <label className="text-sm">Nome
          <input required className="mt-1 w-full border rounded px-2 py-1" value={form.nome || ''}
            onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Postgres do Portal" />
        </label>

        <label className="text-sm">Tipo
          <select className="mt-1 w-full border rounded px-2 py-1" value={form.tipo}
            onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
            {TIPOS.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
          </select>
        </label>

        <label className="text-sm">Usuário (opcional)
          <input className="mt-1 w-full border rounded px-2 py-1" value={form.usuario || ''}
            onChange={(e) => setForm({ ...form, usuario: e.target.value })} placeholder="postgres" />
        </label>

        <label className="text-sm">Host / onde se usa (opcional)
          <input className="mt-1 w-full border rounded px-2 py-1" value={form.host || ''}
            onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="77.37.41.177:5432" />
        </label>

        <label className="text-sm sm:col-span-2">
          Segredo {editId && <span className="text-slate-400">(deixe em branco para manter o atual)</span>}
          <input type="password" autoComplete="new-password" required={!editId}
            className="mt-1 w-full border rounded px-2 py-1 font-mono" value={form.segredo || ''}
            onChange={(e) => setForm({ ...form, segredo: e.target.value })} />
        </label>

        <label className="text-sm">Projeto (opcional)
          <select className="mt-1 w-full border rounded px-2 py-1" value={form.projetoId || ''}
            onChange={(e) => setForm({ ...form, projetoId: e.target.value })}>
            <option value="">— sem projeto —</option>
            {projetos.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
          </select>
        </label>

        <label className="text-sm">Notas (opcional)
          <input className="mt-1 w-full border rounded px-2 py-1" value={form.notas || ''}
            onChange={(e) => setForm({ ...form, notas: e.target.value })} placeholder="onde essa senha é usada" />
        </label>

        <div className="sm:col-span-2 flex items-center gap-3">
          <button className="bg-slate-900 text-white rounded px-4 py-2 text-sm">
            {editId ? 'Salvar' : 'Guardar'}
          </button>
          {editId && (
            <button type="button" onClick={cancelar} className="border rounded px-4 py-2 text-sm">Cancelar</button>
          )}
        </div>

        {msg && <p className="sm:col-span-2 text-sm text-slate-600">{msg}</p>}
      </form>

      <h2 className="font-semibold mb-3">Credenciais ({creds.length})</h2>
      <div className="space-y-2">
        {creds.map((c) => (
          <div key={c.id} className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="font-medium flex items-center gap-2">
                  {c.nome}
                  <span className="text-xs text-slate-400">{c.tipo}</span>
                </div>
                <div className="text-xs text-slate-500 mt-1 truncate">
                  {c.usuario ? `${c.usuario}@` : ''}{c.host || 'sem host'}
                  {c.projeto ? ` · ${c.projeto.nome}` : ''}
                </div>
                <div className="mt-2 font-mono text-sm break-all">
                  {revelados[c.id] ?? c.segredo}
                </div>
                {c.notas && <div className="text-xs text-slate-400 mt-1">{c.notas}</div>}
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => revelar(c)} className="text-sm border rounded px-3 py-1">
                  {revelados[c.id] ? 'Ocultar' : 'Revelar'}
                </button>
                <button onClick={() => copiar(c)} className="text-sm border rounded px-3 py-1">Copiar</button>
                <button onClick={() => editar(c)} className="text-sm border rounded px-3 py-1">Editar</button>
                <button onClick={() => remover(c)} className="text-sm text-rose-600 border border-rose-200 rounded px-3 py-1">Remover</button>
              </div>
            </div>
          </div>
        ))}
        {creds.length === 0 && (
          <p className="text-sm text-slate-400">Nenhuma credencial guardada ainda.</p>
        )}
      </div>
    </main>
  )
}
