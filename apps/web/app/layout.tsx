import './globals.css'
import type { ReactNode } from 'react'

export const metadata = {
  title: 'Painel de Serviços — Vetor',
  description: 'Status e disponibilidade dos serviços Vetor',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="bg-slate-50 text-slate-900 min-h-screen">{children}</body>
    </html>
  )
}
