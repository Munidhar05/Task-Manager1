// Tiny fetch wrapper that injects the JWT and unwraps JSON / errors.
const TOKEN_KEY = 'smarttask_token'

// Base URL of the backend. Empty in dev (Vite proxies /api → :4000); set to the
// hosted backend (e.g. https://smarttask-api.onrender.com) for the Android build
// via VITE_API_BASE in client/.env.production.
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')

export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t: string | null) => {
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
}

async function request(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers as any) }
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  // never serve a cached response — user-specific data must not bleed across accounts
  const res = await fetch(`${API_BASE}/api${path}`, { ...opts, headers, cache: 'no-store' })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`)
  return data
}

async function uploadFile(path: string, file: File, field = 'file') {
  const form = new FormData()
  form.append(field, file)
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${API_BASE}/api${path}`, { method: 'POST', headers, body: form, cache: 'no-store' })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`)
  return data
}

export const api = {
  get: (p: string) => request(p),
  post: (p: string, body?: any) => request(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: (p: string, body?: any) => request(p, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: (p: string, body?: any) => request(p, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  del: (p: string) => request(p, { method: 'DELETE' }),
  upload: uploadFile,
}

// ---- shared types -----------------------------------------------------------
export type Role = 'admin' | 'manager' | 'employee'
export interface User { id: string; name: string; email: string; role: Role; org_id: string; phone?: string; department_id?: string; avatar_color?: string; avatar_file?: string | null; aliases?: string; preferred_language?: string }

// Authenticated avatar image URLs (token in query so <img> can load them).
// `ver` (the stored filename) busts the browser cache when the photo changes.
export const userAvatarUrl = (userId: string, ver?: string | null) => `${API_BASE}/api/users/${userId}/avatar?token=${getToken()}${ver ? `&v=${encodeURIComponent(ver)}` : ''}`
export const groupAvatarUrl = (convId: string, ver?: string | null) => `${API_BASE}/api/chat/conversations/${convId}/avatar?token=${getToken()}${ver ? `&v=${encodeURIComponent(ver)}` : ''}`

// An AI-suggested task awaiting manager review (the review queue).
export interface Suggestion {
  id: string; meeting_id: string; title: string; description?: string
  suggested_assignee_id?: string | null; suggested_assignee_name?: string | null; suggested_assignee_color?: string | null
  suggested_assignee_raw?: string | null; assignee_reasoning?: string | null
  confidence: number; priority: string; due_date?: string | null; due_date_raw?: string | null
  source_quote?: string | null; status: 'pending' | 'approved' | 'rejected' | 'merged'; created_task_id?: string | null
}
export interface Task {
  id: string; title: string; description?: string; priority: 'Critical' | 'High' | 'Medium' | 'Low'
  status: string; due_date?: string; due_date_raw?: string; progress: number
  ownership_confidence: string; approval_status: string; source_quote?: string
  assignee?: User; assignedBy?: User; assignee_name_raw?: string; assigned_by_name_raw?: string
  project?: { id: string; name: string }; meeting_id?: string
  assigned_at?: string; submitted_at?: string; completed_at?: string; created_at?: string; updated_at?: string
  visible_to_manager?: number
  subtasks?: Task[]; comments?: any[]; dependencies?: any[]; attachments?: any[]
}
