import React, { createContext, useContext, useEffect, useState } from 'react'
import { api, setToken, getToken, User } from './api'
import { registerPush, unregisterPush } from './push'

interface SignupInput { company: string; name: string; email: string; password: string; personal?: boolean }
interface AcceptInviteInput { token: string; name: string; password: string }
interface AuthCtx {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (input: SignupInput) => Promise<void>
  acceptInvite: (input: AcceptInviteInput) => Promise<void>
  logout: () => void
  refresh: () => Promise<void>
}
const Ctx = createContext<AuthCtx>(null as any)
export const useAuth = () => useContext(Ctx)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!getToken()) { setLoading(false); return }
    api.get('/auth/me')
      .then((d) => { setUser(d.user); registerPush() })
      .catch(() => setToken(null))
      .finally(() => setLoading(false))
  }, [])

  const login = async (email: string, password: string) => {
    const d = await api.post('/auth/login', { email, password })
    setToken(d.token)
    setUser(d.user)
    registerPush() // ask for notification permission + register this device (native only)
  }
  // Create a new company + its first account, then log straight in.
  const signup = async (input: SignupInput) => {
    const d = await api.post('/auth/signup', input)
    setToken(d.token)
    setUser(d.user)
    registerPush()
  }
  // Accept an emailed invite: creates the account in the inviting org, then logs in.
  const acceptInvite = async (input: AcceptInviteInput) => {
    const d = await api.post('/invites/accept', input)
    setToken(d.token)
    setUser(d.user)
    registerPush()
  }
  const logout = () => { unregisterPush(); setToken(null); setUser(null) }
  const refresh = async () => { try { const d = await api.get('/auth/me'); setUser(d.user) } catch {} }

  return <Ctx.Provider value={{ user, loading, login, signup, acceptInvite, logout, refresh }}>{children}</Ctx.Provider>
}
