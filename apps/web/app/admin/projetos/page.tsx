'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, ApiError } from '../../../lib/api'
import { getToken, clearToken } from '../../../lib/auth'
import { AdminNav } from '../nav'

const emptyForm = () => ({ ativo: true, ordem: 0 }) as any

export default function Projetos() {
  const router = useRouter()
  const [projetos, setProjetos] = useState<any[]>([])
  const [groups, setGroups] = useState<any[]>([])
  const [form, setForm] = useState<any>(emptyForm())
  const [editId, setEditId] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  const handleErr = (e: any) => {
    if (e instanceof ApiError && e.status === 401) {
      clearToken()
      router.replace('/login')
      return
    }
    setMsg('Erro: ' + e)
  }

  const load = async () => {
    setProjetos(await api('/api/projetos'))
    setGroups(await api('/api/groups'))
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
      const body = { ...form, ordem: Number(form.ordem) || 0 }
      if (editId) {
        await api(`/api/projetos/${editId}`, { method: 'PATCH', body: JSON.stringify(body) })
        setMsg('Projeto atualizado.')
      } else {
        await api('/api/projetos', { method: 'POST', body: JSON.stringify(body) })
        setMsg('Projeto criado. Use "Gerar alvos" para começar a monitorá-lo.')
      }
      setForm(emptyForm())
      setEditId(null)
      load()
    } catch (e) { handleErr(e) }
  }

  const editar = (p: any) => {
    setEditId(p.id)
    setForm({
      nome: p.nome, descricao: p.descricao ?? '', urlFront: p.urlFront ?? '',
      urlApi: p.urlApi ?? '', host: p.host ?? '', statusGroupId: p.statusGroupId ?? '',
      ativo: p.ativo, ordem: p.ordem,
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const cancelar = () => {
    setEditId(null)
    setForm(emptyForm())
    setMsg('')
  }

  const gerarAlvos = async (p: any) => {
    try {
      const r = await api(`/api/projetos/${p.id}/gerar-alvos`, { method: 'POST' })
      setMsg(r.total ? `${r.total} alvo(s) criado(s): ${r.criados.join(', ')}` : 'Nada a criar — os alvos já existem.')
      load()
    } catch (e) { handleErr(e) }
  }

  const remover = async (p: any) => {
    if (!confirm(`Remover o projeto "${p.nome}"? Os alvos ficam, mas sem vínculo.`)) return
    try {
      await api(`/api/projetos/${p.id}`, { method: 'DELETE' })
      load()
    } catch (e) { handleErr(e) }
  }

  return (
    <main className="max-w-4xl mx-auto p-6 sm:p-10">
      <AdminNav atual="/admin/projetos" />

      <form onSubmit={salvar} className="bg-white border border-slate-200 rounded-xl p-5 mb-8 grid gap-3 sm:grid-cols-2">
        <h2 className="sm:col-span-2 font-semibold">
          {editId ? 'Editar projeto' : 'Cadastrar projeto'}
        </h2>
        <p className="sm:col-span-2 text-sm text-slate-500 -mt-1">
          Cadastre o sistema e o endereço do front. Depois use <strong>Gerar alvos</strong> e o painel
          cria sozinho o monitoramento HTTP e a checagem de validade do certificado.
        </p>

        <label className="text-sm">Nome do projeto
          <input required className="mt-1 w-full border rounded px-2 py-1" value={form.nome || ''}
            onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Portal do Representante" />
        </label>

        <label className="text-sm">Grupo na página pública
          <select className="mt-1 w-full border rounded px-2 py-1" value={form.statusGroupId || ''}
            onChange={(e) => setForm({ ...form, statusGroupId: e.target.value })}>
            <option value="">— sem grupo —</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.nome}</option>)}
          </select>
        </label>

        <label className="text-sm sm:col-span-2">Endereço do front
          <input className="mt-1 w-full border rounded px-2 py-1" value={form.urlFront || ''}
            onChange={(e) => setForm({ ...form, urlFront: e.target.value })}
            placeholder="https://portal.vetor.com.br" />
        </label>

        <label className="text-sm sm:col-span-2">Endereço da API (opcional)
          <input className="mt-1 w-full border rounded px-2 py-1" value={form.urlApi || ''}
            onChange={(e) => setForm({ ...form, urlApi: e.target.value })}
            placeholder="https://api.portal.vetor.com.br/health" />
        </label>

        <label className="text-sm">Servidor / host
          <input className="mt-1 w-full border rounded px-2 py-1" value={form.host || ''}
            onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="77.37.41.177" />
        </label>

        <label className="text-sm">Ordem
          <input type="number" className="mt-1 w-full border rounded px-2 py-1" value={form.ordem ?? 0}
            onChange={(e) => setForm({ ...form, ordem: e.target.value })} />
        </label>

        <label className="text-sm sm:col-span-2">Descrição
          <input className="mt-1 w-full border rounded px-2 py-1" value={form.descricao || ''}
            onChange={(e) => setForm({ ...form, descricao: e.target.value })}
            placeholder="Para que serve, quem usa…" />
        </label>

        <div className="sm:col-span-2 flex items-center gap-3">
          <button className="bg-slate-900 text-white rounded px-4 py-2 text-sm">
            {editId ? 'Salvar' : 'Cadastrar'}
          </button>
          {editId && (
            <button type="button" onClick={cancelar} className="border rounded px-4 py-2 text-sm">Cancelar</button>
          )}
        </div>

        {msg && <p className="sm:col-span-2 text-sm text-slate-600">{msg}</p>}
      </form>

      <h2 className="font-semibold mb-3">Projetos ({projetos.length})</h2>
      <div className="space-y-2">
        {projetos.map((p) => (
          <div key={p.id} className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="font-medium">{p.nome}</div>
                <div className="text-xs text-slate-500 mt-1 truncate">
                  {p.urlFront || 'sem front cadastrado'}
                  {p.urlApi ? ` · API: ${p.urlApi}` : ''}
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  {p.statusGroup?.nome ?? 'sem grupo'} · {p._count.targets} alvo(s) ·{' '}
                  {p._count.credenciais} credencial(is)
                  {p.host ? ` · ${p.host}` : ''}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => gerarAlvos(p)} className="text-sm border rounded px-3 py-1">Gerar alvos</button>
                <button onClick={() => editar(p)} className="text-sm border rounded px-3 py-1">Editar</button>
                <button onClick={() => remover(p)} className="text-sm text-rose-600 border border-rose-200 rounded px-3 py-1">Remover</button>
              </div>
            </div>
          </div>
        ))}
        {projetos.length === 0 && (
          <p className="text-sm text-slate-400">Nenhum projeto cadastrado ainda.</p>
        )}
      </div>
    </main>
  )
}
