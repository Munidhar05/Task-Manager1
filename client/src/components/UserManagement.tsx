import React, { useEffect, useRef, useState } from 'react'
import { api, User } from '../api'
import { useAuth } from '../auth'
import { Avatar, Badge, Ic } from '../ui'
import { confirmDialog } from '../lib/confirm'

// User-management UI for the Administration page. The manager is the org admin
// and manages employees and other managers.
export default function UserManagement() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [users, setUsers] = useState<User[]>([])
  const [depts, setDepts] = useState<any[]>([])
  const [invites, setInvites] = useState<any[]>([])
  const [editing, setEditing] = useState<any | null>(null) // 'new' | user | null
  const [inviting, setInviting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const [digest, setDigest] = useState<{ mode: string; hour: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const load = () => api.get('/users').then(setUsers)
  const loadInvites = () => api.get('/invites').then(setInvites).catch(() => {})
  useEffect(() => {
    load()
    loadInvites()
    api.get('/users/meta/departments').then(setDepts)
    api.get('/digest/status').then(setDigest).catch(() => {})
  }, [])
  const deptName = (id?: string) => depts.find((d) => d.id === id)?.name || '—'

  const revokeInvite = async (inv: any) => {
    if (!(await confirmDialog({ title: 'Revoke invitation', message: `Revoke the invitation for ${inv.email}?`, confirmText: 'Revoke', danger: true }))) return
    try { await api.del('/invites/' + inv.id); loadInvites() }
    catch (e: any) { setImportMsg('✕ ' + e.message) }
  }

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
    if (!(await confirmDialog({ title: 'Send digest now', message: 'Send the daily task digest now to everyone?', confirmText: 'Send' }))) return
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
    if (!(await confirmDialog({ title: 'Remove user', message: `Remove ${u.name}? This permanently deletes the account and unassigns their tasks.`, confirmText: 'Remove', danger: true }))) return
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
          <button className="btn btn-sm row" style={{ gap: 6 }} onClick={downloadTemplate}><Ic name="download" size={14} /> Template</button>
          <button className="btn btn-sm row" style={{ gap: 6 }} onClick={() => fileRef.current?.click()}><Ic name="upload" size={14} /> Import Excel/CSV</button>
          <button className="btn btn-sm row" style={{ gap: 6 }} onClick={sendDigestNow}><Ic name="mail" size={14} /> Send digest now</button>
          <button className="btn btn-sm row" style={{ gap: 6 }} onClick={() => setInviting(true)}><Ic name="mail" size={14} /> Invite teammate</button>
          <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>+ Add user</button>
        </div>
      </div>
      {importMsg && <div className="muted" style={{ marginBottom: 10, fontSize: 13 }}>{importMsg}</div>}
      {invites.length > 0 && (
        <div className="card" style={{ marginBottom: 12, padding: '10px 14px' }}>
          <div className="muted" style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Pending invitations ({invites.length})</div>
          {invites.map((inv) => (
            <div key={inv.id} className="row spread" style={{ padding: '5px 0', borderTop: '1px solid #f1f1f1' }}>
              <span style={{ fontSize: 13 }}>{inv.email} <span className="muted">· {inv.role}</span></span>
              <button className="btn btn-sm" style={{ color: '#ef4444' }} onClick={() => revokeInvite(inv)}>Revoke</button>
            </div>
          ))}
        </div>
      )}
      <div className="card table-card-wrap">
        <table className="table-cards">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Department</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="cell-title"><span className="row"><Avatar name={u.name} color={u.avatar_color} size={26} /> {u.name}</span></td>
                <td className="muted" data-label="Email">{u.email}</td>
                <td className="muted" data-label="Phone">{u.phone || '—'}</td>
                <td data-label="Role"><Badge color="#f2622e" soft>{u.role}</Badge></td>
                <td data-label="Department">{deptName(u.department_id)}</td>
                <td data-label="">
                  {canEdit(u) && (
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn btn-sm row" style={{ gap: 6 }} onClick={() => setEditing(u)}><Ic name="edit" size={14} /> Edit</button>
                      {u.id !== user?.id && (
                        <button className="btn btn-sm row" style={{ gap: 6, color: 'var(--danger)' }} onClick={() => remove(u)}><Ic name="trash" size={14} /> Remove</button>
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
      {inviting && <InviteForm depts={depts} isAdmin={isAdmin} onClose={() => setInviting(false)} onDone={loadInvites} />}
    </>
  )
}

// Invite a teammate by email. Shows the resulting accept-link so the manager can
// copy/share it directly — essential when SMTP isn't configured (preview mode).
function InviteForm({ depts, isAdmin, onClose, onDone }: { depts: any[]; isAdmin: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>({ email: '', role: 'employee', department_id: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<{ link: string; emailed: boolean } | null>(null)
  const [copied, setCopied] = useState(false)
  const roleOptions = isAdmin ? ['employee', 'manager', 'admin'] : ['employee', 'manager']

  const send = async () => {
    setErr('')
    const email = (f.email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setErr('Please enter a valid email address.'); return }
    setBusy(true)
    try {
      const r = await api.post('/invites', { email, role: f.role, department_id: f.department_id || null })
      setResult({ link: r.link, emailed: r.emailed })
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(result!.link); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3>Invite teammate</h3><button className="btn btn-ghost" onClick={onClose}>✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          {result ? (
            <>
              <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.5, background: result.emailed ? '#ecfdf5' : '#fffbeb', border: `1px solid ${result.emailed ? '#a7f3d0' : '#fde68a'}`, borderRadius: 8, padding: '12px 14px' }}>
                {result.emailed
                  ? 'Invitation emailed. They can also use the link below.'
                  : 'Invitation created. Email isn’t configured, so copy this link and share it directly:'}
              </div>
              <div className="row" style={{ gap: 8 }}>
                <input readOnly value={result.link} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
                <button className="btn btn-sm btn-primary" onClick={copyLink}>{copied ? 'Copied!' : 'Copy'}</button>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn" onClick={onClose}>Done</button>
              </div>
            </>
          ) : (
            <>
              <div><label>Email</label><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="teammate@company.com" type="email" autoFocus /></div>
              <div className="grid grid-2" style={{ gap: 10 }}>
                <div><label>Role</label><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roleOptions.map((r) => <option key={r}>{r}</option>)}</select></div>
                <div><label>Department</label><select value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}><option value="">—</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
              </div>
              {err && <div style={{ color: '#ef4444', fontSize: 13 }}>{err}</div>}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" onClick={send} disabled={busy || !f.email}>{busy ? <span className="spinner" /> : 'Send invite'}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function UserForm({ user, depts, isAdmin, onClose, onDone }: { user: any | null; depts: any[]; isAdmin: boolean; onClose: () => void; onDone: () => void }) {
  const isEdit = !!user
  const [f, setF] = useState<any>({
    // No prefilled default password — shipping a guessable 'password123' that
    // renders in clear text was a real account-security foot-gun.
    name: user?.name || '', email: user?.email || '', phone: user?.phone || '', password: '',
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
        <div className="card-head spread"><h3>{isEdit ? 'Edit user' : 'Add user'}</h3><button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button></div>
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
          <div><label>Password {isEdit && <span className="muted" style={{ fontWeight: 400 }}>(leave blank to keep current)</span>}</label><input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          {err && <div style={{ color: '#ef4444', fontSize: 13 }} role="alert">{err}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={busy || !f.name || !f.email || (!isEdit && !f.password)}>{busy ? <span className="spinner" /> : isEdit ? 'Save changes' : 'Create user'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
