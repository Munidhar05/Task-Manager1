import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, Task } from '../api'
import { useAuth } from '../auth'
import { Bar, Donut, PriorityBadge, StatusBadge, Avatar, EmptyState, Ic, dueLabel, PRIORITY_COLORS, STATUS_COLORS } from '../ui'
import TaskDrawer from '../components/TaskDrawer'
import { presetRange, todayYmd, ReportRange, downloadManagerReport } from '../report'
import { toast } from '../lib/toast'

export default function Dashboard() {
  const { user } = useAuth()
  if (!user) return null
  if (user.role === 'employee') return (
    <>
      <Greeting name={user.name} style={{ marginBottom: 18 }} />
      <EmployeeDash />
    </>
  )
  return <ManagerDash admin={user.role !== 'manager'} name={user.name} />
}

// Friendly time-of-day greeting shown at the top-left of the dashboard.
function Greeting({ name, style }: { name: string; style?: React.CSSProperties }) {
  const h = new Date().getHours()
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  const first = (name || '').trim().split(' ')[0] || name
  return (
    <div style={style}>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{part}, {first}</h2>
      <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>Here's your overview for today.</div>
    </div>
  )
}

// AI-suggestion banner — mirrors the template's "AI suggestions" card. Surfaces the
// real overdue count and deep-links to the overdue view. Hidden when nothing's overdue.
function AiSuggestBanner({ overdue, onGo }: { overdue: number; onGo: () => void }) {
  if (!overdue) return null
  return (
    <button className="ai-suggest section" onClick={onGo}>
      <span className="ai-suggest-ic">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2.5 14 8.2l5.7 2-5.7 2L12 19.9l-2-5.7-5.7-2L10 8.2z" />
          <path d="M19 13.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z" />
        </svg>
      </span>
      <span className="ai-suggest-body">
        <span className="ai-suggest-title">You have {overdue} overdue task{overdue === 1 ? '' : 's'}</span>
        <span className="ai-suggest-sub">Tap to review and reschedule them.</span>
      </span>
      <span className="ai-suggest-go" aria-hidden="true">›</span>
    </button>
  )
}

// Relative "time ago" for audit rows. SQLite stores UTC as a bare "YYYY-MM-DD
// HH:MM:SS" string, so normalise it to a real UTC instant first.
function timeAgo(raw: string | number): string {
  let ms: number
  if (typeof raw === 'number') ms = raw
  else {
    const s = /\dT|\dZ|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z'
    ms = Date.parse(s)
  }
  if (isNaN(ms)) return ''
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (sec < 60) return 'just now'
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago'
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago'
  return Math.floor(sec / 86400) + 'd ago'
}

const ActSvg = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
)
// Map an audit action (e.g. "task.complete") to a friendly verb + icon + colour.
function actMeta(action: string): { verb: string; color: string; icon: React.ReactNode } {
  const a = (action || '').toLowerCase()
  if (a.includes('complete') || a.includes('done') || a.includes('approve')) return { verb: 'completed a task', color: '#10b981', icon: <ActSvg><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="m9 11 3 3L22 4" /></ActSvg> }
  if (a.includes('assign')) return { verb: 'was assigned a task', color: '#3b82f6', icon: <ActSvg><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="m15 11 2 2 4-4" /></ActSvg> }
  if (a.startsWith('task.create') || a.includes('create') && a.includes('task')) return { verb: 'created a task', color: '#f2622e', icon: <ActSvg><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M12 8v8M8 12h8" /></ActSvg> }
  if (a.includes('comment')) return { verb: 'added a comment', color: '#8b5cf6', icon: <ActSvg><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></ActSvg> }
  if (a.includes('meeting')) return { verb: 'added a meeting', color: '#0ea5a3', icon: <ActSvg><rect x="3" y="4" width="18" height="18" rx="3" /><path d="M16 2v4M8 2v4M3 10h18" /></ActSvg> }
  if (a.includes('invite') || a.includes('member') || a.startsWith('user.')) return { verb: 'updated a member', color: '#3b82f6', icon: <ActSvg><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></ActSvg> }
  if (a.includes('upload') || a.includes('attach') || a.includes('file')) return { verb: 'uploaded a file', color: '#64748b', icon: <ActSvg><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></ActSvg> }
  if (a.includes('delete') || a.includes('remove')) return { verb: 'removed an item', color: '#ef4444', icon: <ActSvg><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" /></ActSvg> }
  if (a.includes('login') || a.includes('auth')) return { verb: 'signed in', color: '#64748b', icon: <ActSvg><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="M10 17l5-5-5-5M15 12H3" /></ActSvg> }
  return { verb: (a.split('.')[1] || a).replace(/_/g, ' '), color: '#f2622e', icon: <ActSvg><rect x="3" y="4" width="18" height="18" rx="3" /><path d="M8 2v4M16 2v4M3 10h18" /></ActSvg> }
}

// Recent activity feed — mirrors the template's "Recent activity" card, backed by
// the org audit log returned with the manager dashboard.
function RecentActivity({ items }: { items: any[] }) {
  return (
    <div className="pbi-card">
      <div className="pbi-head"><h3>Recent activity</h3></div>
      <div className="act-list">
        {(!items || items.length === 0) && <div className="muted" style={{ padding: '10px 4px', fontSize: 13 }}>No recent activity yet.</div>}
        {items && items.map((a: any) => {
          const m = actMeta(a.action)
          return (
            <div key={a.id} className="act-row">
              <span className="act-ic" style={{ ['--ac' as any]: m.color }}>{m.icon}</span>
              <div className="act-body">
                <div className="act-text"><b>{a.actor_name || 'Someone'}</b> {m.verb}{a.detail ? <> “{a.detail}”</> : ''}</div>
              </div>
              <span className="act-time">{timeAgo(a.created_at)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function useDrawer() {
  const [openId, setOpenId] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const node = openId ? <TaskDrawer taskId={openId} onClose={() => setOpenId(null)} onChange={() => setTick((t) => t + 1)} /> : null
  return { openId, setOpenId, tick, node }
}

function EmployeeDash() {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState(false)
  const d = useDrawer()
  const navigate = useNavigate()
  // Refetches (e.g. after a drawer edit) keep the current data on screen and swap
  // it in place — nulling it would flash the whole page back to skeletons.
  const load = () => { setError(false); api.get('/dashboards/employee').then(setData).catch(() => setError(true)) }
  useEffect(load, [d.tick])
  if (error) return (
    <div className="card section">
      <EmptyState icon={<Ic name="warning" size={40} />} title="Couldn't load your dashboard" hint="Check your connection and try again."
        action={<button className="btn btn-primary btn-sm" onClick={load}>Retry</button>} />
    </div>
  )
  if (!data) return (
    <>
      <div className="skel-kpis emp section">{Array.from({ length: 5 }).map((_, i) => <span key={i} className="skeleton skel-kpi" />)}</div>
      <div className="grid grid-2">
        <div className="card section"><div className="card-pad">{Array.from({ length: 4 }).map((_, i) => <span key={i} className="skeleton skel-row" />)}</div></div>
        <div className="card section"><div className="card-pad">{Array.from({ length: 4 }).map((_, i) => <span key={i} className="skeleton skel-row" />)}</div></div>
      </div>
    </>
  )
  const c = data.counts
  const maxStatus = Math.max(...data.by_status.map((x: any) => x.count), 1)
  return (
    <>
      <AiSuggestBanner overdue={c.overdue} onGo={() => navigate('/tasks?view=overdue')} />
      <div className="emp-kpis section">
        <Kpi value={c.assigned} label="Assigned" icon={KPI_ICONS.assigned} color="#f2622e" onClick={() => navigate('/tasks')} />
        <Kpi value={c.pending} label="Pending" icon={KPI_ICONS.pending} color="#3b82f6" onClick={() => navigate('/tasks?view=active')} />
        <Kpi value={c.completed} label="Completed" icon={KPI_ICONS.completed} color="#10b981" onClick={() => navigate('/tasks?view=completed')} />
        <Kpi value={c.overdue} label="Overdue" icon={KPI_ICONS.overdue} color="#ef4444" alert={c.overdue > 0} onClick={() => navigate('/tasks?view=overdue')} />
        <Kpi value={c.blocked} label="Blocked" icon={KPI_ICONS.blocked} color="#f59e0b" onClick={() => navigate('/tasks?status=Blocked')} />
      </div>
      <div className="grid grid-2">
        <div className="card section">
          <div className="card-head"><h3>Upcoming deadlines</h3></div>
          <div className="emp-list">
            {data.upcoming.length === 0 && <div className="empty">No upcoming deadlines</div>}
            {data.upcoming.map((t: Task) => (
              <div key={t.id} className="emp-list-row clickable" onClick={() => d.setOpenId(t.id)} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.setOpenId(t.id) } }}>
                <div style={{ minWidth: 0 }}><div className="emp-list-title">{t.title}</div><div className="muted" style={{ fontSize: 12 }}>{dueLabel(t)}</div></div>
                <PriorityBadge p={t.priority} />
              </div>
            ))}
          </div>
        </div>
        <div className="card section">
          <div className="card-head"><h3>My work by status</h3></div>
          <div className="card-pad">
            {data.by_status.map((s: any) => (
              <div key={s.status} style={{ marginBottom: 13 }}>
                <div className="spread" style={{ marginBottom: 5 }}>
                  <span className="row" style={{ gap: 8, fontSize: 13 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: STATUS_COLORS[s.status] || '#94a3b8' }} />
                    {s.status}
                  </span>
                  <strong>{s.count}</strong>
                </div>
                <Bar value={s.count} max={maxStatus} color={STATUS_COLORS[s.status] || '#f2622e'} />
              </div>
            ))}
            {data.needs_confirmation > 0 && <div className="emp-confirm-note row" style={{ gap: 7 }}><Ic name="warning" size={14} /> {data.needs_confirmation} task(s) need ownership confirmation.</div>}
          </div>
        </div>
      </div>
      {d.node}
    </>
  )
}

// Clean line-style KPI icons (inherit currentColor → tinted to each card's accent).
const KpiSvg = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
)
const KPI_ICONS = {
  total: <KpiSvg><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M9 12h6M9 16h6" /></KpiSvg>,
  assigned: <KpiSvg><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></KpiSvg>,
  pending: <KpiSvg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></KpiSvg>,
  completed: <KpiSvg><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="m9 11 3 3L22 4" /></KpiSvg>,
  overdue: <KpiSvg><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M5 3 2 6" /><path d="m22 6-3-3" /></KpiSvg>,
  blocked: <KpiSvg><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></KpiSvg>,
} as const

function Kpi({ value, label, icon, color, alert, onClick }: { value: React.ReactNode; label: string; icon: React.ReactNode; color: string; alert?: boolean; onClick?: () => void }) {
  const clickable = !!onClick
  return (
    <div
      className={'kpi' + (alert ? ' alert' : '') + (clickable ? ' clickable' : '')}
      style={{ ['--kc' as any]: color }}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!() } } : undefined}
    >
      <span className="kpi-icon">{icon}</span>
      <div>
        <div className="kpi-val">{value}</div>
        <div className="kpi-label">{label}</div>
      </div>
      {clickable && <span className="kpi-go" aria-hidden="true">›</span>}
    </div>
  )
}

type RangeKey = 'today' | 'weekly' | 'monthly' | 'all'
// The earliest date we query from for the "All tasks" view — effectively "since the beginning".
const EPOCH_YMD = '2000-01-01'
const RANGE_TABS: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'weekly', label: 'Week' },
  { key: 'monthly', label: 'Month' },
  { key: 'all', label: 'All tasks' },
]

function ManagerDash({ admin, name }: { admin?: boolean; name: string }) {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState(false)
  // True while a refetch is in flight with old data still on screen (tab switch,
  // drawer edit). The old view stays visible, slightly dimmed, instead of being
  // torn down to skeletons on every refresh.
  const [refreshing, setRefreshing] = useState(false)
  // Default view is "All tasks" (everything up to today) so the manager lands on
  // the full picture; the Today/Week/Month tabs narrow it down from there.
  const [active, setActive] = useState<RangeKey>('all')
  // "All tasks" is bounded only by an upper "till" date (defaults to today).
  const [to, setTo] = useState(todayYmd())
  const [datePopOpen, setDatePopOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const datePopRef = React.useRef<HTMLDivElement>(null)
  const d = useDrawer()
  const navigate = useNavigate()

  // Close the "till date" popup when clicking anywhere outside it.
  useEffect(() => {
    if (!datePopOpen) return
    const onDown = (e: MouseEvent) => {
      if (datePopRef.current && !datePopRef.current.contains(e.target as Node)) setDatePopOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [datePopOpen])

  // Resolve the selected tab into a concrete date window.
  const range: ReportRange =
    active === 'all' ? { from: EPOCH_YMD, to, label: 'All tasks' }
    : active === 'today' ? presetRange('daily')
    : active === 'weekly' ? presetRange('weekly')
    : presetRange('monthly')

  const loadDash = () => {
    setError(false); setRefreshing(true)
    api.get(`/dashboards/manager?from=${range.from}&to=${range.to}`)
      .then(setData).catch(() => setError(true)).finally(() => setRefreshing(false))
  }
  useEffect(loadDash, [active, range.from, range.to, d.tick])

  // Download a printable report for whichever period is currently selected.
  const download = async () => {
    setDownloading(true)
    try { await downloadManagerReport(range) }
    catch (e: any) { toast.error('Could not generate report: ' + e.message) }
    finally { setDownloading(false) }
  }

  const toolbar = (
    <div className="pbi-filter">
      <Greeting name={name} style={{ marginRight: 'auto' }} />
      <div className="pbi-seg-wrap" ref={datePopRef}>
        <div className="pbi-seg">
          {RANGE_TABS.map((t) => (
            <button
              key={t.key}
              className={'pbi-tab' + (active === t.key ? ' active' : '')}
              onClick={() => { setActive(t.key); setDatePopOpen(t.key === 'all') }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {active === 'all' && datePopOpen && (
          <div className="pbi-datepop">
            <div className="dp-title">Show all tasks till</div>
            <label>Till date<input type="date" value={to} max={todayYmd()} onChange={(e) => { setTo(e.target.value); setDatePopOpen(false) }} /></label>
          </div>
        )}
      </div>
      <button className="btn btn-primary btn-sm pbi-download" disabled={downloading} onClick={download}>
        {downloading ? <span className="spinner" /> : <Ic name="download" size={14} />} Download report
      </button>
    </div>
  )

  if (error) return (
    <div className="pbi">{toolbar}
      <div className="card"><EmptyState icon={<Ic name="warning" size={40} />} title="Couldn't load the dashboard" hint="Check your connection and try again."
        action={<button className="btn btn-primary btn-sm" onClick={loadDash}>Retry</button>} /></div>
    </div>
  )
  if (!data) return (
    <div className="pbi">{toolbar}
      <div className="skel-kpis">{Array.from({ length: 4 }).map((_, i) => <span key={i} className="skeleton skel-kpi" />)}</div>
      <div className="pbi-body">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="pbi-card"><div className="card-pad">{Array.from({ length: 4 }).map((_, j) => <span key={j} className="skeleton skel-row" />)}</div></div>)}
      </div>
    </div>
  )
  const c = data.counts
  // First-run: a brand-new workspace has no tasks yet. Show one clear next action
  // instead of four zeros and empty charts — the first 60s should invite the core
  // workflow (upload a meeting), not congratulate the user on an empty dashboard.
  if (c.total === 0) return (
    <div className="pbi" style={{ height: 'auto' }}>
      {toolbar}
      <div className="card section">
        <div className="empty-state" style={{ padding: '56px 24px' }}>
          <div className="empty-state-icon" style={{ color: 'var(--primary)' }}>
            <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="11" rx="3" /><path d="M5 10v1a7 7 0 0 0 14 0v-1" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" />
            </svg>
          </div>
          <div className="empty-state-title">Turn your first meeting into tracked work</div>
          <div className="empty-state-hint">Upload a recording or paste a transcript — Befach extracts the decisions, owners, and deadlines, and you approve them into tasks. Your dashboard fills in from there.</div>
          <div className="empty-state-action">
            <button className="btn btn-primary" onClick={() => navigate('/meetings')}>Upload your first meeting</button>
          </div>
        </div>
      </div>
    </div>
  )
  const maxWl = Math.max(...data.workload.map((w: any) => w.open_count), 1)
  return (
    <div className="pbi" style={refreshing ? { opacity: 0.6, transition: 'opacity .15s' } : { transition: 'opacity .15s' }}>
      {toolbar}
      <AiSuggestBanner overdue={c.overdue} onGo={() => navigate('/tasks?view=overdue')} />
      <div className="pbi-kpis">
        <Kpi value={c.total} label="Total tasks" icon={KPI_ICONS.total} color="#f2622e" onClick={() => navigate('/tasks')} />
        <Kpi value={c.completed} label="Completed" icon={KPI_ICONS.completed} color="#10b981" onClick={() => navigate('/tasks?view=completed')} />
        <Kpi value={c.overdue} label="Overdue" icon={KPI_ICONS.overdue} color="#ef4444" alert={c.overdue > 0} onClick={() => navigate('/tasks?view=overdue')} />
        <Kpi value={c.blocked} label="Blocked" icon={KPI_ICONS.blocked} color="#f59e0b" onClick={() => navigate('/tasks?status=Blocked')} />
      </div>

      <div className="pbi-body">
        <div className="pbi-card pbi-workload">
          <div className="pbi-head"><h3>Team workload</h3><span className="muted" style={{ marginLeft: 'auto', fontSize: 11.5 }}>open tasks per person</span></div>
          <div className="pbi-scroll">
            {/* All members shown; the panel scrolls internally when the team is large. (API sorts by open_count desc.) */}
            {data.workload.map((w: any) => {
              const overloaded = w.open_count > (maxWl * 0.66) && w.open_count >= 3
              const pct = Math.round((w.open_count / maxWl) * 100)
              return (
                <div
                  key={w.id}
                  className="hbar-row clickable"
                  title={`Open ${w.name}'s tasks · ${w.open_count} open · ${w.done_count} done${w.overdue_count ? ` · ${w.overdue_count} overdue` : ''}`}
                  onClick={() => navigate(`/tasks?assignee=${w.id}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/tasks?assignee=${w.id}`) } }}
                >
                  <span className="hbar-label">
                    <Avatar name={w.name} color={w.avatar_color} size={22} />
                    <span className="hbar-name">{w.name}</span>
                    {w.role && w.role !== 'employee' && (
                      <span className="hbar-role" title={`${w.name} is ${w.role === 'admin' ? 'an admin' : 'a manager'}`}>
                        {w.role === 'admin' ? 'Admin' : 'Manager'}
                      </span>
                    )}
                    {overloaded && <span style={{ color: 'var(--danger)', display: 'inline-flex' }} title="Overloaded"><Ic name="warning" size={12} /></span>}
                  </span>
                  <span className="hbar-track">
                    <span className="hbar-fill" style={{ width: `${pct}%`, background: overloaded ? '#ef4444' : '#f2622e' }} />
                  </span>
                  <span className="hbar-val">{w.open_count}</span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="pbi-card pbi-overdue">
          <div className="pbi-head"><h3>Overdue tasks</h3>{data.overdue.length > 0 && <span className="badge" style={{ marginLeft: 'auto', background: '#fee2e2', color: '#ef4444' }}>{c.overdue}</span>}</div>
          <div className="pbi-scroll" style={{ padding: 0 }}>
            <table>
              <tbody>
                {data.overdue.length === 0 && <tr><td className="muted">Nothing overdue</td></tr>}
                {data.overdue.map((t: any) => (
                  <tr key={t.id} className="clickable" onClick={() => d.setOpenId(t.id)}
                    role="button" tabIndex={0} aria-label={`Open ${t.title}`}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.setOpenId(t.id) } }}>
                    <td>{t.title}</td>
                    <td className="muted">{t.assignee_name || 'Unassigned'}</td>
                    <td>{dueLabel(t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <RecentActivity items={data.recent_activity} />
      </div>
      {d.node}
    </div>
  )
}
