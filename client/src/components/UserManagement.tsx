import React, { useEffect, useRef, useState } from 'react'
import { api, User } from '../api'
import { useAuth } from '../auth'
import { Avatar, Badge } from '../ui'

// User-management UI for the Administration page. The manager is the org admin
// and manages employees and other managers.
export default function UserManagement() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [users, setUsers] = useState<User[]>([])
  const [depts, setDepts] = useState<any[]>([])
  const [editing, setEditing] = useState<any | null>(null) // 'new' | user | null
  const [importMsg, setImportMsg] = useState('')
  const [digest, setDigest] = useState<{ mode: string; hour: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const load = () => api.get('/users').then(setUsers)
  useEffect(() => {
    load()
    api.get('/users/meta/departments').then(setDepts)
    api.get('/digest/status').then(setDigest).catch(() => {})
  }, [])
  const deptName = (id?: string) => depts.find((d) => d.id === id)?.name || '—'

  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImportMsg('Importing…')
    try {
      const r = await api.upload('/users/import', file)
      setImportMsg(`✓ Imported: ${r.created} created, ${r.updated} updated${r.errors?.length ? ` · ${r.errors.length} skipped` : ''}`)
      load()
    } catch (err: any) { setImportMsg('✕ ' + err.message) }
    finally { if (fileRef.current) fileRef.current.value = '' }
  }

  const downloadTemplate = () => {
    const csv = 'name,email,phone,role,department,aliases,language,password\nMunidhar Reddy,munidhar@befach.com,+91 98765 43210,employee,Engineering,"Muni,Munidhar",en,password123\n'
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = 'users-template.csv'; a.click(); URL.revokeObjectURL(url)
  }

  const sendDigestNow = async () => {
    if (!window.confirm('Send the daily task digest now to everyone?')) return
    setImportMsg('Sending digest…')
    try {
      const r = await api.post('/digest/send-now')
      const emailNote = r.emails ? `, ${r.emails} emails` : ''
      setImportMsg(`✓ Digest → Cliq: ${r.cliq}${emailNote}${r.cliq === 'preview' ? ' — check server console' : ''}`)
    } catch (e: any) { setImportMsg('✕ ' + e.message) }
  }

  // A manager may edit/remove employees and other managers, but not admin accounts.
  const canEdit = (u: User) => isAdmin || u.role !== 'admin'

  const remove = async (u: User) => {
    if (u.id === user?.id) { setImportMsg('✕ You cannot remove your own account'); return }
    if (!window.confirm(`Remove ${u.name}? This permanently deletes the account and unassigns their tasks.`)) return
    try {
      await api.del('/users/' + u.id)
      setImportMsg(`✓ Removed ${u.name}`)
      load()
    } catch (e: any) { setImportMsg('✕ ' + e.message) }
  }

  return (
    <>
      <div className="spread um-toolbar" style={{ marginBottom: 14 }}>
        <div className="muted">{users.length} users {digest && <span>· daily Cliq digest {digest.hour}:00 ({digest.mode})</span>}</div>
        <div className="row wrap" style={{ gap: 8 }}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={onImport} />
          <button className="btn btn-sm" onClick={downloadTemplate}>⬇ Template</button>
          <button className="btn btn-sm" onClick={() => fileRef.current?.click()}>⬆ Import Excel/CSV</button>
          <button className="btn btn-sm" onClick={sendDigestNow}>✉ Send digest now</button>
          <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>+ Add user</button>
        </div>
      </div>
      {importMsg && <div className="muted" style={{ marginBottom: 10, fontSize: 13 }}>{importMsg}</div>}
      <div className="card table-card-wrap">
        <table className="table-cards">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Department</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="cell-title"><span className="row"><Avatar name={u.name} color={u.avatar_color} size={26} /> {u.name}</span></td>
                <td className="muted" data-label="Email">{u.email}</td>
                <td className="muted" data-label="Phone">{u.phone || '—'}</td>
                <td data-label="Role"><Badge color="#c5560f" soft>{u.role}</Badge></td>
                <td data-label="Department">{deptName(u.department_id)}</td>
                <td data-label="">
                  {canEdit(u) && (
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn btn-sm" onClick={() => setEditing(u)}>✎ Edit</button>
                      {u.id !== user?.id && (
                        <button className="btn btn-sm" style={{ color: '#ef4444' }} onClick={() => remove(u)}>🗑 Remove</button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <UserForm user={editing === 'new' ? null : editing} depts={depts} isAdmin={isAdmin} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load() }} />}
    </>
  )
}

function UserForm({ user, depts, isAdmin, onClose, onDone }: { user: any | null; depts: any[]; isAdmin: boolean; onClose: () => void; onDone: () => void }) {
  const isEdit = !!user
  const [f, setF] = useState<any>({
    name: user?.name || '', email: user?.email || '', phone: user?.phone || '', password: isEdit ? '' : 'password123',
    role: user?.role || 'employee', department_id: user?.department_id || '', aliases: user?.aliases || '',
    preferred_language: user?.preferred_language || 'en',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Managers can assign employee/manager only; admins can assign any role.
  const roleOptions = isAdmin ? ['employee', 'manager', 'admin'] : ['employee', 'manager']
  const save = async () => {
    setErr('')
    // Only @gmail.com or @befach.com addresses are accepted.
    const email = (f.email || '').trim().toLowerCase()
    if (!/^[^\s@]+@(gmail\.com|befach\.com)$/.test(email)) {
      setErr('Email must be a @gmail.com or @befach.com address'); return
    }
    // Phone must be exactly 10 digits.
    const phone = (f.phone || '').replace(/\D/g, '')
    if (phone.length !== 10) { setErr('Phone number must be exactly 10 digits'); return }
    setBusy(true)
    try {
      if (isEdit) {
        const body: any = { ...f, email, phone }
        if (!body.password) delete body.password // don't overwrite password if left blank
        await api.patch('/users/' + user.id, body)
      } else {
        await api.post('/users', { ...f, email, phone })
      }
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3>{isEdit ? 'Edit user' : 'Add user'}</h3><button className="btn btn-ghost" onClick={onClose}>✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          <div className="grid grid-3" style={{ gap: 10 }}>
            <div><label>Name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
            <div><label>Email</label><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
            <div><label>Phone (10 digits)</label><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={10} inputMode="numeric" placeholder="9876543210" /></div>
          </div>
          <div className="grid grid-2" style={{ gap: 10 }}>
            <div><label>Role</label><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roleOptions.map((r) => <option key={r}>{r}</option>)}</select></div>
            <div><label>Department</label><select value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}><option value="">—</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
          </div>
          <div><label>Password {isEdit && <span className="muted" style={{ fontWeight: 400 }}>(leave blank to keep current)</span>}</label><input value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          {err && <div style={{ color: '#ef4444', fontSize: 13 }}>{err}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={busy || !f.name || !f.email}>{busy ? <span className="spinner" /> : isEdit ? 'Save changes' : 'Create user'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
