import { useEffect, useState } from 'react'
import { api, getToken } from '../api'

export interface Category { id: string; name: string; color: string | null; builtin: boolean }

// Task categories (business units / brands): the five built-ins plus the ones
// this org added from the task form. The server owns the list
// (GET /users/meta/categories); this module is the one client-side copy of it,
// fetched once per sign-in, so every picker and badge agree and a category added
// in one dialog is already in the next without a reload.
//
// Built-in colours stay here rather than coming from the server: they were tuned
// against the theme, and a DCAL badge must look right before the list has
// loaded. Custom categories get their colour from the server, where it is chosen
// once so every screen and every device shows the same one.
export const DEFAULT_CATEGORY_COLORS: Record<string, string> = {
  'DCAL': '#3b82f6', '91GI': '#8b5cf6', 'Global Shopper': '#10b981', 'Rice': '#f59e0b', 'Taskmanager': '#f43f5e',
}
// The palette the server hands custom categories, so a badge drawn before the
// list arrives usually already matches what the list will say.
const FALLBACK_COLORS = ['#0ea5e9', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#a855f7', '#06b6d4', '#eab308', '#64748b']

const BUILTIN: Category[] = Object.keys(DEFAULT_CATEGORY_COLORS).map((name) => ({ id: name, name, color: DEFAULT_CATEGORY_COLORS[name], builtin: true }))
let list: Category[] = BUILTIN
// Which sign-in the list belongs to: a different token (another account, another
// org) means the org's own categories must be fetched again.
let loadedFor: string | null = null
let inflight: Promise<void> | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
const withColor = (c: Category): Category => ({ ...c, color: c.color || DEFAULT_CATEGORY_COLORS[c.name] || null })

export function loadCategories(): Promise<void> {
  const token = getToken()
  if (!token || loadedFor === token) return Promise.resolve()
  if (!inflight) {
    inflight = api.get('/users/meta/categories')
      .then((rows: Category[]) => { list = rows.map(withColor); loadedFor = token; emit() })
      .catch(() => {}) // offline: the built-ins stay, which is what the old static list was
      .finally(() => { inflight = null })
  }
  return inflight
}

// The current list, re-rendering the caller when it changes (first load, an add).
export function useCategories(): Category[] {
  const [, tick] = useState(0)
  useEffect(() => {
    const f = () => tick((t) => t + 1)
    subs.add(f)
    loadCategories()
    return () => { subs.delete(f) }
  }, [])
  return list
}

// Create a category (manager/admin) and fold it into the list. The same name
// again, any case, comes back with `existed` and the list is left alone.
export async function addCategory(name: string): Promise<Category & { existed?: boolean }> {
  const r: Category & { existed?: boolean } = await api.post('/users/meta/categories', { name })
  if (!list.some((c) => c.id === r.id)) { list = [...list, withColor(r)]; emit() }
  return r
}

export function categoryColor(name: string): string {
  const hit = list.find((c) => c.name === name)
  if (hit?.color) return hit.color
  if (DEFAULT_CATEGORY_COLORS[name]) return DEFAULT_CATEGORY_COLORS[name]
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length]
}
