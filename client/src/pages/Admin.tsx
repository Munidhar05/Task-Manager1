import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { Stat, Badge } from '../ui'
import UserManagement from '../components/UserManagement'

export default function Admin() {
  const [tab, setTab] = useState<'overview' | 'users' | 'audit'>('overview')
  return (
    <>
      <div className="toolbar">
        <button className={'btn btn-sm' + (tab === 'overview' ? ' btn-primary' : '')} onClick={() => setTab('overview')}>Overview</button>
        <button className={'btn btn-sm' + (tab === 'users' ? ' btn-primary' : '')} onClick={() => setTab('users')}>User Management</button>
        <button className={'btn btn-sm' + (tab === 'audit' ? ' btn-primary' : '')} onClick={() => setTab('audit')}>Audit Log</button>
      </div>
      {tab === 'overview' && <Overview />}
      {tab === 'users' && <UserManagement />}
      {tab === 'audit' && <Audit />}
    </>
  )
}

function Overview() {
  const [d, setD] = useState<any>(null)
  useEffect(() => { api.get('/dashboards/admin').then(setD) }, [])
  if (!d) return <span className="spinner" />
  return (
    <>
      <div className="grid grid-stats section">
        <Stat label="Users" value={d.totals.users} />
        <Stat label="Tasks" value={d.totals.tasks} accent="#3b82f6" />
        <Stat label="Meetings" value={d.totals.meetings} accent="#d4a017" />
        <Stat label="Projects" value={d.totals.projects} accent="#10b981" />
      </div>
      <div className="grid grid-2">
        <div className="card section">
          <div className="card-head"><h3>Users by role</h3></div>
          <div className="card-pad">
            {d.users_by_role.map((r: any) => (
              <div key={r.role} className="spread" style={{ padding: '6px 0' }}><span style={{ textTransform: 'capitalize' }}>{r.role}</span><strong>{r.c}</strong></div>
            ))}
          </div>
        </div>
        <div className="card section">
          <div className="card-head"><h3>Tasks by status</h3></div>
          <div className="card-pad">
            {d.tasks_by_status.map((r: any) => (
              <div key={r.status} className="spread" style={{ padding: '6px 0' }}><span>{r.status}</span><strong>{r.c}</strong></div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}


function Audit() {
  const [logs, setLogs] = useState<any[]>([])
  useEffect(() => { api.get('/dashboards/admin').then((d) => setLogs(d.recent_audit)) }, [])
  return (
    <div className="card">
      <div className="card-head"><h3>Recent activity (audit trail)</h3></div>
      <table>
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id}>
              <td className="muted" style={{ whiteSpace: 'nowrap' }}>{new Date(l.created_at).toLocaleString()}</td>
              <td>{l.actor_name || '—'}</td>
              <td><Badge color="#c5560f" soft>{l.action}</Badge></td>
              <td className="muted">{l.entity_type}</td>
              <td className="muted" style={{ fontSize: 12, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.detail}</td>
            </tr>
          ))}
          {logs.length === 0 && <tr><td colSpan={5} className="empty">No activity yet.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
