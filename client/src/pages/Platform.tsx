import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { EmptyState, fmtDateTime } from '../ui'
import { toast } from '../lib/toast'
import { confirmDialog } from '../lib/confirm'

interface Org {
  id: string; name: string; is_personal: number; allowed_domains: string[]; created_at: string
  user_count: number; task_count: number; last_activity: string | null; owner_email: string | null
}

// Platform admin console — oversee ALL organizations (super-admin only).
export default function Platform() {
  const [orgs, setOrgs] = useState<Org[] | null>(null)
  const [stats, setStats] = useState<{ orgs: number; users: number; tasks: number } | null>(null)
  const [error, setError] = useState(false)
  const [q, setQ] = useState('')

  const load = () => {
    setError(false); setOrgs(null)
    Promise.all([api.get('/platform/stats'), api.get('/platform/orgs')])
      .then(([s, o]) => { setStats(s); setOrgs(o) })
      .catch(() => setError(true))
  }
  useEffect(load, [])

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
                <td className="cell-title"><div style={{ fontWeight: 600 }}>{o.name}</div>
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
    </>
  )
}
