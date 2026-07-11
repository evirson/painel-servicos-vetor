'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '../../lib/api'
import { setToken } from '../../lib/auth'

export default function Login() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e: any) => {
    e.preventDefault()
    setErr('')
    setLoading(true)
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
      setToken(r.token)
      router.push('/admin')
    } catch {
      setErr('E-mail ou senha inválidos.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="max-w-sm mx-auto p-6 sm:p-10">
      <h1 className="text-2xl font-bold mb-6">Entrar no painel</h1>
      <form onSubmit={submit} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <label className="text-sm block">E-mail
          <input type="email" required autoFocus className="mt-1 w-full border rounded px-3 py-2"
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="text-sm block">Senha
          <input type="password" required className="mt-1 w-full border rounded px-3 py-2"
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {err && <p className="text-sm text-rose-600">{err}</p>}
        <button disabled={loading} className="w-full bg-slate-900 text-white rounded px-4 py-2 text-sm disabled:opacity-60">
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
      <p className="mt-6 text-xs text-slate-400">
        <a href="/" className="underline">Voltar à página pública</a>
      </p>
    </main>
  )
}
