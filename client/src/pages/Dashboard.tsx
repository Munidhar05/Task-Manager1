import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, Task } from '../api'
import { useAuth } from '../auth'
import { Bar, Donut, PriorityBadge, StatusBadge, Avatar, EmptyState, dueLabel, PRIORITY_COLORS, STATUS_COLORS } from '../ui'
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
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{part}, {first} 👋</h2>
      <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>Here's your overview for today.</div>
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
  const load = () => { setError(false); setData(null); api.get('/dashboards/employee').then(setData).catch(() => setError(true)) }
  useEffect(load, [d.tick])
  if (error) return (
    <div className="card section">
      <EmptyState icon="⚠️" title="Couldn't load your dashboard" hint="Check your connection and try again."
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
      <div className="emp-kpis section">
        <Kpi value={c.assigned} label="Assigned" icon={KPI_ICONS.assigned} color="#c5560f" onClick={() => navigate('/tasks')} />
        <Kpi value={c.pending} label="Pending" icon={KPI_ICONS.pending} color="#3b82f6" onClick={() => navigate('/tasks?view=active')} />
        <Kpi value={c.completed} label="Completed" icon={KPI_ICONS.completed} color="#10b981" onClick={() => navigate('/tasks?view=completed')} />
        <Kpi value={c.overdue} label="Overdue" icon={KPI_ICONS.overdue} color="#ef4444" blink={c.overdue > 0} onClick={() => navigate('/tasks?view=overdue')} />
        <Kpi value={c.blocked} label="Blocked" icon={KPI_ICONS.blocked} color="#f59e0b" onClick={() => navigate('/tasks?status=Blocked')} />
      </div>
      <div className="grid grid-2">
        <div className="card section">
          <div className="card-head"><h3>Upcoming deadlines</h3></div>
          <div className="emp-list">
            {data.upcoming.length === 0 && <div className="empty">No upcoming deadlines 🎉</div>}
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
                <Bar value={s.count} max={maxStatus} color={STATUS_COLORS[s.status] || '#c5560f'} />
              </div>
            ))}
            {data.needs_confirmation > 0 && <div className="emp-confirm-note">⚠ {data.needs_confirmation} task(s) need ownership confirmation.</div>}
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

function Kpi({ value, label, icon, color, blink, onClick }: { value: React.ReactNode; label: string; icon: React.ReactNode; color: string; blink?: boolean; onClick?: () => void }) {
  const clickable = !!onClick
  return (
    <div
      className={'kpi' + (blink ? ' blink' : '') + (clickable ? ' clickable' : '')}
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

type RangeKey = 'today' | 'weekly' | 'monthly' | 'custom'
const RANGE_TABS: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'weekly', label: 'Week' },
  { key: 'monthly', label: 'Month' },
  { key: 'custom', label: 'Custom' },
]

function ManagerDash({ admin, name }: { admin?: boolean; name: string }) {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState(false)
  const [active, setActive] = useState<RangeKey>('monthly')
  const [from, setFrom] = useState(todayYmd())
  const [to, setTo] = useState(todayYmd())
  const [downloading, setDownloading] = useState(false)
  const d = useDrawer()
  const navigate = useNavigate()

  // Resolve the selected tab into a concrete date window.
  const range: ReportRange =
    active === 'custom' ? { from, to, label: 'Custom' }
    : active === 'today' ? presetRange('daily')
    : active === 'weekly' ? presetRange('weekly')
    : presetRange('monthly')

  const loadDash = () => {
    setError(false); setData(null)
    api.get(`/dashboards/manager?from=${range.from}&to=${range.to}`).then(setData).catch(() => setError(true))
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
      <div className="pbi-seg-wrap">
        <div className="pbi-seg">
          {RANGE_TABS.map((t) => (
            <button key={t.key} className={'pbi-tab' + (active === t.key ? ' active' : '')} onClick={() => setActive(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        {active === 'custom' && (
          <div className="pbi-datepop">
            <div className="dp-title">Select date range</div>
            <label>From<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>To<input type="date" value={to} min={from} max={todayYmd()} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
        )}
      </div>
      <button className="btn btn-primary btn-sm pbi-download" disabled={downloading} onClick={download}>
        {downloading ? <span className="spinner" /> : '⬇'} Download report
      </button>
    </div>
  )

  if (error) return (
    <div className="pbi">{toolbar}
      <div className="card"><EmptyState icon="⚠️" title="Couldn't load the dashboard" hint="Check your connection and try again."
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
  const maxWl = Math.max(...data.workload.map((w: any) => w.open_count), 1)
  const donutData = data.by_priority.map((p: any) => ({ label: p.priority, value: p.count, color: PRIORITY_COLORS[p.priority] }))
  return (
    <div className="pbi">
      {toolbar}
      <div className="pbi-kpis">
        <Kpi value={c.total} label="Total tasks" icon={KPI_ICONS.total} color="#c5560f" onClick={() => navigate('/tasks')} />
        <Kpi value={c.completed} label="Completed" icon={KPI_ICONS.completed} color="#10b981" onClick={() => navigate('/tasks?view=completed')} />
        <Kpi value={c.overdue} label="Overdue" icon={KPI_ICONS.overdue} color="#ef4444" blink={c.overdue > 0} onClick={() => navigate('/tasks?view=overdue')} />
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
                    {overloaded && <span style={{ color: '#ef4444', fontSize: 10.5, fontWeight: 700 }}>⚠</span>}
                  </span>
                  <span className="hbar-track">
                    <span className="hbar-fill" style={{ width: `${pct}%`, background: overloaded ? '#ef4444' : '#c5560f' }} />
                  </span>
                  <span className="hbar-val">{w.open_count}</span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="pbi-card">
          <div className="pbi-head"><h3>Open by priority</h3></div>
          <div className="pbi-scroll pbi-donut-wrap">
            <Donut data={donutData} size={140} onSegmentClick={(label) => navigate(`/tasks?priority=${encodeURIComponent(label)}&view=active`)} />
            <div className="pbi-legend">
              {donutData.map((p: any) => {
                const clickable = p.value > 0
                return (
                  <div
                    key={p.label}
                    className={'lg' + (clickable ? ' clickable' : '')}
                    onClick={clickable ? () => navigate(`/tasks?priority=${encodeURIComponent(p.label)}&view=active`) : undefined}
                    role={clickable ? 'button' : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/tasks?priority=${encodeURIComponent(p.label)}&view=active`) } } : undefined}
                    title={clickable ? `Open ${p.label} tasks (${p.value})` : undefined}
                  >
                    <span className="dot" style={{ background: p.color }} />
                    <span>{p.label}</span>
                    <b>{p.value}</b>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="pbi-card">
          <div className="pbi-head"><h3>Tasks by status</h3></div>
          <div className="pbi-scroll">
            {(() => {
              const maxStatus = Math.max(...data.by_status.map((s: any) => s.count), 1)
              return data.by_status.map((s: any) => (
                <div key={s.status} style={{ marginBottom: 13 }}>
                  <div className="spread" style={{ marginBottom: 4 }}>
                    <span className="row" style={{ gap: 7, fontSize: 13 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: STATUS_COLORS[s.status] }} />
                      {s.status}
                    </span>
                    <strong>{s.count}</strong>
                  </div>
                  <Bar value={s.count} max={maxStatus} color={STATUS_COLORS[s.status]} />
                </div>
              ))
            })()}
          </div>
        </div>

        <div className="pbi-card pbi-overdue">
          <div className="pbi-head"><h3>Overdue tasks</h3>{data.overdue.length > 0 && <span className="badge" style={{ marginLeft: 'auto', background: '#fee2e2', color: '#ef4444' }}>{c.overdue}</span>}</div>
          <div className="pbi-scroll" style={{ padding: 0 }}>
            <table>
              <tbody>
                {data.overdue.length === 0 && <tr><td className="muted">Nothing overdue 🎉</td></tr>}
                {data.overdue.map((t: any) => (
                  <tr key={t.id} className="clickable" onClick={() => d.setOpenId(t.id)}>
                    <td>{t.title}</td>
                    <td className="muted">{t.assignee_name || 'Unassigned'}</td>
                    <td>{dueLabel(t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {d.node}
    </div>
  )
}
