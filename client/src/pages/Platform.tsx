import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { Bar, EmptyState, STATUS_COLORS, fmtDateTime } from '../ui'
import { toast } from '../lib/toast'
import { confirmDialog } from '../lib/confirm'

interface Org {
  id: string; name: string; is_personal: number; allowed_domains: string[]; created_at: string
  user_count: number; task_count: number; last_activity: string | null; owner_email: string | null
}

interface Member { id: string; name: string; email: string; role: string; platform_admin: number; created_at: string }
interface OrgDetail {
  org: { id: string; name: string; is_personal: number; allowed_domains: string[]; created_at: string }
  members: Member[]
  by_status: { status: string; count: number }[]
  task_count: number
}

// Platform admin console — oversee ALL organizations (super-admin only).
export default function Platform() {
  const [orgs, setOrgs] = useState<Org[] | null>(null)
  const [stats, setStats] = useState<{ orgs: number; users: number; tasks: number } | null>(null)
  const [error, setError] = useState(false)
  const [q, setQ] = useState('')
  // Org drill-down: null = closed; { id } while loading; full detail once fetched.
  const [detail, setDetail] = useState<{ id: string; data: OrgDetail | null; error: boolean } | null>(null)

  const load = () => {
    setError(false); setOrgs(null)
    Promise.all([api.get('/platform/stats'), api.get('/platform/orgs')])
      .then(([s, o]) => { setStats(s); setOrgs(o) })
      .catch(() => setError(true))
  }
  useEffect(load, [])

  const openOrg = (id: string) => {
    setDetail({ id, data: null, error: false })
    api.get(`/platform/orgs/${id}`)
      .then((d) => setDetail({ id, data: d, error: false }))
      .catch(() => setDetail({ id, data: null, error: true }))
  }

  const removeOrg = async (o: Org) => {
    const ok = await confirmDialog({
      title: 'Delete organization',
      message: `Permanently delete "${o.name}" and ALL its data — ${o.user_count} user(s), ${o.task_count} task(s), meetings, chats and more? This cannot be undone.`,
      confirmText: 'Delete everything', danger: true,
    })
    if (!ok) return
    try { await api.del(`/platform/orgs/${o.id}`); toast.success(`"${o.name}" deleted.`); load() }
    catch (e: any) { toast.error(e.message) }
  }

  if (error) return (
    <div className="card"><EmptyState icon="⚠️" title="Couldn't load the platform console" hint="Check your connection and try again."
      action={<button className="btn btn-primary btn-sm" onClick={load}>Retry</button>} /></div>
  )
  if (!orgs || !stats) return <div className="dash-skeleton"><span className="spinner" /></div>

  const filtered = orgs.filter((o) =>
    !q || o.name.toLowerCase().includes(q.toLowerCase()) || (o.owner_email || '').toLowerCase().includes(q.toLowerCase()))

  return (
    <>
      <div className="emp-kpis section" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="kpi" style={{ ['--kc' as any]: '#c5560f' }}><div><div className="kpi-val">{stats.orgs}</div><div className="kpi-label">Organizations</div></div></div>
        <div className="kpi" style={{ ['--kc' as any]: '#3b82f6' }}><div><div className="kpi-val">{stats.users}</div><div className="kpi-label">Total users</div></div></div>
        <div className="kpi" style={{ ['--kc' as any]: '#10b981' }}><div><div className="kpi-val">{stats.tasks}</div><div className="kpi-label">Total tasks</div></div></div>
      </div>

      <div className="toolbar">
        <input placeholder="🔍 Search organizations…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} />
        <div className="muted" style={{ marginLeft: 'auto' }}>{filtered.length} of {orgs.length} orgs</div>
      </div>

      <div className="card table-card-wrap">
        <table className="table-cards">
          <thead><tr>
            <th>Organization</th><th>Type</th><th>Owner</th><th>Users</th><th>Tasks</th><th>Created</th><th>Last activity</th><th></th>
          </tr></thead>
          <tbody>
            {filtered.map((o) => (
              <tr key={o.id}>
                <td className="cell-title">
                  <button style={{ fontWeight: 600, textAlign: 'left', background: 'none', border: 'none', padding: 0, color: 'var(--primary)' }} onClick={() => openOrg(o.id)} title="View members & task breakdown">{o.name}</button>
                  {o.allowed_domains.length > 0 && <div className="muted" style={{ fontSize: 11 }}>{o.allowed_domains.join(', ')}</div>}</td>
                <td data-label="Type">{o.is_personal ? <span className="badge" style={{ background: '#eef2ff', color: '#4f46e5' }}>Personal</span> : <span className="badge" style={{ background: '#fbe9d6', color: '#c5560f' }}>Company</span>}</td>
                <td data-label="Owner" className="muted">{o.owner_email || '—'}</td>
                <td data-label="Users"><strong>{o.user_count}</strong></td>
                <td data-label="Tasks">{o.task_count}</td>
                <td data-label="Created">{(o.created_at || '').slice(0, 10)}</td>
                <td data-label="Last activity" className="muted">{o.last_activity ? fmtDateTime(o.last_activity) : '—'}</td>
                <td><button className="btn btn-sm btn-danger" onClick={() => removeOrg(o)}>🗑 Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="empty" style={{ padding: 20 }}>No organizations match your search.</div>}
      </div>

      {detail && <OrgDetailModal state={detail} onClose={() => setDetail(null)} onRetry={() => openOrg(detail.id)} />}
    </>
  )
}

function OrgDetailModal({ state, onClose, onRetry }: {
  state: { id: string; data: OrgDetail | null; error: boolean }
  onClose: () => void
  onRetry: () => void
}) {
  const d = state.data
  const maxStatus = d ? Math.max(...d.by_status.map((s) => s.count), 1) : 1
  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="card-head spread">
          <h3>{d ? d.org.name : 'Organization'}</h3>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div className="card-pad grid" style={{ gap: 18 }}>
          {state.error ? (
            <EmptyState icon="⚠️" title="Couldn't load this organization" hint="Check your connection and try again."
              action={<button className="btn btn-primary btn-sm" onClick={onRetry}>Retry</button>} />
          ) : !d ? (
            <div style={{ textAlign: 'center', padding: 20 }}><span className="spinner" /></div>
          ) : (
            <>
              <div>
                <div className="spread" style={{ marginBottom: 8 }}>
                  <strong>Tasks by status</strong>
                  <span className="muted">{d.task_count} total</span>
                </div>
                {d.by_status.length === 0 ? (
                  <div className="muted" style={{ fontSize: 13 }}>No tasks yet.</div>
                ) : d.by_status.map((s) => (
                  <div key={s.status} style={{ marginBottom: 11 }}>
                    <div className="spread" style={{ marginBottom: 4 }}>
                      <span className="row" style={{ gap: 7, fontSize: 13 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 3, background: STATUS_COLORS[s.status] || '#64748b' }} />
                        {s.status}
                      </span>
                      <strong>{s.count}</strong>
                    </div>
                    <Bar value={s.count} max={maxStatus} color={STATUS_COLORS[s.status] || '#64748b'} />
                  </div>
                ))}
              </div>

              <div>
                <div className="spread" style={{ marginBottom: 8 }}>
                  <strong>Members</strong>
                  <span className="muted">{d.members.length}</span>
                </div>
                <div className="card table-card-wrap" style={{ boxShadow: 'none', border: '1px solid var(--border)' }}>
                  <table className="table-cards">
                    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th></tr></thead>
                    <tbody>
                      {d.members.map((m) => (
                        <tr key={m.id}>
                          <td className="cell-title">
                            {m.name || '—'}
                            {m.platform_admin ? <span className="badge" style={{ marginLeft: 6, background: '#fef3c7', color: '#b45309', fontSize: 10 }}>Super admin</span> : null}
                          </td>
                          <td data-label="Email" className="muted">{m.email}</td>
                          <td data-label="Role">{m.role}</td>
                          <td data-label="Joined" className="muted">{(m.created_at || '').slice(0, 10)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
