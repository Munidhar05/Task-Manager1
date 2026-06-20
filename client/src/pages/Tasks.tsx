import React, { useEffect, useRef, useState } from 'react'
import { api, Task, User } from '../api'
import { useAuth } from '../auth'
import { PriorityBadge, StatusBadge, Avatar, ConfidenceTag, EmptyState, dueLabel, fmtDateTime, PRIORITY_COLORS } from '../ui'
import TaskDrawer from '../components/TaskDrawer'
import TaskBoard from '../components/TaskBoard'
import { pushBackHandler } from '../back'

// Date the task was GIVEN to its owner — drives grouping, ordering, and the Time
// column. Using the given date (not the latest activity) means completing a task
// or sending it to review never bumps it to Today or to the top of the table.
const givenOf = (t: Task) => t.assigned_at || t.created_at || ''
const givenLabel = (t: Task) => (t.assigned_at ? '📌 Assigned' : '🆕 Created')

// Clean line-art microphone (replaces the old 🎤 emoji on the Speak button).
const MicIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <line x1="12" y1="17" x2="12" y2="21" />
    <line x1="8" y1="21" x2="16" y2="21" />
  </svg>
)

// Sortable columns. Ranks make Priority/Status sort by logical order (not alphabetically);
// tasks with no due date sort last. Each returns an ascending-order comparator value.
type SortKey = 'task' | 'priority' | 'status' | 'assignee' | 'due' | 'time'
const PRIORITY_RANK: Record<string, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 }
const STATUS_RANK: Record<string, number> = { 'To Do': 0, 'In Progress': 1, 'Blocked': 2, 'In Review': 3, 'Done': 4, 'Reopened': 5 }
const cmpAsc = (a: Task, b: Task, key: SortKey): number => {
  switch (key) {
    case 'task': return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' })
    case 'priority': return (PRIORITY_RANK[a.priority] ?? 0) - (PRIORITY_RANK[b.priority] ?? 0)
    case 'status': return (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99)
    // Unassigned tasks sort last (high sentinel) regardless of name comparison.
    case 'assignee': return (a.assignee?.name || '￿').localeCompare(b.assignee?.name || '￿', undefined, { sensitivity: 'base' })
    case 'due': return (a.due_date || '9999-12-31').localeCompare(b.due_date || '9999-12-31')
    case 'time': return givenOf(a).localeCompare(givenOf(b))
  }
}

export default function Tasks({ personal = false }: { personal?: boolean }) {
  const { user } = useAuth()
  const [tasks, setTasks] = useState<Task[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [view, setView] = useState<'list' | 'board'>('list')
  const [quickView, setQuickView] = useState<'active' | 'overdue' | 'today' | 'completed'>('active')
  const [filters, setFilters] = useState<{ q: string; priority: string; status: string; assignee: string }>({ q: '', priority: '', status: '', assignee: '' })
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'time', dir: 'desc' })
  // Click a header: toggle direction if it's the active column, else switch to it (default desc).
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))

  const load = () => {
    const p = new URLSearchParams()
    Object.entries(filters).forEach(([k, v]) => v && p.set(k, v))
    if (personal) p.set('mine', '1') // My Tasks: only the current user's own tasks
    api.get('/tasks?' + p.toString()).then(setTasks)
  }
  // Re-fetch on `personal` too: /tasks and /my-tasks reuse this same component, so
  // navigating between them flips `personal` without changing `filters` — without
  // this dep the list would keep showing the previous route's tasks until a refresh.
  useEffect(() => { load() }, [filters, personal])
  useEffect(() => { api.get('/users').then(setUsers) }, [])

  // Android back button: close the open task drawer / new-task modal first.
  useEffect(() => pushBackHandler(() => {
    if (showNew) { setShowNew(false); return true }
    if (openId) { setOpenId(null); return true }
    return false
  }), [showNew, openId])

  // In "My Tasks" (personal) mode, behave like a personal board even for managers:
  // own tasks only, no assignee column/picker, and new tasks are private.
  const isManager = user?.role !== 'employee' && !personal
  // A row is "narrowed" when a server filter or a non-default quick view is active —
  // used to tailor the empty-state copy (and offer a Clear button).
  const narrowed = !!(filters.q || filters.priority || filters.status || filters.assignee) || quickView === 'overdue' || quickView === 'today'
  const clearFilters = () => { setFilters({ q: '', priority: '', status: '', assignee: '' }); setQuickView('active') }

  // Quick views split the list into ACTIVE work vs the COMPLETED archive.
  // A completed task = status 'Done' (employee tasks reach 'Done' only once a
  // manager accepts them); these are removed from the active list and shown,
  // with their assigned + completed dates, in the Completed view.
  const todayStr = new Date().toISOString().slice(0, 10)
  const matchesQuick = (t: Task, key: typeof quickView) => {
    switch (key) {
      case 'completed': return t.status === 'Done'
      case 'overdue': return !!t.due_date && t.due_date < todayStr && t.status !== 'Done'
      case 'today': return t.due_date === todayStr && t.status !== 'Done'
      default: return t.status !== 'Done' // 'active'
    }
  }
  const visibleTasks = tasks.filter((t) => matchesQuick(t, quickView))
  const QUICK_CHIPS: { key: typeof quickView; label: string; danger?: boolean }[] = [
    { key: 'active', label: 'Active' },
    { key: 'overdue', label: 'Overdue', danger: true },
    { key: 'today', label: 'Due today' },
    { key: 'completed', label: '✓ Completed' },
  ]

  // Left-edge accent on each row by due-date urgency (overdue/today) or completion.
  const rowClass = (t: Task) => {
    if (t.status === 'Done') return 'row-done'
    if (t.due_date && t.due_date < todayStr) return 'row-overdue'
    if (t.due_date === todayStr) return 'row-today'
    return ''
  }

  // Group tasks by their activity day, sort WITHIN each day by the active column,
  // and keep the day groups newest-first — so changing the sort only reorders rows
  // inside a date, never the dates themselves.
  const groupedByDay = (() => {
    const groups: Record<string, Task[]> = {}
    for (const t of visibleTasks) {
      const day = (givenOf(t) || '').slice(0, 10) || 'No date'
      ;(groups[day] ||= []).push(t)
    }
    for (const day in groups) {
      groups[day].sort((a, b) => {
        const cmp = cmpAsc(a, b, sort.key)
        return sort.dir === 'desc' ? -cmp : cmp
      })
    }
    const keys = Object.keys(groups).sort((a, b) => (a === 'No date' ? 1 : b === 'No date' ? -1 : b.localeCompare(a)))
    return keys.map((day) => ({ day, items: groups[day] }))
  })()

  // Priority sort is special: instead of grouping by day, mix ALL tasks across
  // every date into one flat list ordered purely by priority (Critical → High →
  // Medium → Low). Ties keep newest-activity-first. Only the priority column
  // behaves this way; every other column stays day-grouped.
  const sortedByPriority = [...visibleTasks].sort((a, b) => {
    const cmp = cmpAsc(a, b, 'priority')
    if (cmp !== 0) return sort.dir === 'desc' ? -cmp : cmp
    return givenOf(b).localeCompare(givenOf(a)) // tie-break: newest first
  })

  // Friendly heading for a day group, e.g. "Today · Wednesday, 11 June 2026".
  const dayHeading = (day: string) => {
    if (day === 'No date') return 'No date'
    const d = new Date(day + 'T00:00:00')
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const diff = Math.round((today.getTime() - d.getTime()) / 86400000)
    const rel = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : null
    const full = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    return rel ? `${rel} · ${full}` : full
  }

  // Inline assign from the table row (managers only). Sets owner + flips confidence to confirmed.
  const assign = (taskId: string, userId: string) => {
    if (!userId) return
    api.patch(`/tasks/${taskId}`, { assignee_id: userId }).then(load)
  }
  // Inline priority change from the report row (managers only).
  const changePriority = (taskId: string, priority: string) => api.patch(`/tasks/${taskId}`, { priority }).then(load)
  // Inline approve: a manager marks an In-Review task as Done straight from the row.
  const markDone = (taskId: string) => api.post(`/tasks/${taskId}/approve`, { decision: 'approved' }).then(load)

  // Board drag-and-drop: optimistically move the card, then persist via the status API.
  const moveStatus = (taskId: string, status: string) => {
    setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, status } : t)))
    api.post(`/tasks/${taskId}/status`, { status }).then(load).catch(() => load())
  }

  // Clickable, sortable column header. Active column shows the direction arrow; the
  // others show a faint ↕ to hint they're sortable too.
  const sortTh = (label: string, key: SortKey) => (
    <th className="clickable" style={{ userSelect: 'none' }} onClick={() => toggleSort(key)} title={`Sort by ${label.toLowerCase()}`}>
      {label} {sort.key === key ? (sort.dir === 'desc' ? '↓' : '↑') : <span style={{ opacity: 0.3 }}>↕</span>}
    </th>
  )

  const renderRow = (t: Task) => (
    <tr key={t.id} className={'clickable ' + rowClass(t)} onClick={() => setOpenId(t.id)}>
      <td className="cell-title"><div style={{ fontWeight: 600 }}>{t.title}</div><ConfidenceTag c={t.ownership_confidence} /></td>
      <td data-label="Priority">
        {isManager ? (
          <select
            value={t.priority}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => { e.stopPropagation(); changePriority(t.id, e.target.value) }}
            style={{ width: 'auto', padding: '4px 8px', fontSize: 12.5, fontWeight: 700, color: PRIORITY_COLORS[t.priority], borderColor: (PRIORITY_COLORS[t.priority] || '#cbd5e1') + '88' }}
          >
            {['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p} value={p} style={{ color: '#1f1a16' }}>{p}</option>)}
          </select>
        ) : <PriorityBadge p={t.priority} />}
      </td>
      <td data-label="Status">
        <span className="row" style={{ gap: 8 }}>
          <StatusBadge s={t.status} />
          {isManager && t.status === 'In Review' && (
            <button className="btn btn-sm btn-done" onClick={(e) => { e.stopPropagation(); markDone(t.id) }} title="Approve & mark as done">✓ Done</button>
          )}
          {isManager && t.status !== 'In Review' && t.status !== 'Done' && (
            <button className="btn-tick" onClick={(e) => { e.stopPropagation(); moveStatus(t.id, 'Done') }} title="Mark as completed" aria-label="Mark as completed">✓</button>
          )}
        </span>
      </td>
      {!personal && (
        <td data-label="Assignee">
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
      )}
      <td data-label="Due">{dueLabel(t)}</td>
      <td data-label="Time">
        <div style={{ fontSize: 12.5 }}>{fmtDateTime(givenOf(t))}</div>
        <div className="muted" style={{ fontSize: 11 }}>{givenLabel(t)}</div>
      </td>
    </tr>
  )

  // Completed archive: accepted/done tasks, newest completion first, with both dates.
  const completedRows = [...visibleTasks].sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))
  const renderCompletedRow = (t: Task) => (
    <tr key={t.id} className="clickable" onClick={() => setOpenId(t.id)}>
      <td className="cell-title"><div style={{ fontWeight: 600 }}>{t.title}</div></td>
      <td data-label="Priority"><PriorityBadge p={t.priority} /></td>
      {!personal && (
        <td data-label="Assignee">
          {t.assignee
            ? <span className="row"><Avatar name={t.assignee.name} color={t.assignee.avatar_color} size={22} /> {t.assignee.name}</span>
            : <span className="muted">Unassigned</span>}
        </td>
      )}
      <td data-label="Assigned">{fmtDateTime(givenOf(t))}</td>
      <td data-label="Completed"><span style={{ color: '#10b981', fontWeight: 600 }}>{fmtDateTime(t.completed_at)}</span></td>
    </tr>
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
        <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
          <div className="seg">
            <button className={'seg-btn' + (view === 'list' ? ' active' : '')} onClick={() => setView('list')} title="List view">☰ List</button>
            <button className={'seg-btn' + (view === 'board' ? ' active' : '')} onClick={() => setView('board')} title="Board view">▤ Board</button>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>+ New task</button>
        </div>
      </div>

      {view === 'board' ? (
        tasks.length === 0 ? (
          <div className="card">
            <EmptyState
              icon="🎉"
              title="You're all caught up!"
              hint={isManager
                ? 'No tasks yet. Create one to start tracking work.'
                : 'No tasks assigned to you yet. Create a personal task to get started.'}
              action={<button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>+ New task</button>}
            />
          </div>
        ) : (
          <TaskBoard tasks={tasks} onOpen={setOpenId} onMove={moveStatus} />
        )
      ) : (
        <>
          {tasks.length > 0 && (
            <div className="chips">
              {QUICK_CHIPS.map((c) => {
                const count = tasks.filter((t) => matchesQuick(t, c.key)).length
                return (
                  <button
                    key={c.key}
                    className={'chip' + (c.danger ? ' danger' : '') + (quickView === c.key ? ' active' : '')}
                    onClick={() => setQuickView(c.key)}
                  >
                    {c.label}
                    <span className="chip-count">{count}</span>
                  </button>
                )
              })}
            </div>
          )}

          {visibleTasks.length === 0 ? (
            <div className="card">
              {quickView === 'completed' ? (
                <EmptyState
                  icon="📦"
                  title="No completed tasks yet"
                  hint="Tasks marked Done and accepted by a manager will appear here, with their assigned and completed dates."
                />
              ) : narrowed ? (
                <EmptyState
                  icon="🔍"
                  title="No tasks match your filters"
                  hint="Try a different search term, or clear the filters to see everything."
                  action={<button className="btn btn-sm" onClick={clearFilters}>Clear filters</button>}
                />
              ) : (
                <EmptyState
                  icon="🎉"
                  title="You're all caught up!"
                  hint={isManager
                    ? 'No active tasks. Create one to start tracking work.'
                    : 'No active tasks assigned to you. Create a personal task to get started.'}
                  action={<button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>+ New task</button>}
                />
              )}
            </div>
          ) : quickView === 'completed' ? (
            <div className="card table-card-wrap">
              <table className="table-cards">
                <thead><tr>
                  <th>Task</th><th>Priority</th>{!personal && <th>Assignee</th>}<th>Assigned</th><th>Completed ↓</th>
                </tr></thead>
                <tbody>{completedRows.map(renderCompletedRow)}</tbody>
              </table>
            </div>
          ) : (
            <div className="card table-card-wrap">
              <table className="table-cards">
                <thead><tr>
                  {sortTh('Task', 'task')}
                  {sortTh('Priority', 'priority')}
                  {sortTh('Status', 'status')}
                  {!personal && sortTh('Assignee', 'assignee')}
                  {sortTh('Due', 'due')}
                  {sortTh('Time', 'time')}
                </tr></thead>
                <tbody>
                  {sort.key === 'priority'
                    ? sortedByPriority.map(renderRow)
                    : groupedByDay.map((g) => (
                      <React.Fragment key={g.day}>
                        <tr className="day-group-row">
                          <td colSpan={personal ? 5 : 6}>{dayHeading(g.day)} <span className="day-group-count">{g.items.length}</span></td>
                        </tr>
                        {g.items.map(renderRow)}
                      </React.Fragment>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {openId && <TaskDrawer taskId={openId} onClose={() => setOpenId(null)} onChange={load} />}
      {showNew && <NewTaskModal users={users} personal={personal} onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />}
    </>
  )
}

function NewTaskModal({ users, personal, onClose, onCreated }: { users: User[]; personal?: boolean; onClose: () => void; onCreated: () => void }) {
  const { user } = useAuth()
  const isEmployee = user?.role === 'employee'
  // Private only in My Tasks (personal) mode. Everywhere else, anyone may assign
  // the task to anyone — so the assignee picker is shown to everyone.
  const asPersonal = !!personal
  // Default the owner to yourself (so it shows in your list); managers triage, so
  // they default to Unassigned.
  const [form, setForm] = useState<any>({ title: '', description: '', priority: 'Medium', assignee_id: isEmployee ? (user?.id || '') : '', due_date: '' })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!form.title) return
    setBusy(true)
    try { await api.post('/tasks', { ...form, personal: asPersonal }); onCreated() } finally { setBusy(false) }
  }

  // ---- Voice input: speak the whole task aloud; the AI extracts the title,
  // description, who it's for, and the priority, then fills the form. ----
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  const recRef = useRef<any>(null)
  const [listening, setListening] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [heard, setHeard] = useState('')
  useEffect(() => () => { try { recRef.current?.stop() } catch {} }, [])

  // Send the spoken sentence to the server, which extracts structured fields, and
  // merge them in. The assignee is applied only when not in personal mode.
  const applyVoice = async (transcript: string) => {
    const text = transcript.trim()
    if (!text) return
    setParsing(true)
    try {
      const d = await api.post('/tasks/parse-voice', { transcript: text })
      setForm((f: any) => ({
        ...f,
        title: d.title || f.title,
        description: d.description || f.description,
        priority: d.priority || f.priority,
        assignee_id: !asPersonal && d.assignee_id ? d.assignee_id : f.assignee_id,
      }))
    } catch {
      // On failure, at least keep the raw words as the title.
      setForm((f: any) => ({ ...f, title: f.title || text }))
    } finally { setParsing(false) }
  }

  const toggleMic = () => {
    if (!SR) { alert('Voice input needs Google Chrome or Microsoft Edge.'); return }
    if (listening) { try { recRef.current?.stop() } catch {}; setListening(false); return }
    const rec = new SR()
    rec.lang = 'en-IN'; rec.interimResults = true; rec.continuous = true
    let finalText = ''
    rec.onresult = (e: any) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalText += r[0].transcript + ' '; else interim += r[0].transcript
      }
      setHeard((finalText + interim).replace(/\s+/g, ' ').trim())
    }
    rec.onerror = () => setListening(false)
    rec.onend = () => { setListening(false); applyVoice(finalText) }
    recRef.current = rec; setListening(true); setHeard('')
    try { rec.start() } catch { setListening(false) }
  }

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3>{asPersonal ? 'New personal task' : 'New task'}</h3><button className="btn btn-ghost" onClick={onClose}>✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          {asPersonal && <div className="muted" style={{ fontSize: 12, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '8px 10px' }}>🔒 Private to you — only you can see this task.</div>}
          <div>
            <label>
              Title
              {listening && <span style={{ color: '#dc2626', fontWeight: 700, fontSize: 11 }}> ● listening…</span>}
              {parsing && <span style={{ color: 'var(--primary)', fontWeight: 700, fontSize: 11 }}> ● understanding…</span>}
            </label>
            <div className="row" style={{ gap: 6 }}>
              <input style={{ flex: 1 }} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="What needs doing?" autoFocus />
              {SR && (
                <button
                  type="button"
                  className={'btn btn-sm btn-mic' + (listening ? ' btn-mic-live' : '')}
                  onClick={toggleMic}
                  disabled={parsing}
                  title="Speak the task — AI fills in the title, details, assignee & priority"
                >
                  {parsing
                    ? <><span className="spinner" /> Thinking…</>
                    : listening
                      ? <><span className="mic-dot" /> Stop</>
                      : <><MicIcon /> Speak</>}
                </button>
              )}
            </div>
            {SR && !listening && !parsing && !heard && (
              <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                Tip: say the whole task — e.g. “High priority task for Ravi to fix the login page bug by Friday.”
              </div>
            )}
            {(listening || parsing) && heard && (
              <div className="muted" style={{ fontSize: 12, marginTop: 4, fontStyle: 'italic' }}>“{heard}”</div>
            )}
          </div>
          <div><label>Description</label><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div className={asPersonal ? 'grid grid-2' : 'grid grid-3'} style={{ gap: 10 }}>
            <div><label>Priority</label><select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>{['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}</select></div>
            {!asPersonal && <div><label>Assignee</label><select value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}><option value="">Unassigned</option>{users.filter(u => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}{u.id === user?.id ? ' (me)' : ''}</option>)}</select></div>}
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
