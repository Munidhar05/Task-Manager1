import React, { useEffect, useRef, useState } from 'react'
import { api, Task, User, Attachment, taskAttachmentUrl } from '../api'
import { useAuth } from '../auth'
import { PriorityBadge, StatusBadge, CategoryBadge, CATEGORY_OPTIONS, Avatar, ConfidenceTag, Evidence, Ic, dueLabel, fmtDateTime, fmtBytes, PRIORITY_COLORS } from '../ui'
import { confirmDialog } from '../lib/confirm'
import { toast } from '../lib/toast'
import { useDialog } from '../lib/useDialog'
import { useSurface } from '../voice/uiRegistry'
import { typeInto, pickValue, flashPress, settle, findVaEl } from '../voice/uiController'

const STATUSES = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened']

// onChange receives the updated task when the mutation returned one, so list pages
// can patch that row in place instead of re-fetching everything; called with no
// argument (→ caller should re-fetch) after deletes/uploads.
export default function TaskDrawer({ taskId, onClose, onChange }: { taskId: string; onClose: () => void; onChange?: (updated?: Task) => void }) {
  const { user } = useAuth()
  const drawerRef = useDialog<HTMLDivElement>(onClose)
  const [task, setTask] = useState<Task | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingAssignee, setPendingAssignee] = useState('')
  // A status the user has picked but not yet confirmed — applied only on "Accept".
  const [pendingStatus, setPendingStatus] = useState('')
  // Inline edit of the task's core details (title, description, due date).
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({ title: '', description: '', due_date: '' })
  // Split & share: when open, `parts` holds the rows (each = a piece + a person).
  const [showSplit, setShowSplit] = useState(false)
  const [parts, setParts] = useState<{ title: string; assignee_id: string }[]>([])
  const updatePart = (i: number, patch: Partial<{ title: string; assignee_id: string }>) =>
    setParts((ps) => ps.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))

  // Progress slider: while the user is dragging, `dragProgress` owns the value so a
  // re-render (or a save still in flight) can't yank the thumb back to the stale
  // server number. null = nobody is dragging, the saved value is the truth.
  const [dragProgress, setDragProgress] = useState<number | null>(null)
  const draggingRef = useRef(false)                    // pointer is down on the slider
  const pendingProgress = useRef<number | null>(null)  // value still to be saved
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Who changed what, newest first — read back from the audit trail the server
  // has always written. Fetched alongside the task and refreshed after every
  // mutation, so an edit shows its author the moment it is made.
  type Edit = { actor_id: string; actor_name: string; avatar_color?: string; fields: string[]; reassigned: boolean; at: string }
  const [edits, setEdits] = useState<Edit[]>([])
  const loadEdits = () => api.get(`/tasks/${taskId}/history`).then(setEdits).catch(() => setEdits([]))

  const [loadErr, setLoadErr] = useState(false)
  const load = () => { setLoadErr(false); loadEdits(); return api.get(`/tasks/${taskId}`).then(setTask).catch(() => setLoadErr(true)) }
  useEffect(() => {
    setEditing(false); load(); api.get('/users').then(setUsers).catch(() => {})
    setDragProgress(null); pendingProgress.current = null; draggingRef.current = false
  }, [taskId])
  useEffect(() => () => { if (progressTimer.current) clearTimeout(progressTimer.current) }, [])
  // Keep the member picker in sync whenever the task's current owner changes.
  useEffect(() => { setPendingAssignee(task?.assignee?.id || '') }, [task?.assignee?.id])
  // Reset the pending status whenever the saved status changes (incl. after Accept).
  useEffect(() => { setPendingStatus(task?.status || '') }, [task?.status])

  const mutate = async (fn: () => Promise<any>) => {
    setBusy(true)
    try { const t = await fn(); if (t?.id) setTask(t); else await load(); await loadEdits(); onChange?.(t?.id ? t : undefined) }
    finally { setBusy(false) }
  }
  const setStatus = (status: string) => mutate(() => api.post(`/tasks/${taskId}/status`, { status }))
  const setAssignee = (assignee_id: string) => mutate(() => api.patch(`/tasks/${taskId}`, { assignee_id: assignee_id || null }))
  const setPriority = (priority: string) => mutate(() => api.patch(`/tasks/${taskId}`, { priority }))
  const setCategory = (category: string) => mutate(() => api.patch(`/tasks/${taskId}`, { category: category || null }))
  // Attach more reference files to an existing task (uploaded immediately).
  const attachInput = useRef<HTMLInputElement>(null)
  const ATTACH_MAX = 50 * 1024 * 1024
  const uploadFiles = async (list: FileList | null) => {
    if (!list) return
    const picked = Array.from(list).filter((f) => (/^(image|video)\//.test(f.type) || f.type === 'application/pdf') && f.size <= ATTACH_MAX)
    if (picked.length < list.length) toast.error('Some files were skipped — only images, PDFs and videos under 50 MB are allowed.')
    setBusy(true)
    try { for (const f of picked) { try { await api.upload(`/tasks/${taskId}/attachments`, f) } catch { toast.error(`Couldn't attach ${f.name}`) } } await load(); onChange?.() }
    finally { setBusy(false); if (attachInput.current) attachInput.current.value = '' }
  }
  // Deleting an attachment is irreversible — confirm it like the task delete.
  const removeAttachment = async (a: Attachment) => {
    if (!(await confirmDialog({ title: 'Remove attachment', message: `Remove "${a.filename}"? This cannot be undone.`, confirmText: 'Remove', danger: true }))) return
    mutate(() => api.del(`/tasks/attachments/${a.id}`))
  }
  const setProgress = (progress: number) => mutate(() => api.patch(`/tasks/${taskId}`, { progress }))
  // Save once, when the user lets go — not once per pixel of travel. Dragging only
  // moves the local value, so the thumb stays exactly where the finger left it.
  const commitProgress = async () => {
    if (progressTimer.current) { clearTimeout(progressTimer.current); progressTimer.current = null }
    draggingRef.current = false
    const value = pendingProgress.current
    pendingProgress.current = null
    // Hand the slider back to the saved value only if no newer drag has started.
    const release = () => { if (pendingProgress.current === null && !draggingRef.current) setDragProgress(null) }
    if (value === null) return
    if (value === task?.progress) { release(); return }
    try { await setProgress(value) } catch { toast.error("Couldn't save the progress — try again.") } finally { release() }
  }
  const onProgressInput = (value: number) => {
    setDragProgress(value)
    pendingProgress.current = value
    // Keyboard and assistive changes never send a pointer release — save shortly
    // after the last one instead. While a pointer is down, the release saves.
    if (progressTimer.current) clearTimeout(progressTimer.current)
    if (!draggingRef.current) progressTimer.current = setTimeout(commitProgress, 400)
  }
  const approve = (decision: string) => mutate(() => api.post(`/tasks/${taskId}/approve`, { decision }))
  const addComment = async () => { if (!comment.trim()) return; await mutate(() => api.post(`/tasks/${taskId}/comments`, { body: comment })); setComment('') }

  // ---- Agent surface -------------------------------------------------------
  // Every capability drives the drawer's OWN handlers, so a voice edit and a hand
  // edit are the same code path — same optimistic update, same onChange back to the
  // list, same toast on failure. The flashPress calls only render the click; if a
  // control is not on screen for this role, the press is a no-op and the change
  // still happens correctly.
  useSurface('task.drawer', {
    id: () => taskId,
    changeStatus: async ({ status }: { status: string }) => {
      // Two real presses, as a person would: pick the status, then accept it.
      await flashPress(findVaEl(`task.drawer.status.${status}`))
      setPendingStatus(status)
      await settle()
      await flashPress(findVaEl('task.drawer.acceptStatus'))
      await setStatus(status)
    },
    assignTo: async ({ id }: { id: string }) => {
      await pickValue(findVaEl('task.drawer.assignee'), id, setPendingAssignee)
      await settle()
      await flashPress(findVaEl('task.drawer.assign'))
      await setAssignee(id)
    },
    comment: async ({ body }: { body: string }) => {
      await typeInto(findVaEl('task.drawer.comment'), body, setComment)
      await settle()          // addComment reads `comment` from state, not an arg
      await flashPress(findVaEl('task.drawer.postComment'))
      await addComment()
    },
  }, !!task)
  // Open the inline editor, seeded from the current task.
  const startEdit = () => {
    if (!task) return
    setEditForm({ title: task.title || '', description: task.description || '', due_date: task.due_date || '' })
    setEditing(true)
  }
  // Persist the edited details. Clearing due_date_raw makes the picked date authoritative.
  const saveEdit = async () => {
    const title = editForm.title.trim()
    if (!title) return
    await mutate(() => api.patch(`/tasks/${taskId}`, {
      title,
      description: editForm.description.trim(),
      due_date: editForm.due_date || null,
      due_date_raw: null,
    }))
    setEditing(false)
  }
  const openSplit = () => { setParts([{ title: task?.title || '', assignee_id: '' }]); setShowSplit(true) }
  const doSplit = async () => {
    const valid = parts.filter((p) => p.title.trim() && p.assignee_id)
    if (!valid.length) return
    await mutate(() => api.post(`/tasks/${taskId}/split`, { parts: valid }))
    // The response is only the parent, but the split CREATED new tasks — signal a
    // no-payload change so list pages re-fetch instead of just patching the parent.
    onChange?.()
    setShowSplit(false)
  }
  const del = async () => {
    if (!(await confirmDialog({ title: 'Delete task', message: 'Delete this task? This cannot be undone.', confirmText: 'Delete', danger: true }))) return
    setBusy(true)
    try { await api.del(`/tasks/${taskId}`); onChange?.(); onClose() }
    finally { setBusy(false) }
  }

  if (loadErr) return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label="Task" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 style={{ margin: 0, fontSize: 16 }}>Task</h3><button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="empty-state">
          <div className="empty-state-icon"><Ic name="warning" size={40} /></div>
          <div className="empty-state-title">Couldn't load this task</div>
          <div className="empty-state-hint">Check your connection and try again.</div>
          <div className="empty-state-action"><button className="btn btn-primary btn-sm" onClick={load}>Retry</button></div>
        </div>
      </div>
    </div>
  )
  if (!task) return (
    <div className="overlay" onClick={onClose}><div className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label="Loading task" onClick={(e) => e.stopPropagation()}><div className="card-pad" style={{ display: 'grid', gap: 12 }}>{Array.from({ length: 5 }).map((_, i) => <span key={i} className="skeleton skel-row" />)}</div></div></div>
  )
  const isManager = user?.role !== 'employee'
  // The person who handed this task out (assigned it, or split the part off) can
  // decide its submission too — mirrors the per-task check on POST /:id/approve.
  const isAssigner = !!user && task.assigned_by_id === user.id && task.assignee?.id !== user.id
  // A task you raised for yourself: yours to finish or bin, no manager sign-off.
  // Mirrors isOwnSelfCreated() on the server, which enforces it — split parts and
  // work reassigned onto you came from someone else's plan and keep the approval
  // flow. The server is the authority here; this only decides what to render.
  const isOwnWork = !!user
    && !task.parent_task_id && !task.reassigned_at
    && task.assignee?.id === user.id && task.assigned_by_id === user.id
  // Managers can delete anything; everyone else, only what they made for themselves.
  const canDelete = isManager || isOwnWork || (task.visible_to_manager === 0 && task.assignee?.id === user?.id)
  // The task owner (or a manager) can split a top-level task into shared parts.
  const canSplit = (isManager || task.assignee?.id === user?.id) && !task.parent_task_id
  // Whoever set the work owns what it asks for: managers, and the person who
  // handed it out. Being given a task is NOT a licence to rewrite it — the
  // assignee moves status and progress and nothing else, so they can't quietly
  // reword, reprioritise or hand on the brief someone set them. This gates the
  // whole brief, not just the title: assignee, priority, category and due date
  // hang off it too. `assigned_by_id` rather than isAssigner, so a task you
  // raised for yourself stays yours to edit (isAssigner excludes exactly that
  // case — you may not approve your own submission, but you may edit it).
  const canEdit = isManager || (!!user && task.assigned_by_id === user.id)
  const subs = task.subtasks || []
  const subDone = subs.filter((s: any) => s.status === 'Done').length
  const subPct = subs.length ? Math.round((subDone / subs.length) * 100) : 0
  const lookupUser = (uid?: string | null) => users.find((u) => u.id === uid)

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label={task.title} onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread">
          <div className="dr-headtitle">Task details</div>
          <div className="row">
            {canEdit && !editing && <button className="btn btn-sm row" style={{ gap: 6 }} disabled={busy} onClick={startEdit} title="Edit task details"><Ic name="edit" size={14} /> Edit</button>}
            {canDelete && <button className="btn btn-sm btn-danger row" style={{ gap: 6 }} disabled={busy} onClick={del} title="Delete task"><Ic name="trash" size={14} /> Delete</button>}
            <button className="btn btn-ghost" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="card-pad">
          {editing ? (
            <div className="grid" style={{ gap: 10 }}>
              <div>
                <label htmlFor="task-edit-title">Title</label>
                <input id="task-edit-title" value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} autoFocus />
              </div>
              <div>
                <label htmlFor="task-edit-desc">Description</label>
                <textarea id="task-edit-desc" rows={3} value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} placeholder="Add more detail…" />
              </div>
              <div className="row">
                <button className="btn btn-primary btn-sm" disabled={busy || !editForm.title.trim()} onClick={saveEdit}>
                  {busy ? <span className="spinner" /> : '✓ Save changes'}
                </button>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="dr-hero" style={{ ['--pr' as any]: PRIORITY_COLORS[task.priority] || 'var(--primary)' }}>
              <h2 className="dr-title">{task.title}</h2>
              <div className="dr-badges">
                <PriorityBadge p={task.priority} /><StatusBadge s={task.status} /><CategoryBadge c={task.category} />
                {task.visible_to_manager === 0 && <span className="badge row" style={{ gap: 5, background: 'var(--info-bg)', color: 'var(--info-ink)', border: '1px solid var(--info-border)' }}><Ic name="lock" size={12} /> Private</span>}
              </div>
              <ConfidenceTag c={task.ownership_confidence} />
              {task.description && task.description !== task.title && (
                <>
                  <div className="dr-section-label">Description</div>
                  <p className="dr-desc">{task.description}</p>
                </>
              )}
            </div>
          )}

          {(task.source_quote || (task as any).assignee_reasoning) && (
            <div style={{ margin: '12px 0' }}>
              <Evidence quote={task.source_quote} reasoning={(task as any).assignee_reasoning} />
            </div>
          )}

          <div className="dr-fields">
            <div className="dr-field dr-field--tall">
              <span className="dr-field-label">Assignee</span>
              <div className="dr-field-val">
                {canEdit ? (
                  <div className="row" style={{ gap: 8 }}>
                    <select data-va="task.drawer.assignee" value={pendingAssignee} disabled={busy} onChange={(e) => setPendingAssignee(e.target.value)} style={{ flex: 1 }}>
                      <option value="">Select member…</option>
                      {users.filter(u => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                    <button
                      data-va="task.drawer.assign"
                      className="btn btn-primary btn-sm"
                      disabled={busy || pendingAssignee === (task.assignee?.id || '')}
                      onClick={() => setAssignee(pendingAssignee)}
                    >
                      {busy ? <span className="spinner" /> : pendingAssignee ? 'Assign' : 'Unassign'}
                    </button>
                  </div>
                ) : (
                  <div className="row" style={{ gap: 8 }}>{task.assignee ? <><Avatar name={task.assignee.name} color={task.assignee.avatar_color} size={24} /> {task.assignee.name}</> : '—'}</div>
                )}
                {task.assignee_name_raw && !task.assignee && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Heard as: “{task.assignee_name_raw}”</div>}
              </div>
            </div>
            <div className="dr-field">
              <span className="dr-field-label">Priority</span>
              <div className="dr-field-val">
                {canEdit ? (
                  <select value={task.priority} onChange={(e) => setPriority(e.target.value)} style={{ width: 'auto' }}>
                    {['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}
                  </select>
                ) : <PriorityBadge p={task.priority} />}
              </div>
            </div>
            <div className="dr-field">
              <span className="dr-field-label">Category</span>
              <div className="dr-field-val">
                {canEdit ? (
                  <select value={task.category || ''} onChange={(e) => setCategory(e.target.value)} style={{ width: 'auto' }}>
                    <option value="">Uncategorized</option>
                    {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (task.category ? <CategoryBadge c={task.category} /> : <span className="muted">Uncategorized</span>)}
              </div>
            </div>
            <div className="dr-field">
              <span className="dr-field-label">Assigned by</span>
              <div className="dr-field-val">
                <div className="row" style={{ gap: 8 }}>{task.assignedBy ? <><Avatar name={task.assignedBy.name} size={24} /> {task.assignedBy.name}</> : '—'}</div>
              </div>
            </div>
            <div className="dr-field">
              <span className="dr-field-label">Due date</span>
              <div className="dr-field-val">
                {editing
                  ? <input type="date" value={editForm.due_date} onChange={(e) => setEditForm({ ...editForm, due_date: e.target.value })} style={{ width: 'auto' }} />
                  : <span>{dueLabel(task)}</span>}
              </div>
            </div>
          </div>

          <div style={{ margin: '16px 0' }}>
            <label>Timeline</label>
            <div style={{ fontSize: 13, display: 'grid', gap: 6 }}>
              <div className="spread"><span className="muted row" style={{ gap: 7 }}><Ic name="doc" size={14} /> Created</span><span>{fmtDateTime(task.created_at)}</span></div>
              <div className="spread"><span className="muted row" style={{ gap: 7 }}><Ic name="pin" size={14} /> Assigned</span><span>{fmtDateTime(task.assigned_at)}</span></div>
              {task.submitted_at && <div className="spread"><span className="muted row" style={{ gap: 7 }}><Ic name="send" size={14} /> Submitted</span><span>{fmtDateTime(task.submitted_at)}</span></div>}
              <div className="spread"><span className="muted row" style={{ gap: 7 }}><Ic name="check" size={14} /> Completed</span><span style={{ color: task.completed_at ? 'var(--success-ink)' : 'inherit' }}>{fmtDateTime(task.completed_at)}</span></div>
            </div>
          </div>

          {edits.length > 0 && (
            <div style={{ margin: '16px 0' }}>
              <label>Edited by</label>
              <div style={{ fontSize: 13, display: 'grid', gap: 8 }}>
                {edits.map((e, i) => (
                  <div key={i} className="spread" style={{ alignItems: 'flex-start', gap: 10 }}>
                    <span className="row" style={{ gap: 7, minWidth: 0 }}>
                      <Avatar name={e.actor_name} color={e.avatar_color} size={22} />
                      <span style={{ minWidth: 0 }}>
                        <b>{e.actor_name}</b>{' '}
                        <span className="muted">
                          {e.reassigned ? 'reassigned it and changed ' : 'changed '}{e.fields.join(', ')}
                        </span>
                      </span>
                    </span>
                    <span className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(e.at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ margin: '14px 0' }}>
            <label htmlFor="task-progress">Progress — {dragProgress ?? task.progress}%</label>
            <input id="task-progress" type="range" min={0} max={100} step={10} value={dragProgress ?? task.progress}
              aria-valuetext={`${dragProgress ?? task.progress} percent`}
              onChange={(e) => onProgressInput(Number(e.target.value))}
              onPointerDown={() => { draggingRef.current = true }}
              onPointerUp={commitProgress} onPointerCancel={commitProgress} onLostPointerCapture={commitProgress}
              onKeyUp={commitProgress} onBlur={commitProgress} />
          </div>

          <div style={{ margin: '16px 0' }}>
            <label>Status</label>
            {isManager ? (
              <>
                <div className="row wrap">
                  {STATUSES.map((s) => (
                    <button data-va={`task.drawer.status.${s}`} key={s} className={'btn btn-sm' + (pendingStatus === s ? ' btn-primary' : '')} disabled={busy} onClick={() => setPendingStatus(s)}>{s}</button>
                  ))}
                </div>
                {pendingStatus !== task.status && (
                  <div className="row" style={{ marginTop: 10 }}>
                    <button data-va="task.drawer.acceptStatus" className="btn btn-primary btn-sm" disabled={busy} onClick={() => setStatus(pendingStatus)}>
                      {busy ? <span className="spinner" /> : `✓ Accept change → ${pendingStatus}`}
                    </button>
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPendingStatus(task.status)}>Cancel</button>
                  </div>
                )}
              </>
            ) : isOwnWork ? (
              /* Your own task: the same direct control a manager gets, minus the
                 approval states — there is nobody to submit it to. */
              <>
                <div className="row wrap">
                  {['To Do', 'In Progress', 'Blocked', 'Done'].map((s) => (
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
                {task.status !== 'Done' && (
                  <>
                    <button className="btn btn-primary" style={{ marginTop: 10, width: '100%' }} disabled={busy} onClick={() => setStatus('Done')}>
                      {busy ? <span className="spinner" /> : '✓ Mark as complete'}
                    </button>
                    <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>You created this task for yourself — completing it needs no approval.</p>
                  </>
                )}
              </>
            ) : task.status === 'Done' ? (
              <div className="card-pad" style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10, color: '#047857' }}>
                ✓ Completed — the work was approved.
              </div>
            ) : task.approval_status === 'pending' ? (
              <div className="card-pad" style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', borderRadius: 10 }}>
                <strong className="row" style={{ gap: 7 }}><Ic name="clock" size={15} /> Submitted for review</strong>
                {task.assignee?.id === user?.id ? (
                  /* The assignee: their work is parked with the reviewer. */
                  <>
                    <p className="muted" style={{ margin: '4px 0 10px' }}>Waiting for your manager — or whoever assigned it to you — to approve. You'll get it back if changes are needed.</p>
                    <button className="btn btn-sm row" style={{ gap: 6 }} disabled={busy} onClick={() => setStatus('In Progress')}><Ic name="reply" size={14} /> Withdraw &amp; keep working</button>
                  </>
                ) : (
                  /* The assigner viewing via "Assigned by me": their decision panel is below. */
                  <p className="muted" style={{ margin: '4px 0 0' }}>{task.assignee?.name || 'The assignee'} submitted this — approve it or send it back below.</p>
                )}
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
                <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>Sends this task for approval — to your manager, or to whoever assigned it to you.</p>
              </>
            )}
          </div>

          {!task.parent_task_id && (subs.length > 0 || canSplit) && (
            <div style={{ margin: '16px 0' }}>
              <div className="spread">
                <label style={{ margin: 0 }}>Shared parts{subs.length ? ` — ${subDone}/${subs.length} done` : ''}</label>
                {canSplit && <button className="btn btn-sm row" style={{ gap: 6 }} disabled={busy} onClick={openSplit}><Ic name="scissors" size={14} /> Split &amp; share</button>}
              </div>
              {subs.length > 0 ? (
                <>
                  <div className="bar-track" style={{ margin: '8px 0' }}><div className="bar-fill" style={{ width: subPct + '%', background: '#10b981' }} /></div>
                  <div style={{ display: 'grid', gap: 2 }}>
                    {subs.map((s: any) => {
                      const u = lookupUser(s.assignee_id)
                      return (
                        <div key={s.id} className="spread" style={{ fontSize: 13, padding: '7px 0', borderBottom: '1px solid #f1f5f9' }}>
                          <span className="row" style={{ gap: 6 }}>{s.status === 'Done' ? <Ic name="check" size={13} /> : <span style={{ color: 'var(--muted)' }}>•</span>} {s.title}</span>
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

          {(isManager || isAssigner) && task.approval_status === 'pending' && (
            <div className="card-pad" style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, marginBottom: 16 }}>
              <strong>Approval requested</strong>
              <p className="muted" style={{ margin: '4px 0 10px' }}>
                {isManager ? 'This task is in review and awaiting your approval.' : 'You handed this task out — it\'s submitted and waiting for you to accept the work.'}
              </p>
              <div className="row">
                <button className="btn btn-primary btn-sm" onClick={() => approve('approved')}>✓ Approve & close</button>
                <button className="btn btn-sm btn-danger" onClick={() => approve('rejected')} title="Send back to the owner to keep working">Send back for changes</button>
              </div>
            </div>
          )}

          {task.dependencies && task.dependencies.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <label>Depends on</label>
              {task.dependencies.map((d: any) => <div key={d.id} className="row" style={{ fontSize: 13 }}>↳ {d.title} <StatusBadge s={d.status} /></div>)}
            </div>
          )}

          <div style={{ marginBottom: 14 }}>
            <div className="spread" style={{ alignItems: 'center' }}>
              <label style={{ margin: 0 }}>Attachments ({task.attachments?.length || 0})</label>
              <input ref={attachInput} type="file" multiple accept="image/*,application/pdf,video/*" style={{ display: 'none' }} onChange={(e) => uploadFiles(e.target.files)} />
              <button className="btn btn-sm row" style={{ gap: 6 }} disabled={busy} onClick={() => attachInput.current?.click()} title="Attach images, PDFs or videos"><Ic name="attach" size={13} /> Attach</button>
            </div>
            {task.attachments && task.attachments.length > 0 && (
              <div className="attach-grid" style={{ marginTop: 8 }}>
                {task.attachments.map((a: Attachment) => {
                  const isImg = (a.file_type || '').startsWith('image/')
                  const isVid = (a.file_type || '').startsWith('video/')
                  const canRemove = isManager || a.uploaded_by === user?.id
                  return (
                    <div key={a.id} className="attach-item">
                      {isImg ? (
                        <a href={taskAttachmentUrl(a.id)} target="_blank" rel="noreferrer" className="attach-thumb">
                          <img src={taskAttachmentUrl(a.id)} alt={a.filename} loading="lazy" />
                        </a>
                      ) : isVid ? (
                        <video className="attach-thumb" src={taskAttachmentUrl(a.id)} controls preload="metadata" />
                      ) : (
                        <a href={taskAttachmentUrl(a.id)} target="_blank" rel="noreferrer" className="attach-thumb attach-thumb-file"><Ic name="doc" size={26} /></a>
                      )}
                      <div className="attach-meta">
                        <a href={taskAttachmentUrl(a.id, true)} className="attach-name" title={`Download ${a.filename}`}>{a.filename}</a>
                        <span className="muted" style={{ fontSize: 11 }}>{fmtBytes(a.file_size)}</span>
                      </div>
                      {canRemove && <button className="attach-item-x" disabled={busy} onClick={() => removeAttachment(a)} aria-label={`Remove ${a.filename}`}>✕</button>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

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
              <input data-va="task.drawer.comment" aria-label="Add a comment" placeholder="Add a comment…" value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addComment()} />
              <button data-va="task.drawer.postComment" className="btn btn-primary" onClick={addComment} disabled={busy}>Post</button>
            </div>
          </div>
        </div>

        {showSplit && (
          <div className="modal-center" onClick={() => setShowSplit(false)}>
            <div className="modal" role="dialog" aria-modal="true" aria-label="Split and share task" onClick={(e) => e.stopPropagation()}>
              <div className="card-head spread"><h3 style={{ fontSize: 16 }}>Split &amp; share</h3><button className="btn btn-ghost" onClick={() => setShowSplit(false)} aria-label="Close">✕</button></div>
              <div className="card-pad grid" style={{ gap: 10 }}>
                <p className="muted" style={{ fontSize: 12 }}>Add each part and pick who does it. Parts inherit this task's due date &amp; priority. You stay responsible — it completes when all parts are done.</p>
                {parts.map((p, i) => (
                  <div className="row split-part" key={i} style={{ gap: 8 }}>
                    <input className="split-part-title" placeholder={`Part ${i + 1} — what needs doing`} value={p.title} onChange={(e) => updatePart(i, { title: e.target.value })} autoFocus={i === 0} />
                    <select className="split-part-who" value={p.assignee_id} onChange={(e) => updatePart(i, { assignee_id: e.target.value })}>
                      <option value="">Who…</option>
                      {users.filter((u) => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}{u.id === user?.id ? ' (me)' : ''}</option>)}
                    </select>
                    {parts.length > 1 && <button className="btn btn-ghost btn-sm" title="Remove" onClick={() => setParts((ps) => ps.filter((_, idx) => idx !== i))}>✕</button>}
                  </div>
                ))}
                <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setParts((ps) => [...ps, { title: '', assignee_id: '' }])}>+ Add another part</button>
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn" onClick={() => setShowSplit(false)}>Cancel</button>
                  <button className="btn btn-primary row" style={{ gap: 6 }} disabled={busy || !parts.some((p) => p.title.trim() && p.assignee_id)} onClick={doSplit}>{busy ? <span className="spinner" /> : <><Ic name="send" size={14} /> Share parts</>}</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
