import { getToken } from './auth'

export const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4400'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api(path: string, init?: RequestInit) {
  const token = getToken()
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
    cache: 'no-store',
  })
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}
