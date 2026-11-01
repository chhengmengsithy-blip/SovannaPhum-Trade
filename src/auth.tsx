import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { Plan } from './plan'
import { api } from './services/api'

export type Provider = 'email' | 'gmail' | 'telegram'
export type Role = 'admin' | 'user'

export type Account = {
  id: string
  name: string
  email: string
  plan: Plan
  role: Role
  provider: Provider
  telegram?: string
  lifetimePro?: boolean
  createdAt: string
}

export type SignupInput = { name: string; email: string; password: string }

export const ADMIN_EMAIL = 'Sithy@dev.pro'

type AuthContextValue = {
  user: Account | null
  accounts: Account[]
  ready: boolean
  login: (email: string, password: string) => Promise<Account>
  signup: (input: SignupInput) => Promise<Account>
  loginWithGmail: (email: string) => Promise<Account>
  loginWithTelegram: (handle: string) => Promise<Account>
  logout: () => Promise<void>
  linkTelegram: (handle: string | null) => Promise<void>
  updateAccount: (id: string, patch: { plan?: Plan }) => Promise<void>
  deleteAccount: (id: string) => Promise<void>
  refreshAccounts: () => Promise<void>
  refreshUser: () => Promise<Account | null>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Account | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [ready, setReady] = useState(false)

  const refreshUser = useCallback(async () => {
    const result = await api<{ user: Account | null }>('/auth/me')
    setUser(result.user)
    return result.user
  }, [])

  useEffect(() => {
    let active = true
    api<{ user: Account | null }>('/auth/me')
      .then(result => { if (active) setUser(result.user) })
      .catch(() => { if (active) setUser(null) })
      .finally(() => { if (active) setReady(true) })
    return () => { active = false }
  }, [])

  const login = async (email: string, password: string) => {
    const result = await api<{ user: Account }>('/auth/login', { method: 'POST', body: { email, password } })
    setUser(result.user)
    return result.user
  }

  const signup = async (input: SignupInput) => {
    const result = await api<{ user: Account }>('/auth/signup', { method: 'POST', body: input })
    setUser(result.user)
    return result.user
  }

  const loginWithGmail = async (email: string) => {
    const result = await api<{ user: Account }>('/auth/gmail', { method: 'POST', body: { email } })
    setUser(result.user)
    return result.user
  }

  const loginWithTelegram = async (handle: string) => {
    const result = await api<{ user: Account }>('/auth/telegram', { method: 'POST', body: { handle } })
    setUser(result.user)
    return result.user
  }

  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST' })
    } finally {
      setUser(null)
      setAccounts([])
    }
  }

  const refreshAccounts = useCallback(async () => {
    try {
      const result = await api<{ users: Account[] }>('/admin/users')
      setAccounts(result.users)
    } catch {
      setAccounts([])
    }
  }, [])

  const updateAccount = async (id: string, patch: { plan?: Plan }) => {
    const result = await api<{ user: Account }>(`/admin/users/${id}`, { method: 'PATCH', body: patch })
    setAccounts(list => list.map(account => (account.id === id ? result.user : account)))
    if (user?.id === id) setUser(result.user)
  }

  const deleteAccount = async (id: string) => {
    await api(`/admin/users/${id}`, { method: 'DELETE' })
    setAccounts(list => list.filter(account => account.id !== id))
  }

  const linkTelegram = async (handle: string | null) => {
    const result = await api<{ user: Account }>('/auth/telegram', { method: 'PATCH', body: { handle } })
    setUser(result.user)
  }

  return (
    <AuthContext.Provider
      value={{ user, accounts, ready, login, signup, loginWithGmail, loginWithTelegram, logout, linkTelegram, updateAccount, deleteAccount, refreshAccounts, refreshUser }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
