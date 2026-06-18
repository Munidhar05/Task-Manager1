import React, { useEffect, useState } from 'react'
import { api, Task, User } from '../api'
import { useAuth } from '../auth'
import { PriorityBadge, StatusBadge, Avatar, ConfidenceTag, dueLabel, fmtDateTime } from '../ui'

const STATUSES = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened']

export default function TaskDrawer({ taskId, onClose, onChange }: { taskId: string; onClose: () => void; onChange?: () => void }) {
  const { user } = useAuth()
  const [task, setTask] = useState<Task | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingAssignee, setPendingAssignee] = useState('')
  // A status the user has picked but not yet confirmed — applied only on "Accept".
  const [pendingStatus, setPendingStatus] = useState('')
  // Split & share: when open, `parts` holds the rows (each = a piece + a person).
  const [showSplit, setShowSplit] = useState(false)
  const [parts, setParts] = useState<{ title: string; assignee_id: string }[]>([])
  const updatePart = (i: number, patch: Partial<{ title: string; assignee_id: string }>) =>
    setParts((ps) => ps.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))

  const load = () => api.get(`/tasks/${taskId}`).then(setTask)
  useEffect(() => { load(); api.get('/users').then(setUsers) }, [taskId])
  // Keep the member picker in sync whenever the task's current owner changes.
  useEffect(() => { setPendingAssignee(task?.assignee?.id || '') }, [task?.assignee?.id])
  // Reset the pending status whenever the saved status changes (incl. after Accept).
  useEffect(() => { setPendingStatus(task?.status || '') }, [task?.status])

  const mutate = async (fn: () => Promise<any>) => {
    setBusy(true)
    try { const t = await fn(); if (t?.id) setTask(t); else await load(); onChange?.() }
    finally { setBusy(false) }
  }
  const setStatus = (status: string) => mutate(() => api.post(`/tasks/${taskId}/status`, { status }))
  const setAssignee = (assignee_id: string) => mutate(() => api.patch(`/tasks/${taskId}`, { assignee_id: assignee_id || null }))
  const setPriority = (priority: string) => mutate(() => api.patch(`/tasks/${taskId}`, { priority }))
  const setProgress = (progress: number) => mutate(() => api.patch(`/tasks/${taskId}`, { progress }))
  const approve = (decision: string) => mutate(() => api.post(`/tasks/${taskId}/approve`, { decision }))
  const addComment = async () => { if (!comment.trim()) return; await mutate(() => api.post(`/tasks/${taskId}/comments`, { body: comment })); setComment('') }
  const openSplit = () => { setParts([{ title: task?.title || '', assignee_id: '' }]); setShowSplit(true) }
  const doSplit = async () => {
    const valid = parts.filter((p) => p.title.trim() && p.assignee_id)
    if (!valid.length) return
    await mutate(() => api.post(`/tasks/${taskId}/split`, { parts: valid }))
    setShowSplit(false)
  }
  const del = async () => {
    if (!window.confirm('Delete this task? This cannot be undone.')) return
    setBusy(true)
    try { await api.del(`/tasks/${taskId}`); onChange?.(); onClose() }
    finally { setBusy(false) }
  }

  if (!task) return (
    <div className="overlay" onClick={onClose}><div className="drawer" onClick={(e) => e.stopPropagation()}><div className="card-pad"><span className="spinner" /></div></div></div>
  )
  const isManager = user?.role !== 'employee'
  // Managers can delete anything; an employee can delete only their own private draft.
  const canDelete = isManager || (task.visible_to_manager === 0 && task.assignee?.id === user?.id)
  // The task owner (or a manager) can split a top-level task into shared parts.
  const canSplit = (isManager || task.assignee?.id === user?.id) && !task.parent_task_id
  const subs = task.subtasks || []
  const subDone = subs.filter((s: any) => s.status === 'Done').length
  const subPct = subs.length ? Math.round((subDone / subs.length) * 100) : 0
  const lookupUser = (uid?: string | null) => users.find((u) => u.id === uid)

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread">
          <div className="row">
            <PriorityBadge p={task.priority} /><StatusBadge s={task.status} />
            {task.visible_to_manager === 0 && <span className="badge" style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>🔒 Private</span>}
          </div>
          <div className="row">
            {canDelete && <button className="btn btn-sm btn-danger" disabled={busy} onClick={del} title="Delete task">🗑 Delete</button>}
            <button className="btn btn-ghost" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="card-pad">
          <h2 style={{ fontSize: 19 }}>{task.title}</h2>
          <ConfidenceTag c={task.ownership_confidence} />
          {task.description && task.description !== task.title && <p className="muted" style={{ marginTop: 8 }}>{task.description}</p>}

          {task.source_quote && (
            <div style={{ background: '#f8fafc', borderLeft: '3px solid var(--primary)', padding: '8px 12px', borderRadius: 6, margin: '12px 0', fontSize: 13 }}>
              <div className="muted" style={{ fontSize: 11, fontWeight: 700, marginBottom: 2 }}>FROM MEETING (original language)</div>
              “{task.source_quote}”
            </div>
          )}

          <div className="grid grid-2" style={{ gap: 14, margin: '16px 0' }}>
            <div>
              <label>Assignee</label>
              {isManager ? (
                <div className="row" style={{ gap: 8 }}>
                  <select value={pendingAssignee} disabled={busy} onChange={(e) => setPendingAssignee(e.target.value)} style={{ flex: 1 }}>
                    <option value="">Select member…</option>
                    {users.filter(u => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={busy || pendingAssignee === (task.assignee?.id || '')}
                    onClick={() => setAssignee(pendingAssignee)}
                  >
                    {busy ? <span className="spinner" /> : pendingAssignee ? 'Assign' : 'Unassign'}
                  </button>
                </div>
              ) : (
                <div className="row">{task.assignee ? <><Avatar name={task.assignee.name} color={task.assignee.avatar_color} size={22} /> {task.assignee.name}</> : '—'}</div>
              )}
              {task.assignee_name_raw && !task.assignee && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Heard as: “{task.assignee_name_raw}”</div>}
            </div>
            <div>
              <label>Priority</label>
              {isManager ? (
                <select value={task.priority} onChange={(e) => setPriority(e.target.value)}>
                  {['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}
                </select>
              ) : <PriorityBadge p={task.priority} />}
            </div>
            <div>
              <label>Assigned by</label>
              <div className="row">{task.assignedBy ? <><Avatar name={task.assignedBy.name} size={22} /> {task.assignedBy.name}</> : '—'}</div>
            </div>
            <div>
              <label>Due date</label>
              <div>{dueLabel(task)}</div>
            </div>
          </div>

          <div style={{ margin: '16px 0' }}>
            <label>Timeline</label>
            <div style={{ fontSize: 13, display: 'grid', gap: 6 }}>
              <div className="spread"><span className="muted">🆕 Created</span><span>{fmtDateTime(task.created_at)}</span></div>
              <div className="spread"><span className="muted">📌 Assigned</span><span>{fmtDateTime(task.assigned_at)}</span></div>
              {task.submitted_at && <div className="spread"><span className="muted">📩 Submitted</span><span>{fmtDateTime(task.submitted_at)}</span></div>}
              <div className="spread"><span className="muted">✅ Completed</span><span style={{ color: task.completed_at ? '#047857' : 'inherit' }}>{fmtDateTime(task.completed_at)}</span></div>
            </div>
          </div>

          <div style={{ margin: '14px 0' }}>
            <label>Progress — {task.progress}%</label>
            <input type="range" min={0} max={100} step={10} value={task.progress} onChange={(e) => setProgress(Number(e.target.value))} />
          </div>

          <div style={{ margin: '16px 0' }}>
            <label>Status</label>
            {isManager ? (
              <>
                <div className="row wrap">
                  {STATUSES.map((s) => (
                    <button key={s} className={'btn btn-sm' + (pendingStatus === s ? ' btn-primary' : '')} disabled={busy} onClick={() => setPendingStatus(s)}>{s}</button>
                  ))}
                </div>
                {pendingStatus !== task.status && (
                  <div className="row" style={{ marginTop: 10 }}>
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setStatus(pendingStatus)}>
                      {busy ? <span className="spinner" /> : `✓ Accept change → ${pendingStatus}`}
                    </button>
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPendingStatus(task.status)}>Cancel</button>
                  </div>
                )}
              </>
            ) : task.status === 'Done' ? (
              <div className="card-pad" style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10, color: '#047857' }}>
                ✓ Completed — approved by your manager.
              </div>
            ) : task.approval_status === 'pending' ? (
              <div className="card-pad" style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10 }}>
                <strong>🕓 Submitted for review</strong>
                <p className="muted" style={{ margin: '4px 0 10px' }}>Waiting for your manager to approve. You'll get it back if changes are needed.</p>
                <button className="btn btn-sm" disabled={busy} onClick={() => setStatus('In Progress')}>↩ Withdraw &amp; keep working</button>
              </div>
            ) : (
              <>
                <div className="row wrap">
                  {['To Do', 'In Progress', 'Blocked'].map((s) => (
                    <button key={s} className={'btn btn-sm' + (pendingStatus === s ? ' btn-primary' : '')} disabled={busy} onClick={() => setPendingStatus(s)}>{s}</button>
                  ))}
                </div>
                {pendingStatus !== task.status && ['To Do', 'In Progress', 'Blocked'].includes(pendingStatus) && (
                  <div className="row" style={{ marginTop: 10 }}>
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setStatus(pendingStatus)}>
                      {busy ? <span className="spinner" /> : `✓ Accept change → ${pendingStatus}`}
                    </button>
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPendingStatus(task.status)}>Cancel</button>
                  </div>
                )}
                <button className="btn btn-primary" style={{ marginTop: 10, width: '100%' }} disabled={busy} onClick={() => setStatus('In Review')}>
                  {busy ? <span className="spinner" /> : '✓ Submit as complete'}
                </button>
                <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>Sends this task to your manager for approval.</p>
              </>
            )}
          </div>

          {!task.parent_task_id && (subs.length > 0 || canSplit) && (
            <div style={{ margin: '16px 0' }}>
              <div className="spread">
                <label style={{ margin: 0 }}>Shared parts{subs.length ? ` — ${subDone}/${subs.length} done` : ''}</label>
                {canSplit && <button className="btn btn-sm" disabled={busy} onClick={openSplit}>✂ Split &amp; share</button>}
              </div>
              {subs.length > 0 ? (
                <>
                  <div className="bar-track" style={{ margin: '8px 0' }}><div className="bar-fill" style={{ width: subPct + '%', background: '#10b981' }} /></div>
                  <div style={{ display: 'grid', gap: 2 }}>
                    {subs.map((s: any) => {
                      const u = lookupUser(s.assignee_id)
                      return (
                        <div key={s.id} className="spread" style={{ fontSize: 13, padding: '7px 0', borderBottom: '1px solid #f1f5f9' }}>
                          <span>{s.status === 'Done' ? '✅' : '•'} {s.title}</span>
                          <span className="row" style={{ gap: 6 }}>
                            {u && <Avatar name={u.name} color={u.avatar_color} size={18} />}
                            <span className="muted">{u?.name || '—'}</span>
                            <StatusBadge s={s.status} />
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </>
              ) : (
                <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Break this task into parts and share them with colleagues. You stay responsible — it completes automatically when all parts are done.</p>
              )}
            </div>
          )}

          {isManager && task.approval_status === 'pending' && (
            <div className="card-pad" style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, marginBottom: 16 }}>
              <strong>Approval requested</strong>
              <p className="muted" style={{ margin: '4px 0 10px' }}>This task is in review and awaiting your approval.</p>
              <div className="row">
                <button className="btn btn-primary btn-sm" onClick={() => approve('approved')}>✓ Approve & close</button>
                <button className="btn btn-sm btn-danger" onClick={() => approve('rejected')}>Reopen</button>
              </div>
            </div>
          )}

          {task.dependencies && task.dependencies.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <label>Depends on</label>
              {task.dependencies.map((d: any) => <div key={d.id} className="row" style={{ fontSize: 13 }}>↳ {d.title} <StatusBadge s={d.status} /></div>)}
            </div>
          )}

          <div>
            <label>Comments ({task.comments?.length || 0})</label>
            {task.comments?.map((c: any) => (
              <div className="comment" key={c.id}>
                <Avatar name={c.user_name} color={c.avatar_color} size={28} />
                <div className="body">
                  <div className="spread"><strong style={{ fontSize: 12.5 }}>{c.user_name}</strong><span className="muted" style={{ fontSize: 11 }}>{new Date(c.created_at).toLocaleString()}</span></div>
                  <div style={{ fontSize: 13 }}>{c.body}</div>
                </div>
              </div>
            ))}
            <div className="row" style={{ marginTop: 10 }}>
              <input placeholder="Add a comment…" value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addComment()} />
              <button className="btn btn-primary" onClick={addComment} disabled={busy}>Post</button>
            </div>
          </div>
        </div>

        {showSplit && (
          <div className="modal-center" onClick={() => setShowSplit(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="card-head spread"><h3 style={{ fontSize: 16 }}>Split &amp; share</h3><button className="btn btn-ghost" onClick={() => setShowSplit(false)}>✕</button></div>
              <div className="card-pad grid" style={{ gap: 10 }}>
                <p className="muted" style={{ fontSize: 12 }}>Add each part and pick who does it. Parts inherit this task's due date &amp; priority. You stay responsible — it completes when all parts are done.</p>
                {parts.map((p, i) => (
                  <div className="row" key={i} style={{ gap: 8 }}>
                    <input style={{ flex: 1 }} placeholder={`Part ${i + 1} — what needs doing`} value={p.title} onChange={(e) => updatePart(i, { title: e.target.value })} autoFocus={i === 0} />
                    <select value={p.assignee_id} onChange={(e) => updatePart(i, { assignee_id: e.target.value })} style={{ maxWidth: 160 }}>
                      <option value="">Who…</option>
                      {users.filter((u) => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}{u.id === user?.id ? ' (me)' : ''}</option>)}
                    </select>
                    {parts.length > 1 && <button className="btn btn-ghost btn-sm" title="Remove" onClick={() => setParts((ps) => ps.filter((_, idx) => idx !== i))}>✕</button>}
                  </div>
                ))}
                <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setParts((ps) => [...ps, { title: '', assignee_id: '' }])}>+ Add another part</button>
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn" onClick={() => setShowSplit(false)}>Cancel</button>
                  <button className="btn btn-primary" disabled={busy || !parts.some((p) => p.title.trim() && p.assignee_id)} onClick={doSplit}>{busy ? <span className="spinner" /> : '✉ Share parts'}</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
