import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { Stat, Badge } from '../ui'
import UserManagement from '../components/UserManagement'
import { toast } from '../lib/toast'

// Manage which email domains may join this organization. Empty = any domain.
function AllowedDomains() {
  const [domains, setDomains] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    api.get('/users/meta/org').then((d) => { setDomains(d.allowed_domains || []); setLoaded(true) }).catch(() => setLoaded(true))
  }, [])
  const add = () => {
    const d = input.trim().toLowerCase().replace(/^@/, '')
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) { toast.error('Enter a valid domain, e.g. acme.com'); return }
    if (!domains.includes(d)) setDomains([...domains, d])
    setInput('')
  }
  const save = async () => {
    setSaving(true)
    try {
      const r = await api.patch('/users/meta/org', { allowed_domains: domains })
      setDomains(r.allowed_domains || []); toast.success('Allowed domains saved.')
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }
  return (
    <div className="card section">
      <div className="card-head"><h3>Allowed email domains</h3></div>
      <div className="card-pad" style={{ display: 'grid', gap: 12 }}>
        <div className="muted" style={{ fontSize: 12.5 }}>
          Only these domains can be invited or added to your organization (members still verify their email).
          Leave empty to allow any domain.
        </div>
        <div className="domain-chips">
          {loaded && domains.length === 0 && <span className="muted" style={{ fontSize: 13 }}>No restriction — any domain is allowed.</span>}
          {domains.map((d) => (
            <span key={d} className="domain-chip">{d}<button onClick={() => setDomains(domains.filter((x) => x !== d))} aria-label={`Remove ${d}`}>✕</button></span>
          ))}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input placeholder="acme.com" value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} style={{ maxWidth: 240 }} />
          <button className="btn btn-sm" onClick={add}>+ Add domain</button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving} style={{ marginLeft: 'auto' }}>
            {saving ? <span className="spinner" /> : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Admin() {
  const [tab, setTab] = useState<'overview' | 'users' | 'audit' | 'usage'>('overview')
  // The Usage tab appears only if the platform admin granted this org access.
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [usageAllowed, setUsageAllowed] = useState(false)
  useEffect(() => {
    api.get('/usage').then((d) => { setUsage(d); setUsageAllowed(true) }).catch(() => setUsageAllowed(false))
  }, [])
  return (
    <>
      <div className="toolbar">
        <button className={'btn btn-sm' + (tab === 'overview' ? ' btn-primary' : '')} onClick={() => setTab('overview')}>Overview</button>
        <button className={'btn btn-sm' + (tab === 'users' ? ' btn-primary' : '')} onClick={() => setTab('users')}>User Management</button>
        <button className={'btn btn-sm' + (tab === 'audit' ? ' btn-primary' : '')} onClick={() => setTab('audit')}>Audit Log</button>
        {usageAllowed && <button className={'btn btn-sm' + (tab === 'usage' ? ' btn-primary' : '')} onClick={() => setTab('usage')}>AI Usage</button>}
      </div>
      {tab === 'overview' && <Overview />}
      {tab === 'users' && <><AllowedDomains /><UserManagement /></>}
      {tab === 'audit' && <Audit />}
      {tab === 'usage' && usageAllowed && <UsagePanel data={usage} />}
    </>
  )
}

const fmtUsd = (n: number) => '$' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: n < 1 ? 4 : 2, maximumFractionDigits: n < 1 ? 4 : 2 })
const fmtNum = (n: number) => (n || 0) >= 1000 ? (n / 1000).toFixed(n >= 1e6 ? 2 : 1).replace(/\.0$/, '') + (n >= 1e6 ? 'M' : 'k') : String(n || 0)

interface UsageRow { provider?: string; feature?: string; calls: number; tokens: number; cost: number }
interface UsageData {
  org_name: string
  total: { calls: number; tokens: number; cost: number }
  by_provider: UsageRow[]
  by_feature: UsageRow[]
}

// This organization's own AI/API usage. Only rendered when access has been granted.
function UsagePanel({ data }: { data: UsageData | null }) {
  if (!data) return <div className="card section"><div className="card-pad"><span className="spinner" /></div></div>
  return (
    <>
      <div className="grid grid-stats section">
        <Stat label="AI spend (est.)" value={fmtUsd(data.total.cost)} accent="#a855f7" />
        <Stat label="API calls" value={fmtNum(data.total.calls)} accent="#3b82f6" />
        <Stat label="Tokens" value={fmtNum(data.total.tokens)} accent="#10b981" />
      </div>
      <div className="grid grid-2 section" style={{ gap: 16 }}>
        <div className="card">
          <div className="card-head"><h3>By provider</h3></div>
          <div className="card-pad">
            {data.by_provider.length === 0 ? <span className="muted" style={{ fontSize: 13 }}>No usage yet.</span>
              : data.by_provider.map((r) => (
                <div key={r.provider} className="spread" style={{ padding: '5px 0' }}>
                  <span>{r.provider}</span><span className="muted">{fmtNum(r.calls)} calls · {fmtUsd(r.cost)}</span>
                </div>
              ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>By feature</h3></div>
          <div className="card-pad">
            {data.by_feature.length === 0 ? <span className="muted" style={{ fontSize: 13 }}>No usage yet.</span>
              : data.by_feature.map((r) => (
                <div key={r.feature} className="spread" style={{ padding: '5px 0' }}>
                  <span style={{ textTransform: 'capitalize' }}>{(r.feature || '').replace(/_/g, ' ')}</span>
                  <span className="muted">{fmtNum(r.calls)} calls · {fmtUsd(r.cost)}</span>
                </div>
              ))}
          </div>
        </div>
      </div>
      <div className="muted section" style={{ fontSize: 12 }}>Costs are estimates based on public list prices and are indicative, not an invoice.</div>
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
    <div className="card table-card-wrap">
      <div className="card-head"><h3>Recent activity (audit trail)</h3></div>
      <table className="table-cards">
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id}>
              <td className="cell-title muted" style={{ whiteSpace: 'nowrap' }}>{new Date(l.created_at).toLocaleString()}</td>
              <td data-label="Actor">{l.actor_name || '—'}</td>
              <td data-label="Action"><Badge color="#f2622e" soft>{l.action}</Badge></td>
              <td className="muted" data-label="Entity">{l.entity_type}</td>
              <td className="muted audit-detail" data-label="Detail" style={{ fontSize: 12 }}>{l.detail}</td>
            </tr>
          ))}
          {logs.length === 0 && <tr><td colSpan={5} className="empty">No activity yet.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
