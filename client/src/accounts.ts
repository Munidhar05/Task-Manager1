// Signed-in accounts kept on this device, so switching between them does not mean
// typing a password again.
//
// The token IS the credential, so this is a real trade: one long-lived JWT in
// localStorage becomes several. Two things make it an acceptable one. Every token
// is tied to a server-side session row that Security → signed-in devices can
// revoke, so a stored token is not a permanent grant; and an account only lands
// here by signing in on this device, which is the same act that already stored one.
//
// It is still a shared-machine hazard. "Log out" removes an account from this list
// rather than only clearing the active token — otherwise signing out would leave
// the credential sitting here, one click from being used.
import type { User } from './api'

const KEY = 'smarttask_accounts'

export interface SavedAccount {
  id: string
  name: string
  email: string
  role: string
  avatar_color?: string
  avatar_file?: string | null
  token: string
  /** Ordering only — the most recently used sits first. */
  last_used: number
}

const read = (): SavedAccount[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((a) => a && a.id && a.token) : []
  } catch { return [] }   // storage off, or someone hand-edited it
}

const write = (list: SavedAccount[]) => {
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* storage off — switching just won't persist */ }
}

export const savedAccounts = (): SavedAccount[] => read().sort((a, b) => b.last_used - a.last_used)

// Record (or refresh) an account after a successful sign-in. Keyed by user id, so
// signing in again as someone already here replaces their stale token rather than
// leaving two rows that disagree about which one still works.
export function rememberAccount(user: User, token: string) {
  const list = read().filter((a) => a.id !== user.id)
  list.push({
    id: user.id, name: user.name, email: user.email, role: user.role,
    avatar_color: (user as any).avatar_color, avatar_file: (user as any).avatar_file,
    token, last_used: Date.now(),
  })
  write(list)
}

export const forgetAccount = (id: string) => write(read().filter((a) => a.id !== id))

export const accountToken = (id: string) => read().find((a) => a.id === id)?.token || null

// Keep the display fields current — a rename or a new photo should not leave the
// switcher showing who someone used to be.
export function syncAccount(user: User) {
  const list = read()
  const row = list.find((a) => a.id === user.id)
  if (!row) return
  Object.assign(row, {
    name: user.name, email: user.email, role: user.role,
    avatar_color: (user as any).avatar_color, avatar_file: (user as any).avatar_file,
    last_used: Date.now(),
  })
  write(list)
}
