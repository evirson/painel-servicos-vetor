'use client'
import { useRouter } from 'next/navigation'
import { clearToken } from '../../lib/auth'

const ABAS = [
  { href: '/admin', label: 'Serviços' },
  { href: '/admin/projetos', label: 'Projetos' },
  { href: '/admin/credenciais', label: 'Credenciais' },
]

/** Cabeçalho comum das telas do admin: título, abas e logout. */
export function AdminNav({ atual }: { atual: string }) {
  const router = useRouter()
  const logout = () => {
    clearToken()
    router.replace('/login')
  }

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Painel administrativo</h1>
        <div className="flex items-center gap-4">
          <a href="/" className="text-sm underline">Ver página pública</a>
          <button onClick={logout} className="text-sm border rounded px-3 py-1">Sair</button>
        </div>
      </div>
      <nav className="flex gap-1 border-b border-slate-200">
        {ABAS.map((a) => (
          <a
            key={a.href}
            href={a.href}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${
              a.href === atual
                ? 'border-slate-900 font-medium'
                : 'border-transparent text-slate-500 hover:text-slate-900'
            }`}
          >
            {a.label}
          </a>
        ))}
      </nav>
    </div>
  )
}
