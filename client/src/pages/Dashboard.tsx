import React, { useEffect, useState } from 'react'
import { api, Task } from '../api'
import { useAuth } from '../auth'
import { Stat, Bar, PriorityBadge, StatusBadge, Avatar, dueLabel, PRIORITY_COLORS } from '../ui'
import TaskDrawer from '../components/TaskDrawer'

export default function Dashboard() {
  const { user } = useAuth()
  if (!user) return null
  if (user.role === 'employee') return <EmployeeDash />
  if (user.role === 'manager') return <ManagerDash />
  return <ManagerDash admin />
}

function useDrawer() {
  const [openId, setOpenId] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const node = openId ? <TaskDrawer taskId={openId} onClose={() => setOpenId(null)} onChange={() => setTick((t) => t + 1)} /> : null
  return { openId, setOpenId, tick, node }
}

function EmployeeDash() {
  const [data, setData] = useState<any>(null)
  const d = useDrawer()
  useEffect(() => { api.get('/dashboards/employee').then(setData) }, [d.tick])
  if (!data) return <span className="spinner" />
  const c = data.counts
  return (
    <>
      <div className="grid grid-stats section">
        <Stat label="Assigned to me" value={c.assigned} />
        <Stat label="Pending" value={c.pending} accent="#3b82f6" />
        <Stat label="Completed" value={c.completed} accent="#10b981" />
        <Stat label="Overdue" value={c.overdue} accent={c.overdue ? '#ef4444' : undefined} />
        <Stat label="Blocked" value={c.blocked} accent={c.blocked ? '#f97316' : undefined} />
      </div>
      <div className="grid grid-2">
        <div className="card section">
          <div className="card-head"><h3>Upcoming deadlines</h3></div>
          <div>
            {data.upcoming.length === 0 && <div className="empty">No upcoming deadlines 🎉</div>}
            {data.upcoming.map((t: Task) => (
              <div key={t.id} className="spread clickable" style={{ padding: '12px 20px', borderBottom: '1px solid #f1f5f9' }} onClick={() => d.setOpenId(t.id)}>
                <div><div style={{ fontWeight: 600 }}>{t.title}</div><div className="muted" style={{ fontSize: 12 }}>{dueLabel(t)}</div></div>
                <PriorityBadge p={t.priority} />
              </div>
            ))}
          </div>
        </div>
        <div className="card section">
          <div className="card-head"><h3>My work by status</h3></div>
          <div className="card-pad">
            {data.by_status.map((s: any) => (
              <div key={s.status} style={{ marginBottom: 12 }}>
                <div className="spread" style={{ fontSize: 13, marginBottom: 4 }}><span>{s.status}</span><strong>{s.count}</strong></div>
                <Bar value={s.count} max={Math.max(...data.by_status.map((x: any) => x.count), 1)} color="#c5560f" />
              </div>
            ))}
            {data.needs_confirmation > 0 && <div style={{ marginTop: 14, color: '#f59e0b', fontSize: 13 }}>⚠ {data.needs_confirmation} task(s) need ownership confirmation.</div>}
          </div>
        </div>
      </div>
      {d.node}
    </>
  )
}

function ManagerDash({ admin }: { admin?: boolean }) {
  const [data, setData] = useState<any>(null)
  const d = useDrawer()
  useEffect(() => { api.get('/dashboards/manager').then(setData) }, [d.tick])
  if (!data) return <span className="spinner" />
  const c = data.counts
  const maxWl = Math.max(...data.workload.map((w: any) => w.open_count), 1)
  return (
    <>
      <div className="grid grid-stats section">
        <Stat label="Total tasks" value={c.total} />
        <Stat label="Assigned" value={c.open} accent="#3b82f6" />
        <Stat label="Completed" value={c.completed} accent="#10b981" />
      </div>
      <div className="grid grid-2">
        <div className="card section">
          <div className="card-head"><h3>Team workload</h3><span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>open tasks per person</span></div>
          <div className="card-pad">
            {data.workload.map((w: any) => {
              const overloaded = w.open_count > (maxWl * 0.66) && w.open_count >= 3
              return (
                <div key={w.id} style={{ marginBottom: 13 }}>
                  <div className="spread" style={{ marginBottom: 4 }}>
                    <span className="row"><Avatar name={w.name} color={w.avatar_color} size={22} /> {w.name} {overloaded && <span style={{ color: '#ef4444', fontSize: 11 }}>overloaded</span>}</span>
                    <span className="muted" style={{ fontSize: 12 }}>{w.open_count} open · {w.done_count} done{w.overdue_count ? ` · ${w.overdue_count} overdue` : ''}</span>
                  </div>
                  <Bar value={w.open_count} max={maxWl} color={overloaded ? '#ef4444' : '#c5560f'} />
                </div>
              )
            })}
          </div>
        </div>
        <div className="card section">
          <div className="card-head"><h3>Open by priority</h3></div>
          <div className="card-pad">
            {data.by_priority.map((p: any) => (
              <div key={p.priority} style={{ marginBottom: 12 }}>
                <div className="spread" style={{ fontSize: 13, marginBottom: 4 }}><PriorityBadge p={p.priority} /><strong>{p.count}</strong></div>
                <Bar value={p.count} max={Math.max(...data.by_priority.map((x: any) => x.count), 1)} color={PRIORITY_COLORS[p.priority]} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="grid grid-2">
        <div className="card section">
          <div className="card-head"><h3>Project progress</h3></div>
          <div className="card-pad">
            {data.projects.length === 0 && <div className="muted">No projects yet.</div>}
            {data.projects.map((p: any) => (
              <div key={p.id} style={{ marginBottom: 13 }}>
                <div className="spread" style={{ marginBottom: 4 }}><span style={{ fontWeight: 600 }}>{p.name}</span><span className="muted" style={{ fontSize: 12 }}>{p.done}/{p.total} · {p.progress}%</span></div>
                <Bar value={p.progress} max={100} color="#10b981" />
              </div>
            ))}
          </div>
        </div>
        <div className="card section">
          <div className="card-head"><h3>Overdue tasks</h3></div>
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
      {d.node}
    </>
  )
}
