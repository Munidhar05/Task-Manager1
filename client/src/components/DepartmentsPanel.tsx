import React, { useEffect, useState } from 'react'
import { api, User } from '../api'
import { useAuth } from '../auth'
import { Avatar, Badge, EmptyState, Ic, StatusBadge, PriorityBadge, dueLabel } from '../ui'
import TaskDrawer from './TaskDrawer'
import PickerWithAdd from './PickerWithAdd'
import { toast } from '../lib/toast'
import { confirmDialog } from '../lib/confirm'

// Administration → Departments. Until now a department was only a word in the
// user form: you could put someone in one, and that was all. This is the
// place to see them as groups — who is in each, what work sits with them — and
// to create, rename and delete them. Membership is edited here too (add a
// person, take one out), through the same user route the Edit-user form uses,
// so its rules (a manager cannot touch an admin account) hold here as well.
interface DeptRow { id: string; name: string; members: number; tasks: number; open_tasks: number }
interface Member { id: string; name: string; email: string; role: string; phone?: string | null; avatar_color?: string }
interface DeptTask {
  id: string; title: string; status: string; priority: string; due_date?: string | null
  assignee_id?: string | null; assignee_name?: string | null; assignee_color?: string | null
  via: 'tagged' | 'member'
}

export default function DepartmentsPanel() {
  const { user } = useAuth()
  const canManage = user?.role === 'manager' || user?.role === 'admin'
  const [depts, setDepts] = useState<DeptRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const load = async (): Promise<void> => {
    try {
      const rows: DeptRow[] = await api.get('/departments')
      setDepts(rows)
      setLoaded(true)
      // Keep the open department open; fall back to the first when it is gone.
      setSelected((s) => (s && rows.some((r) => r.id === s) ? s : rows[0]?.id || null))
    } catch (e: any) { toast.error(e.message) }
  }
  useEffect(() => { load() }, [])

  const create = async () => {
    const name = newName.replace(/\s+/g, ' ').trim()
    if (!name) return
    setCreating(true)
    try {
      const r = await api.post('/departments', { name })
      if (r.existed) toast.info(`${r.name} already exists — opened it`)
      else toast.success(`Added department ${r.name}`)
      setNewName('')
      await load()
      setSelected(r.id)
    } catch (e: any) { toast.error(e.message) } finally { setCreating(false) }
  }

  const current = depts.find((d) => d.id === selected) || null
  return (
    <>
      <div className="spread um-toolbar" style={{ marginBottom: 14 }}>
        <div className="muted">{depts.length} {depts.length === 1 ? 'department' : 'departments'}</div>
        {canManage && (
          <form className="row dept-new" onSubmit={(e) => { e.preventDefault(); create() }}>
            <input value={newName} maxLength={40} placeholder="New department name" aria-label="New department name" onChange={(e) => setNewName(e.target.value)} />
            <button type="submit" className="btn btn-primary btn-sm" disabled={creating || !newName.trim()}>{creating ? <span className="spinner" /> : '+ Add department'}</button>
          </form>
        )}
      </div>
      {loaded && depts.length === 0 ? (
        <EmptyState title="No departments yet" hint={canManage ? 'Add the first one above. People and tasks can then be grouped by it.' : 'A manager can add departments.'} />
      ) : (
        <div className="dept-layout">
          <div className="card dept-list" role="list">
            {depts.map((d) => (
              <button key={d.id} type="button" role="listitem" className={'dept-row' + (d.id === selected ? ' active' : '')} onClick={() => setSelected(d.id)} aria-current={d.id === selected}>
                <span className="dept-row-name">{d.name}</span>
                <span className="dept-row-meta muted">{d.members} {d.members === 1 ? 'person' : 'people'} · {d.open_tasks} open {d.open_tasks === 1 ? 'task' : 'tasks'}</span>
              </button>
            ))}
          </div>
          {current && (
            <DepartmentDetail key={current.id} dept={current} all={depts} canManage={canManage} meRole={user?.role || ''} onChanged={load}
              onDeleted={() => { setSelected(null); load() }} />
          )}
        </div>
      )}
    </>
  )
}

function DepartmentDetail({ dept, all, canManage, meRole, onChanged, onDeleted }: {
  dept: DeptRow; all: DeptRow[]; canManage: boolean; meRole: string; onChanged: () => Promise<void> | void; onDeleted: () => void
}) {
  const [members, setMembers] = useState<Member[] | null>(null)
  const [tasks, setTasks] = useState<DeptTask[] | null>(null)
  const [everyone, setEveryone] = useState<User[]>([])
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(dept.name)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [openTask, setOpenTask] = useState<string | null>(null)

  const reload = () => Promise.all([
    api.get(`/departments/${dept.id}/members`).then(setMembers),
    api.get(`/departments/${dept.id}/tasks`).then(setTasks),
  ]).catch((e: any) => toast.error(e.message))
  useEffect(() => { reload() }, [dept.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (canManage) api.get('/users').then(setEveryone).catch(() => {}) }, [canManage])

  const rename = async () => {
    const clean = name.replace(/\s+/g, ' ').trim()
    if (!clean || clean === dept.name) { setRenaming(false); setName(dept.name); return }
    setBusy(true)
    try {
      await api.patch(`/departments/${dept.id}`, { name: clean })
      toast.success(`Renamed to ${clean}`)
      setRenaming(false)
      await onChanged()
    } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }

  const remove = async () => {
    const people = dept.members, work = dept.tasks
    const ok = await confirmDialog({
      title: `Delete ${dept.name}?`,
      message: `${people} ${people === 1 ? 'person' : 'people'} and ${work} ${work === 1 ? 'task' : 'tasks'} will be left without a department. Nobody and nothing is removed, only the grouping.`,
      confirmText: 'Delete department', danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.del(`/departments/${dept.id}`)
      toast.success(`Deleted ${dept.name}`)
      onDeleted()
    } catch (e: any) { toast.error(e.message); setBusy(false) }
  }

  // Membership goes through the user route, like the Edit-user form. A person
  // belongs to one department, so adding someone who is already in another
  // MOVES them; the picker says where they are now and the toast says where
  // they came from, so that never happens by surprise.
  const deptNameOf = (u: User) => all.find((d) => d.id === u.department_id)?.name || null
  const setMembership = async (u: { id: string; name: string }, join: boolean) => {
    setBusy(true)
    try {
      const from = join ? deptNameOf(everyone.find((x) => x.id === u.id) || ({} as User)) : null
      await api.patch(`/users/${u.id}`, { department_id: join ? dept.id : null })
      toast.success(!join ? `${u.name} removed from ${dept.name}` : from ? `${u.name} moved from ${from} to ${dept.name}` : `${u.name} added to ${dept.name}`)
      setPick('')
      await Promise.all([reload(), onChanged()])
    } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }
  // A manager cannot move admin accounts (the server refuses), so do not offer them.
  const candidates = everyone
    .filter((u) => u.department_id !== dept.id && !(meRole === 'manager' && u.role === 'admin'))
    .map((u) => { const from = deptNameOf(u); return { id: u.id, name: from ? `${u.name} · ${from}` : u.name } })

  return (
    <div className="card dept-detail">
      <div className="card-head spread">
        {renaming ? (
          <form className="row" style={{ gap: 8, flex: 1 }} onSubmit={(e) => { e.preventDefault(); rename() }}>
            <input autoFocus value={name} maxLength={40} aria-label="Department name" onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(false); setName(dept.name) } }} style={{ maxWidth: 280 }} />
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>Save</button>
            <button type="button" className="btn btn-sm" onClick={() => { setRenaming(false); setName(dept.name) }}>Cancel</button>
          </form>
        ) : (
          <h3 className="row" style={{ gap: 8 }}>
            {dept.name}
            {canManage && <button type="button" className="btn btn-ghost btn-sm dept-rename" onClick={() => { setName(dept.name); setRenaming(true) }} aria-label={`Rename ${dept.name}`} title="Rename"><Ic name="edit" size={14} /></button>}
          </h3>
        )}
        {canManage && !renaming && (
          <button type="button" className="btn btn-sm row" style={{ gap: 6, color: 'var(--danger)' }} onClick={remove} disabled={busy}><Ic name="trash" size={14} /> Delete</button>
        )}
      </div>

      <div className="dept-section">
        <h4>People · {members ? members.length : '…'}</h4>
        {members && members.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Nobody is in this department yet.</div>}
        {members && members.length > 0 && (
          <div className="table-card-wrap">
            <table className="table-cards dept-table">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Phone</th>{canManage && <th></th>}</tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td className="cell-title"><span className="row"><Avatar name={m.name} color={m.avatar_color} size={26} /> {m.name}</span></td>
                    <td className="muted" data-label="Email">{m.email}</td>
                    <td data-label="Role"><Badge color="#ea580c" soft>{m.role}</Badge></td>
                    <td className="muted" data-label="Phone">{m.phone || '—'}</td>
                    {canManage && (
                      <td data-label="">
                        {!(meRole === 'manager' && m.role === 'admin') && (
                          <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }} disabled={busy} onClick={() => setMembership(m, false)} aria-label={`Remove ${m.name} from ${dept.name}`}>Remove</button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canManage && candidates.length > 0 && (
          <div className="dept-add-person">
            <PickerWithAdd value={pick} onChange={setPick} options={candidates} blankLabel="Add a person…" addLabel="" noun="person" canAdd={false} ariaLabel="Add a person to this department" />
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !pick} onClick={() => { const u = candidates.find((c) => c.id === pick); if (u) setMembership(u, true) }}>Add</button>
          </div>
        )}
      </div>

      <div className="dept-section">
        <h4>Tasks · {tasks ? tasks.length : '…'} <span className="muted" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>· tagged with this department or assigned to its people</span></h4>
        {tasks && tasks.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No tasks here yet.</div>}
        {tasks && tasks.length > 0 && (
          <div className="table-card-wrap">
            <table className="table-cards dept-table">
              <thead><tr><th>Task</th><th>Assignee</th><th>Status</th><th>Priority</th><th>Due</th></tr></thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id} className={'dept-task-row' + (t.status === 'Done' ? ' row-done' : '')} onClick={() => setOpenTask(t.id)}
                    tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpenTask(t.id) }} aria-label={`Open ${t.title}`}>
                    <td className="cell-title"><div style={{ fontWeight: 600 }}>{t.title}</div></td>
                    <td data-label="Assignee">{t.assignee_name ? <span className="row" style={{ gap: 6 }}><Avatar name={t.assignee_name} color={t.assignee_color || undefined} size={22} /> {t.assignee_name}</span> : <span className="muted">Unassigned</span>}</td>
                    <td data-label="Status"><StatusBadge s={t.status} /></td>
                    <td data-label="Priority"><PriorityBadge p={t.priority} /></td>
                    <td data-label="Due" className="muted">{t.due_date ? dueLabel(t) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {openTask && <TaskDrawer taskId={openTask} onClose={() => setOpenTask(null)} onChange={() => { reload(); onChanged() }} />}
    </div>
  )
}
