import React, { useEffect, useState } from 'react'
import { api, Task, User } from '../api'
import { useAuth } from '../auth'
import { PriorityBadge, StatusBadge, Avatar, ConfidenceTag, dueLabel, fmtDateTime } from '../ui'
import TaskDrawer from '../components/TaskDrawer'

// Most recent meaningful timestamp for a task, used for the Time column + sorting.
const activityOf = (t: Task) => t.completed_at || t.submitted_at || t.assigned_at || t.updated_at || t.created_at || ''
const activityLabel = (t: Task) =>
  t.completed_at ? '✅ Completed' : t.submitted_at ? '📩 Submitted' : t.assigned_at ? '📌 Assigned' : '🆕 Created'

// Sortable columns. Ranks make Priority/Status sort by logical order (not alphabetically);
// tasks with no due date sort last. Each returns an ascending-order comparator value.
type SortKey = 'priority' | 'status' | 'due' | 'time'
const PRIORITY_RANK: Record<string, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 }
const STATUS_RANK: Record<string, number> = { 'To Do': 0, 'In Progress': 1, 'Blocked': 2, 'In Review': 3, 'Done': 4, 'Reopened': 5 }
const cmpAsc = (a: Task, b: Task, key: SortKey): number => {
  switch (key) {
    case 'priority': return (PRIORITY_RANK[a.priority] ?? 0) - (PRIORITY_RANK[b.priority] ?? 0)
    case 'status': return (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99)
    case 'due': return (a.due_date || '9999-12-31').localeCompare(b.due_date || '9999-12-31')
    case 'time': return activityOf(a).localeCompare(activityOf(b))
  }
}

export default function Tasks() {
  const { user } = useAuth()
  const [tasks, setTasks] = useState<Task[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [filters, setFilters] = useState<{ q: string; priority: string; status: string; assignee: string }>({ q: '', priority: '', status: '', assignee: '' })
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'time', dir: 'desc' })
  // Click a header: toggle direction if it's the active column, else switch to it (default desc).
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))

  const load = () => {
    const p = new URLSearchParams()
    Object.entries(filters).forEach(([k, v]) => v && p.set(k, v))
    api.get('/tasks?' + p.toString()).then(setTasks)
  }
  useEffect(() => { load() }, [filters])
  useEffect(() => { api.get('/users').then(setUsers) }, [])

  const isManager = user?.role !== 'employee'

  // Sort by the active column; direction flips the ascending comparator.
  const sortedTasks = [...tasks].sort((a, b) => {
    const cmp = cmpAsc(a, b, sort.key)
    return sort.dir === 'desc' ? -cmp : cmp
  })

  // Inline assign from the table row (managers only). Sets owner + flips confidence to confirmed.
  const assign = (taskId: string, userId: string) => {
    if (!userId) return
    api.patch(`/tasks/${taskId}`, { assignee_id: userId }).then(load)
  }

  // Clickable, sortable column header. Active column shows the direction arrow; the
  // others show a faint ↕ to hint they're sortable too.
  const sortTh = (label: string, key: SortKey) => (
    <th className="clickable" style={{ userSelect: 'none' }} onClick={() => toggleSort(key)} title={`Sort by ${label.toLowerCase()}`}>
      {label} {sort.key === key ? (sort.dir === 'desc' ? '↓' : '↑') : <span style={{ opacity: 0.3 }}>↕</span>}
    </th>
  )

  return (
    <>
      <div className="toolbar">
        <input placeholder="🔍 Search tasks…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} style={{ minWidth: 220 }} />
        <select value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })}>
          <option value="">All priorities</option>{['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}
        </select>
        <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="">All statuses</option>{['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened'].map((s) => <option key={s}>{s}</option>)}
        </select>
        {isManager && (
          <select value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value })}>
            <option value="">All assignees</option>
            <option value="unassigned">⚠ Unassigned</option>
            {users.filter(u => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        )}
        <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
          <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>+ New task</button>
        </div>
      </div>

      <div className="card">
        <table>
          <thead><tr>
            <th>Task</th>
            {sortTh('Priority', 'priority')}
            {sortTh('Status', 'status')}
            <th>Assignee</th>
            {sortTh('Due', 'due')}
            {sortTh('Time', 'time')}
          </tr></thead>
          <tbody>
            {sortedTasks.map((t) => (
              <tr key={t.id} className="clickable" onClick={() => setOpenId(t.id)}>
                <td><div style={{ fontWeight: 600 }}>{t.title}</div><ConfidenceTag c={t.ownership_confidence} /></td>
                <td><PriorityBadge p={t.priority} /></td>
                <td><StatusBadge s={t.status} /></td>
                <td>
                  {t.assignee ? (
                    <span className="row"><Avatar name={t.assignee.name} color={t.assignee.avatar_color} size={22} /> {t.assignee.name}</span>
                  ) : isManager ? (
                    <select
                      className="btn btn-sm"
                      style={{ maxWidth: 150 }}
                      value=""
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => { e.stopPropagation(); assign(t.id, e.target.value) }}
                    >
                      <option value="">＋ Assign…</option>
                      {users.filter(u => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  ) : (
                    <span className="muted">Unassigned</span>
                  )}
                </td>
                <td>{dueLabel(t)}</td>
                <td>
                  <div style={{ fontSize: 12.5 }}>{fmtDateTime(activityOf(t))}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{activityLabel(t)}</div>
                </td>
              </tr>
            ))}
            {tasks.length === 0 && <tr><td colSpan={6} className="empty">No tasks match your filters.</td></tr>}
          </tbody>
        </table>
      </div>

      {openId && <TaskDrawer taskId={openId} onClose={() => setOpenId(null)} onChange={load} />}
      {showNew && <NewTaskModal users={users} onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />}
    </>
  )
}

function NewTaskModal({ users, onClose, onCreated }: { users: User[]; onClose: () => void; onCreated: () => void }) {
  const { user } = useAuth()
  const isEmployee = user?.role === 'employee'
  const [form, setForm] = useState<any>({ title: '', description: '', priority: 'Medium', assignee_id: '', due_date: '' })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!form.title) return
    setBusy(true)
    try { await api.post('/tasks', form); onCreated() } finally { setBusy(false) }
  }
  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3>{isEmployee ? 'New personal task' : 'New task'}</h3><button className="btn btn-ghost" onClick={onClose}>✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          {isEmployee && <div className="muted" style={{ fontSize: 12, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '8px 10px' }}>🔒 Private to you — your manager won't see it until you open it and click <strong>Submit as complete</strong>.</div>}
          <div><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus /></div>
          <div><label>Description</label><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div className={isEmployee ? 'grid grid-2' : 'grid grid-3'} style={{ gap: 10 }}>
            <div><label>Priority</label><select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>{['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}</select></div>
            {!isEmployee && <div><label>Assignee</label><select value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}><option value="">Unassigned</option>{users.filter(u => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>}
            <div><label>Due date</label><input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={busy || !form.title}>{busy ? <span className="spinner" /> : 'Create task'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
