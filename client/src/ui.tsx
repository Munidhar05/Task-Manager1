import React, { useEffect, useState } from 'react'

export const PRIORITY_COLORS: Record<string, string> = {
  Critical: '#ef4444', High: '#f59e0b', Medium: '#3b82f6', Low: '#94a3b8',
}
export const STATUS_COLORS: Record<string, string> = {
  'To Do': '#64748b', 'In Progress': '#3b82f6', 'Blocked': '#ef4444',
  'In Review': '#a855f7', 'Done': '#10b981', 'Reopened': '#f97316',
}
export const LANG_LABEL: Record<string, string> = { en: 'English', hi: 'हिन्दी', te: 'తెలుగు' }

export function Badge({ children, color, soft }: { children: React.ReactNode; color: string; soft?: boolean }) {
  return (
    <span className="badge" style={soft
      ? { background: color + '22', color, border: `1px solid ${color}55` }
      : { background: color, color: '#fff' }}>
      {children}
    </span>
  )
}

export function PriorityBadge({ p }: { p: string }) {
  return <Badge color={PRIORITY_COLORS[p] || '#64748b'} soft>{p}</Badge>
}
export function StatusBadge({ s }: { s: string }) {
  return <Badge color={STATUS_COLORS[s] || '#64748b'} soft>{s}</Badge>
}

export function Avatar({ name, color, size = 28, src }: { name?: string; color?: string; size?: number; src?: string | null }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => { setBroken(false) }, [src]) // a new image URL should retry, not stay fallen-back
  const initials = (name || '?').split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()
  if (src && !broken) {
    return <img className="avatar" src={src} alt={name || ''} onError={() => setBroken(true)}
      style={{ width: size, height: size, objectFit: 'cover' }} />
  }
  return (
    <span className="avatar" style={{ background: color || '#c5560f', width: size, height: size, fontSize: size * 0.4 }}>
      {initials}
    </span>
  )
}

export function ConfidenceTag({ c }: { c: string }) {
  if (c === 'needs_confirmation') return <Badge color="#f59e0b" soft>⚠ Needs confirmation</Badge>
  if (c === 'low') return <Badge color="#f97316" soft>⚠ Low confidence</Badge>
  return null
}

// Numeric AI confidence score (0-100): green ≥70, amber 40-69, red <40.
export function ConfidenceScore({ score }: { score: number }) {
  const n = Math.max(0, Math.min(100, Math.round(score || 0)))
  const color = n >= 70 ? '#10b981' : n >= 40 ? '#f59e0b' : '#ef4444'
  return (
    <span title={`AI confidence ${n}%`} className="row" style={{ gap: 6, fontSize: 12, fontWeight: 600, color }}>
      <span style={{ width: 54, height: 6, borderRadius: 3, background: color + '22', display: 'inline-block', overflow: 'hidden' }}>
        <span style={{ display: 'block', width: n + '%', height: '100%', background: color }} />
      </span>
      {n}%
    </span>
  )
}

export function Stat({ label, value, accent, hint }: { label: string; value: React.ReactNode; accent?: string; hint?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value" style={{ color: accent }}>{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  )
}

export function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max ? Math.round((value / max) * 100) : 0
  return (
    <div className="bar-track"><div className="bar-fill" style={{ width: pct + '%', background: color }} /></div>
  )
}

// Friendly absolute timestamp, e.g. "4 Jun 2026, 3:42 PM". Returns '—' when missing.
export function fmtDateTime(iso?: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Default lead time (days from today) per priority — mirrors the server's
// dueDateForPriority so the UI can pre-fill the same date the backend would.
const DUE_DAYS_BY_PRIORITY: Record<string, number> = { Critical: 0, High: 1, Medium: 3, Low: 5 }
export function defaultDueDate(priority: string): string {
  const days = DUE_DAYS_BY_PRIORITY[priority] ?? 3
  const d = new Date()
  d.setDate(d.getDate() + days)
  const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${da}`
}

export function dueLabel(t: { due_date?: string | null; due_date_raw?: string | null }) {
  if (t.due_date) {
    const today = new Date().toISOString().slice(0, 10)
    const overdue = t.due_date < today
    return <span style={{ color: overdue ? '#ef4444' : 'inherit', fontWeight: overdue ? 600 : 400 }}>{t.due_date}{overdue ? ' (overdue)' : ''}</span>
  }
  if (t.due_date_raw) return <span style={{ fontStyle: 'italic', color: '#94a3b8' }}>“{t.due_date_raw}”</span>
  return <span style={{ color: '#cbd5e1' }}>—</span>
}
