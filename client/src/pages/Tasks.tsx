import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, Task, User, API_BASE, getToken } from '../api'
import { useAuth } from '../auth'
import { PriorityBadge, StatusBadge, CategoryBadge, CATEGORY_OPTIONS, Avatar, ConfidenceTag, EmptyState, Ic, dueLabel, fmtDateTime, fmtBytes, PRIORITY_COLORS } from '../ui'
import TaskDrawer from '../components/TaskDrawer'
import TaskBoard from '../components/TaskBoard'
import { pushBackHandler } from '../back'
import { toast } from '../lib/toast'
import { useEscape } from '../lib/useEscape'

// Date the task was GIVEN to its owner — drives grouping, ordering, and the Time
// column. Using the given date (not the latest activity) means completing a task
// or sending it to review never bumps it to Today or to the top of the table.
const givenOf = (t: Task) => t.assigned_at || t.created_at || ''
const givenLabel = (t: Task) => (t.assigned_at ? 'Assigned' : 'Created')

// Mirror of the server's priority→due-date default (server/src/util.js) so the
// New Task form SHOWS the date the task will actually get. Critical=today,
// High=+1, Medium=+3, Low=+5 days. Local date parts (matches the server).
const DUE_DAYS_BY_PRIORITY: Record<string, number> = { Critical: 0, High: 1, Medium: 3, Low: 5 }
const dueDateForPriority = (priority: string) => {
  const d = new Date()
  d.setDate(d.getDate() + (DUE_DAYS_BY_PRIORITY[priority] ?? DUE_DAYS_BY_PRIORITY.Medium))
  const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${da}`
}

// Auto-growing textarea: wraps long text and grows with content so the whole
// title is readable instead of scrolling word-by-word inside a one-line input.
function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const fit = () => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }
  React.useEffect(fit, [props.value])
  return <textarea ref={ref} rows={1} {...props} onInput={fit} style={{ resize: 'none', overflow: 'hidden', lineHeight: 1.45, minHeight: 40, ...props.style }} />
}

// Clean line-art magnifier for the collapsible search control.
const SearchIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)

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

// A nicely themed sort control (replaces the plain native <select>, whose popup
// can't be styled). Shows the active option, opens a rounded menu with a check on
// the current choice, and closes on outside-click or selection.
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'time', label: 'Default' },
  { key: 'priority', label: 'Priority' },
  { key: 'status', label: 'Status' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'due', label: 'Due date' },
]
const SortGlyph = () => (
  <svg className="sortmenu-ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m3 16 4 4 4-4" /><path d="M7 20V4" /><path d="m21 8-4-4-4 4" /><path d="M17 4v16" />
  </svg>
)
function SortMenu({ sortKey, onPick }: { sortKey: SortKey; onPick: (key: SortKey) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const current = SORT_OPTIONS.find((o) => o.key === sortKey) || SORT_OPTIONS[0]
  return (
    <div className="sortmenu toolbar-sort" ref={ref}>
      <button className="sortmenu-btn" onClick={() => setOpen((o) => !o)} title="Sort tasks" aria-haspopup="listbox" aria-expanded={open}>
        <SortGlyph />
        <span className="sortmenu-label">Sort: {current.label}</span>
        <svg className={'sortmenu-chev' + (open ? ' flip' : '')} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="sortmenu-pop" role="listbox">
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.key}
              role="option"
              aria-selected={o.key === sortKey}
              className={'sortmenu-item' + (o.key === sortKey ? ' active' : '')}
              onClick={() => { onPick(o.key); setOpen(false) }}
            >
              <span>{o.label}</span>
              {o.key === sortKey && (
                <svg className="sortmenu-check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Search dialog: type or speak to search tasks. On submit it sets the query and
// closes; the filtered list is then visible behind it. Voice uses the same
// server-side transcription as the New Task form (reliable on Android).
type SearchApply = { q?: string; assignee?: string; status?: string; priority?: string }
function SearchDialog({ initial, onApply, onClose }: { initial: string; onApply: (f: SearchApply) => void; onClose: () => void }) {
  const [q, setQ] = useState(initial)
  const [listening, setListening] = useState(false)
  const [parsing, setParsing] = useState(false)
  // Extra filters resolved from a voice query (e.g. an employee name → assignee id).
  const [voiceFilters, setVoiceFilters] = useState<{ assignee?: string; assigneeName?: string; status?: string; priority?: string } | null>(null)
  const mrRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  useEscape(onClose)
  const canRecord = typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof (window as any).MediaRecorder !== 'undefined'

  const releaseMic = () => {
    try { if (mrRef.current && mrRef.current.state !== 'inactive') mrRef.current.stop() } catch {}
    try { streamRef.current?.getTracks().forEach((t) => t.stop()) } catch {}
    streamRef.current = null
  }
  useEffect(() => releaseMic, [])

  const transcribe = async (blob: Blob) => {
    setParsing(true)
    try {
      const fd = new FormData()
      fd.append('audio', blob, 'search.webm')
      const headers: Record<string, string> = {}
      const token = getToken()
      if (token) headers.authorization = `Bearer ${token}`
      // /voice-search transcribes ANY language, translates to English, and resolves
      // a spoken employee name to an assignee id so we can show all their tasks.
      const res = await fetch(`${API_BASE}/api/tasks/voice-search`, { method: 'POST', headers, body: fd, cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || `Voice search failed (${res.status})`)
      const query = String(data?.query || '').trim()
      const extra = {
        assignee: data?.assignee_id || undefined,
        assigneeName: data?.assignee_name || undefined,
        status: data?.status || undefined,
        priority: data?.priority || undefined,
      }
      const heardSomething = query || extra.assignee || extra.status || extra.priority
      if (heardSomething) {
        setQ(query)
        setVoiceFilters((extra.assignee || extra.status || extra.priority) ? extra : null)
      } else {
        toast.info("Didn't catch that — please tap and try again.")
      }
    } catch (err: any) {
      toast.error(err?.message || 'Could not search by voice. Check your connection and try again.')
    } finally { setParsing(false) }
  }

  const toggleMic = async () => {
    if (listening) { setListening(false); try { mrRef.current?.stop() } catch {}; return }
    if (!canRecord) { toast.error('Voice search needs microphone access on this device.'); return }
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch { toast.error('Microphone access is blocked. Allow mic permission and try again.'); return }
    streamRef.current = stream
    chunksRef.current = []
    let mr: MediaRecorder
    try { mr = new MediaRecorder(stream, { mimeType: 'audio/webm' }) } catch { mr = new MediaRecorder(stream) }
    mrRef.current = mr
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data) }
    mr.onstop = () => {
      try { streamRef.current?.getTracks().forEach((t) => t.stop()) } catch {}
      streamRef.current = null
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' })
      chunksRef.current = []
      if (blob.size) transcribe(blob)
    }
    try { mr.start() } catch { setListening(false); releaseMic(); return }
    setListening(true)
  }

  const submit = () => {
    const f: SearchApply = { q: q.trim() }
    // A voice query may also have resolved an employee / status / priority — apply
    // those alongside the text so e.g. "Shabbir's blocked tasks" filters correctly.
    if (voiceFilters) {
      f.assignee = voiceFilters.assignee || ''
      f.status = voiceFilters.status || ''
      f.priority = voiceFilters.priority || ''
    }
    onApply(f)
    onClose()
  }

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal search-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Search tasks">
        <div className="card-head spread"><h3>Search tasks</h3><button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          <div className="search-dialog-field">
            <span className="search-dialog-icon"><SearchIcon size={18} /></span>
            <input
              autoFocus
              placeholder="Search tasks by title…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            />
            {q && <button className="search-dialog-clear" onClick={() => setQ('')} title="Clear" aria-label="Clear">✕</button>}
          </div>
          {canRecord && (
            <button
              type="button"
              className={'btn btn-mic search-dialog-mic' + (listening ? ' btn-mic-live' : '')}
              onClick={toggleMic}
              disabled={parsing}
              title="Speak to search"
            >
              {parsing
                ? <><span className="spinner" /> Transcribing…</>
                : listening
                  ? <><span className="mic-dot" /> Stop & search</>
                  : <><MicIcon size={16} /> Speak to search</>}
            </button>
          )}
          {listening && <div className="muted" style={{ fontSize: 12 }}>Listening… tap Stop when done.</div>}
          {voiceFilters && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', fontSize: 12 }}>
              <span className="muted">Voice search:</span>
              {voiceFilters.assigneeName && <span className="badge row" style={{ gap: 5, background: 'var(--info-bg)', color: 'var(--info-ink)' }}><Ic name="user" size={12} /> {voiceFilters.assigneeName}</span>}
              {voiceFilters.status && <span className="badge" style={{ background: '#f1f5f9', color: '#334155' }}>{voiceFilters.status}</span>}
              {voiceFilters.priority && <span className="badge" style={{ background: '#fff7ed', color: '#c2410c' }}>{voiceFilters.priority}</span>}
              <button className="search-dialog-clear" style={{ position: 'static' }} onClick={() => setVoiceFilters(null)} title="Clear voice filters" aria-label="Clear voice filters">✕</button>
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={submit}>Search</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Mobile-only Filters dialog: the same priority/status/assignee filters as the
// desktop toolbar dropdowns (which are CSS-hidden on phones). Staged locally and
// applied on confirm, so tapping through options doesn't fire a fetch per change.
function FiltersDialog({ filters, users, isManager, onApply, onClose }: {
  filters: { priority: string; status: string; assignee: string }
  users: User[]
  isManager: boolean
  onApply: (f: { priority: string; status: string; assignee: string }) => void
  onClose: () => void
}) {
  useEscape(onClose)
  const [f, setF] = useState({ priority: filters.priority, status: filters.status, assignee: filters.assignee })
  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal search-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Filter tasks">
        <div className="card-head spread"><h3>Filter tasks</h3><button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          <label>Priority
            <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              <option value="">All priorities</option>
              {['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}
            </select>
          </label>
          <label>Status
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="">All statuses</option>
              {['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          {isManager && (
            <label>Assignee
              <select value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
                <option value="">All assignees</option>
                <option value="unassigned">Unassigned</option>
                {users.filter((u) => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={() => { onApply({ priority: '', status: '', assignee: '' }); onClose() }}>Clear all</button>
            <button className="btn btn-primary" onClick={() => { onApply(f); onClose() }}>Apply filters</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Tasks({ personal = false }: { personal?: boolean }) {
  const { user } = useAuth()
  // Dashboard KPI cards deep-link here, e.g. /tasks?view=completed or
  // /tasks?status=Blocked — seed the quick view / status filter from the URL.
  const [searchParams, setSearchParams] = useSearchParams()
  const QUICK_VIEWS = ['active', 'overdue', 'today', 'completed'] as const
  const urlView = searchParams.get('view')
  const urlStatus = searchParams.get('status')
  const initialQuick = (QUICK_VIEWS as readonly string[]).includes(urlView || '')
    ? (urlView as 'active' | 'overdue' | 'today' | 'completed')
    // A Done deep-link (e.g. clicking "Done" on the dashboard) must land on the
    // Completed view — the default 'active' view hides Done tasks, so pairing it
    // with status=Done would filter everything out and show "No tasks".
    : (urlStatus === 'Done' ? 'completed' : 'active')
  const [tasks, setTasks] = useState<Task[]>([])
  const [users, setUsers] = useState<User[]>([])
  // Opening a task by id (e.g. ?task=… from a clicked notification) shows its drawer.
  const [openId, setOpenId] = useState<string | null>(searchParams.get('task'))
  const [showNew, setShowNew] = useState(false)
  const [view, setView] = useState<'list' | 'board'>('list')
  // Search is collapsed to just an icon by default; tapping it reveals the input.
  const [searchOpen, setSearchOpen] = useState(false)
  // Mobile-only Filters dialog (the inline desktop dropdowns are CSS-hidden on phones).
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [quickView, setQuickView] = useState<'active' | 'overdue' | 'today' | 'completed'>(initialQuick)
  const [filters, setFilters] = useState<{ q: string; priority: string; status: string; assignee: string }>({ q: '', priority: searchParams.get('priority') || '', status: searchParams.get('status') || '', assignee: searchParams.get('assignee') || '' })
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'time', dir: 'desc' })
  // Click a header: toggle direction if it's the active column, else switch to it (default desc).
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))

  const [loadError, setLoadError] = useState(false)
  // True only until the FIRST response lands. Without it, the initial fetch is
  // indistinguishable from a genuinely empty list, so users briefly saw the
  // "You're all caught up!" empty state before their rows popped in.
  const [loading, setLoading] = useState(true)
  // Guard against out-of-order responses: only the latest request may apply state.
  const reqIdRef = useRef(0)
  const load = () => {
    const myReq = ++reqIdRef.current
    setLoadError(false)
    const p = new URLSearchParams()
    Object.entries(filters).forEach(([k, v]) => v && p.set(k, v))
    if (personal) p.set('mine', '1') // My Tasks: only the current user's own tasks
    api.get('/tasks?' + p.toString())
      .then((d) => { if (myReq === reqIdRef.current) { setTasks(d); setLoading(false) } })
      .catch(() => { if (myReq === reqIdRef.current) { setLoadError(true); setLoading(false) } })
  }
  // Re-fetch on `personal` too: /tasks and /my-tasks reuse this same component, so
  // navigating between them flips `personal` without changing `filters` — without
  // this dep the list would keep showing the previous route's tasks until a refresh.
  useEffect(() => { load() }, [filters, personal])
  useEffect(() => { api.get('/users').then(setUsers) }, [])

  // Deep-links (dashboard KPI cards, voice navigation) can arrive while this page
  // is ALREADY mounted. The useState initializers above only run once, so the URL
  // would change while the filters stayed stale — sync them explicitly here.
  const spPriority = searchParams.get('priority') || ''
  const spStatus = searchParams.get('status') || ''
  const spAssignee = searchParams.get('assignee') || ''
  const spView = searchParams.get('view') || ''
  useEffect(() => {
    setFilters((f) => (f.priority === spPriority && f.status === spStatus && f.assignee === spAssignee
      ? f // nothing to do — don't retrigger the load effect
      : { ...f, priority: spPriority, status: spStatus, assignee: spAssignee }))
    // Mirror the mount-time rule: an explicit view wins, a Done deep-link means
    // "completed", otherwise fall back to the active view.
    setQuickView((QUICK_VIEWS as readonly string[]).includes(spView)
      ? (spView as typeof quickView)
      : (spStatus === 'Done' ? 'completed' : 'active'))
  }, [spPriority, spStatus, spAssignee, spView])
  // Refresh when the voice assistant (or another surface) changes tasks while
  // this list is already mounted.
  useEffect(() => {
    const onChanged = () => load()
    window.addEventListener('tasks-changed', onChanged)
    return () => window.removeEventListener('tasks-changed', onChanged)
  }, [filters, personal])

  // If navigated here with ?task=… (e.g. by clicking a notification) while already
  // on this page, open that task's drawer too.
  useEffect(() => {
    const t = searchParams.get('task')
    if (t) setOpenId(t)
  }, [searchParams])

  // Close the drawer and drop the ?task= param so it stays closed and the URL is clean.
  const closeDrawer = () => {
    setOpenId(null)
    if (searchParams.get('task')) {
      const next = new URLSearchParams(searchParams)
      next.delete('task')
      setSearchParams(next, { replace: true })
    }
  }

  // Android back button: close the open task drawer / new-task modal first.
  useEffect(() => pushBackHandler(() => {
    if (filtersOpen) { setFiltersOpen(false); return true }
    if (showNew) { setShowNew(false); return true }
    if (openId) { setOpenId(null); return true }
    return false
  }), [showNew, openId, filtersOpen])

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
  const visibleTasks = useMemo(() => tasks.filter((t) => matchesQuick(t, quickView)), [tasks, quickView])
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
  // inside a date, never the dates themselves. Memoized: this grouping+sort used
  // to recompute on every keystroke-driven re-render.
  const groupedByDay = useMemo(() => {
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
  }, [visibleTasks, sort.key, sort.dir])

  // Priority sort is special: instead of grouping by day, mix ALL tasks across
  // every date into one flat list ordered purely by priority (Critical → High →
  // Medium → Low). Ties keep newest-activity-first. Only the priority column
  // behaves this way; every other column stays day-grouped.
  const sortedByPriority = useMemo(() => [...visibleTasks].sort((a, b) => {
    const cmp = cmpAsc(a, b, 'priority')
    if (cmp !== 0) return sort.dir === 'desc' ? -cmp : cmp
    return givenOf(b).localeCompare(givenOf(a)) // tie-break: newest first
  }), [visibleTasks, sort.dir])

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

  // Every mutation endpoint returns the updated task — patch it into the list in
  // place instead of re-fetching everything (a full reload after each inline edit
  // made the whole table flash and re-render). Failures fall back to a reload.
  const patchTask = (updated: Task) => setTasks((ts) => ts.map((t) => (t.id === updated.id ? updated : t)))

  // Inline assign from the table row (managers only). Sets owner + flips confidence to confirmed.
  const assign = (taskId: string, userId: string) => {
    if (!userId) return
    api.patch(`/tasks/${taskId}`, { assignee_id: userId }).then(patchTask).catch(() => load())
  }
  // Inline priority change from the report row (managers only).
  const changePriority = (taskId: string, priority: string) =>
    api.patch(`/tasks/${taskId}`, { priority }).then(patchTask).catch(() => load())
  // Inline approve: a manager marks an In-Review task as Done straight from the row.
  const markDone = (taskId: string) =>
    api.post(`/tasks/${taskId}/approve`, { decision: 'approved' }).then(patchTask).catch(() => load())

  // Board drag-and-drop: optimistically move the card, then persist via the status API.
  const moveStatus = (taskId: string, status: string) => {
    setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, status } : t)))
    api.post(`/tasks/${taskId}/status`, { status }).then(patchTask).catch(() => load())
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
      <td className="cell-title"><div style={{ fontWeight: 600 }}>{t.title}</div><span className="row" style={{ gap: 6 }}><ConfidenceTag c={t.ownership_confidence} /><CategoryBadge c={t.category} /></span></td>
      <td data-label="Priority">
        {isManager ? (
          <select
            value={t.priority}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => { e.stopPropagation(); changePriority(t.id, e.target.value) }}
            style={{ width: 'auto', padding: '4px 8px', fontSize: 12.5, fontWeight: 700, color: PRIORITY_COLORS[t.priority], borderColor: (PRIORITY_COLORS[t.priority] || '#cbd5e1') + '88' }}
          >
            {['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p} value={p} style={{ color: '#16191d' }}>{p}</option>)}
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
  const completedRows = useMemo(
    () => [...visibleTasks].sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '')),
    [visibleTasks])
  const renderCompletedRow = (t: Task) => (
    <tr key={t.id} className="clickable" onClick={() => setOpenId(t.id)}>
      <td className="cell-title"><div style={{ fontWeight: 600 }}>{t.title}</div><CategoryBadge c={t.category} /></td>
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
        {/* search + sort + new task stay together on one line (esp. on mobile).
            `.toolbar-actions` is display:contents on desktop so these flow into the
            toolbar individually, and a single nowrap flex row on mobile. */}
        <div className="toolbar-actions">
          {/* Search opens a dialog (type or speak) — keeps the toolbar aligned.
              When a search is active, show a compact chip to edit/clear it. */}
          {filters.q ? (
            <div className="search-active toolbar-search">
              <button className="search-active-label" onClick={() => setSearchOpen(true)} title="Edit search">
                <SearchIcon size={14} /> <span className="search-active-q">{filters.q}</span>
              </button>
              <button className="search-active-clear" onClick={() => setFilters({ ...filters, q: '' })} title="Clear search" aria-label="Clear search">✕</button>
            </div>
          ) : (
            <button className="icon-btn toolbar-search" onClick={() => setSearchOpen(true)} title="Search tasks" aria-label="Search tasks">
              <SearchIcon />
            </button>
          )}
          {/* MOBILE-ONLY: sort the visible tasks. 'time' (newest first) is the default
              "show everything" order; the rest pick a sensible direction per column. */}
          {view === 'list' && (
            <SortMenu
              sortKey={sort.key}
              onPick={(key) => setSort({ key, dir: key === 'time' || key === 'priority' ? 'desc' : 'asc' })}
            />
          )}
          {/* MOBILE-ONLY: the priority/status/assignee filters, in a dialog — the
              inline desktop dropdowns below are hidden on phones, which used to
              leave mobile with no way to filter at all. */}
          <button className="icon-btn toolbar-filterbtn" onClick={() => setFiltersOpen(true)} title="Filter tasks" aria-label="Filter tasks">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="22 3 2 3 10 12.5 10 19 14 21 14 12.5 22 3" />
            </svg>
            {(Number(!!filters.priority) + Number(!!filters.status) + Number(!!filters.assignee)) > 0 && (
              <span className="filterbtn-dot">{Number(!!filters.priority) + Number(!!filters.status) + Number(!!filters.assignee)}</span>
            )}
          </button>
          <button className="btn btn-primary btn-sm toolbar-newtask" onClick={() => setShowNew(true)}>+ New task</button>
        </div>
        {/* DESKTOP: the three filter dropdowns (+ sortable column headers). Hidden on
            mobile, where the Sort control above takes their place instead. */}
        <div className="toolbar-filters">
          <select value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })}>
            <option value="">All priorities</option>{['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}
          </select>
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            <option value="">All statuses</option>{['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened'].map((s) => <option key={s}>{s}</option>)}
          </select>
          {isManager && (
            <select value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value })}>
              <option value="">All assignees</option>
              <option value="unassigned">Unassigned</option>
              {users.filter(u => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* Line 1: View toggle (left) + the "Active" chip. */}
      <div className="viewbar">
        <div className="seg">
          <button className={'seg-btn row' + (view === 'list' ? ' active' : '')} style={{ gap: 6 }} onClick={() => setView('list')} title="List view"><Ic name="menu" size={14} /> List</button>
          <button className={'seg-btn row' + (view === 'board' ? ' active' : '')} style={{ gap: 6 }} onClick={() => setView('board')} title="Board view"><Ic name="board" size={14} /> Board</button>
        </div>
        {view === 'list' && tasks.length > 0 && QUICK_CHIPS.filter((c) => c.key === 'active').map((c) => {
          const count = tasks.filter((t) => matchesQuick(t, c.key)).length
          return (
            <button key={c.key} className={'chip' + (quickView === c.key ? ' active' : '')} onClick={() => setQuickView(c.key)}>
              {c.label}<span className="chip-count">{count}</span>
            </button>
          )
        })}
      </div>

      {/* Line 2: the remaining quick-view chips (Overdue, Due today, Completed) — kept on one line. */}
      {view === 'list' && tasks.length > 0 && (
        <div className="chips chips-quick">
          {QUICK_CHIPS.filter((c) => c.key !== 'active').map((c) => {
            const count = tasks.filter((t) => matchesQuick(t, c.key)).length
            return (
              <button
                key={c.key}
                className={'chip' + (c.danger ? ' danger' : '') + (quickView === c.key ? ' active' : '')}
                onClick={() => setQuickView(c.key)}
              >
                {c.label}<span className="chip-count">{count}</span>
              </button>
            )
          })}
        </div>
      )}

      {loadError ? (
        <div className="card">
          <EmptyState icon={<Ic name="warning" size={40} />} title="Couldn't load tasks" hint="Check your connection and try again."
            action={<button className="btn btn-primary btn-sm" onClick={load}>Retry</button>} />
        </div>
      ) : loading ? (
        /* First fetch in flight: skeleton rows, never the "all caught up" empty state. */
        <div className="card table-card-wrap" aria-busy="true">
          <div className="card-pad">{Array.from({ length: 6 }).map((_, i) => <span key={i} className="skeleton skel-row" />)}</div>
        </div>
      ) : view === 'board' ? (
        tasks.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<Ic name="check" size={40} />}
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
          {visibleTasks.length === 0 ? (
            <div className="card">
              {quickView === 'completed' ? (
                <EmptyState
                  icon={<Ic name="box" size={40} />}
                  title="No completed tasks yet"
                  hint="Tasks marked Done and accepted by a manager will appear here, with their assigned and completed dates."
                />
              ) : narrowed ? (
                <EmptyState
                  icon={<Ic name="search" size={40} />}
                  title="No tasks match your filters"
                  hint="Try a different search term, or clear the filters to see everything."
                  action={<button className="btn btn-sm" onClick={clearFilters}>Clear filters</button>}
                />
              ) : (
                <EmptyState
                  icon={<Ic name="check" size={40} />}
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

      {/* Mobile floating action button — the primary "add" action, in thumb reach.
          Replaces the toolbar "+ New task" button on phones (hidden there via CSS). */}
      <button className="fab-newtask" onClick={() => setShowNew(true)} aria-label={personal ? 'New personal task' : 'New task'} title={personal ? 'New personal task' : 'New task'}>
        <Ic name="plus" size={24} />
      </button>

      {/* Drawer edits patch the single row in place when the mutation returned the
          updated task; anything else (delete, uploads) falls back to a reload. */}
      {openId && <TaskDrawer taskId={openId} onClose={closeDrawer} onChange={(t) => (t && t.status ? patchTask(t) : load())} />}
      {showNew && <NewTaskModal users={users} personal={personal} onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />}
      {searchOpen && <SearchDialog initial={filters.q} onApply={(f) => { setFilters({ ...filters, ...f }); if (f.status === 'Done') setQuickView('completed') }} onClose={() => setSearchOpen(false)} />}
      {filtersOpen && (
        <FiltersDialog
          filters={filters}
          users={users}
          isManager={isManager}
          onApply={(f) => { setFilters({ ...filters, ...f }); if (f.status === 'Done') setQuickView('completed') }}
          onClose={() => setFiltersOpen(false)}
        />
      )}
    </>
  )
}

function NewTaskModal({ users, personal, onClose, onCreated }: { users: User[]; personal?: boolean; onClose: () => void; onCreated: () => void }) {
  const { user } = useAuth()
  useEscape(onClose)
  const isEmployee = user?.role === 'employee'
  // Private only in My Tasks (personal) mode. Everywhere else, anyone may assign
  // the task to anyone — so the assignee picker is shown to everyone.
  const asPersonal = !!personal
  // Default the owner to yourself (so it shows in your list); managers triage, so
  // they default to Unassigned.
  const [form, setForm] = useState<any>({ title: '', description: '', priority: 'Medium', assignee_id: isEmployee ? (user?.id || '') : '', due_date: dueDateForPriority('Medium') })
  // Once the user picks a date by hand, stop auto-syncing it to the priority.
  const [dueManual, setDueManual] = useState(false)
  // Change priority and keep the due date in step (unless the user set it by hand).
  const setPriority = (priority: string) =>
    setForm((f: any) => ({ ...f, priority, due_date: dueManual ? f.due_date : dueDateForPriority(priority) }))
  const [busy, setBusy] = useState(false)
  // Reference files staged in the form; uploaded to the task right AFTER it's
  // created (the task has no id until then). Images/PDFs/videos up to 50 MB.
  const ATTACH_MAX = 50 * 1024 * 1024
  const [files, setFiles] = useState<File[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const addFiles = (list: FileList | null) => {
    if (!list) return
    const picked = Array.from(list)
    const ok = picked.filter((f) => (/^(image|video)\//.test(f.type) || f.type === 'application/pdf') && f.size <= ATTACH_MAX)
    const rejected = picked.length - ok.length
    if (rejected) toast.error(`${rejected} file(s) skipped — only images, PDFs and videos under 50 MB are allowed.`)
    setFiles((prev) => [...prev, ...ok])
    if (fileInput.current) fileInput.current.value = ''
  }
  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i))
  const save = async () => {
    if (!form.title) return
    setBusy(true)
    try {
      const created = await api.post('/tasks', { ...form, personal: asPersonal })
      // Upload staged attachments to the freshly-created task (best-effort per file).
      for (const f of files) {
        try { await api.upload(`/tasks/${created.id}/attachments`, f) }
        catch { toast.error(`Couldn't attach ${f.name}`) }
      }
      onCreated()
    } finally { setBusy(false) }
  }

  // ---- Voice input: record a short clip and transcribe it SERVER-SIDE (Sarvam /
  // Whisper), which is far more reliable on Android and for Telugu/Hindi/English
  // code-mixing than the browser's SpeechRecognition. The AI then extracts the
  // title, description, assignee, priority & due date and fills the form. ----
  const canRecord = typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof (window as any).MediaRecorder !== 'undefined'
  const mrRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const [listening, setListening] = useState(false) // actively recording
  const [parsing, setParsing] = useState(false)     // transcribing + AI extraction
  const [heard, setHeard] = useState('')
  // Read the "user picked a date by hand" flag from a ref so the async voice
  // handler always sees the CURRENT value (not a stale render closure).
  const dueManualRef = useRef(dueManual)
  useEffect(() => { dueManualRef.current = dueManual }, [dueManual])

  // Stop recording and release the mic device.
  const releaseMic = () => {
    try { if (mrRef.current && mrRef.current.state !== 'inactive') mrRef.current.stop() } catch {}
    try { streamRef.current?.getTracks().forEach((t) => t.stop()) } catch {}
    streamRef.current = null
  }
  useEffect(() => releaseMic, []) // release on unmount (close)

  // Merge the AI-extracted fields into the form. Assignee applies only when not in
  // personal mode. The due date is NEVER left blank: spoken date wins, else it
  // tracks the priority unless the user already picked one by hand.
  const applyVoice = async (transcript: string) => {
    const text = transcript.trim()
    if (!text) return
    const d = await api.post('/tasks/parse-voice', { transcript: text })
    if (d.due_date) { setDueManual(true); dueManualRef.current = true }
    setForm((f: any) => {
      const priority = d.priority || f.priority
      const due = d.due_date
        || (dueManualRef.current ? f.due_date : '')
        || dueDateForPriority(priority)
      return {
        ...f,
        title: d.title || f.title || text,
        description: d.description || f.description,
        priority,
        due_date: due,
        assignee_id: !asPersonal && d.assignee_id ? d.assignee_id : f.assignee_id,
      }
    })
  }

  // Upload the recorded clip → transcript → structured fields.
  const transcribeAndApply = async (blob: Blob) => {
    setParsing(true)
    try {
      const fd = new FormData()
      fd.append('audio', blob, 'task.webm')
      const headers: Record<string, string> = {}
      const token = getToken()
      if (token) headers.authorization = `Bearer ${token}`
      const res = await fetch(`${API_BASE}/api/tasks/transcribe`, { method: 'POST', headers, body: fd, cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || `Transcription failed (${res.status})`)
      const text = String(data?.text || '').trim()
      setHeard(text)
      if (!text) { toast.info("Didn't catch that — please tap Speak and try again."); return }
      await applyVoice(text)
    } catch (err: any) {
      toast.error(err?.message || 'Could not transcribe the audio. Check your connection and try again.')
    } finally { setParsing(false) }
  }

  const toggleMic = async () => {
    // Tapping while recording = Stop → onstop transcribes the captured clip.
    if (listening) {
      setListening(false)
      try { mrRef.current?.stop() } catch {}
      return
    }
    if (!canRecord) { toast.error('Voice input needs microphone access on this device.'); return }
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch { toast.error('Microphone access is blocked. Allow mic permission for this app and try again.'); return }
    streamRef.current = stream
    chunksRef.current = []
    let mr: MediaRecorder
    try { mr = new MediaRecorder(stream, { mimeType: 'audio/webm' }) } catch { mr = new MediaRecorder(stream) }
    mrRef.current = mr
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data) }
    mr.onstop = () => {
      try { streamRef.current?.getTracks().forEach((t) => t.stop()) } catch {}
      streamRef.current = null
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' })
      chunksRef.current = []
      if (blob.size) transcribeAndApply(blob)
    }
    setHeard('')
    try { mr.start() } catch { setListening(false); releaseMic(); return }
    setListening(true)
  }

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3>{asPersonal ? 'New personal task' : 'New task'}</h3><button className="btn btn-ghost" onClick={onClose}>✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          {asPersonal && <div className="muted row" style={{ gap: 7, fontSize: 12, background: 'var(--info-bg)', border: '1px solid var(--info-border)', color: 'var(--info-ink)', borderRadius: 8, padding: '8px 10px' }}><Ic name="lock" size={13} /> Private to you — only you can see this task.</div>}
          <div>
            <label>
              Title
              {listening && <span style={{ color: '#dc2626', fontWeight: 700, fontSize: 11 }}> ● recording…</span>}
              {parsing && <span style={{ color: 'var(--primary)', fontWeight: 700, fontSize: 11 }}> ● understanding…</span>}
            </label>
            {canRecord && (
              <div className="speak-row">
                <button
                  type="button"
                  className={'btn btn-mic btn-mic-hero' + (listening ? ' btn-mic-live' : '')}
                  onClick={toggleMic}
                  disabled={parsing}
                  title="Speak the task — AI fills in the title, details, assignee & priority"
                >
                  {parsing
                    ? <><span className="spinner" /> Thinking…</>
                    : listening
                      ? <><span className="mic-dot" /> Stop recording</>
                      : <><MicIcon size={18} /> Speak your task</>}
                </button>
              </div>
            )}
            {canRecord && !listening && !parsing && !heard && (
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6, textAlign: 'center' }}>
                Tip: say the whole task — e.g. “High priority task for Ravi to fix the login page bug by Friday.”
              </div>
            )}
            {listening && (
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6, textAlign: 'center' }}>Listening… tap Stop when you're done.</div>
            )}
            {parsing && heard && (
              <div className="muted" style={{ fontSize: 12, marginTop: 6, fontStyle: 'italic', textAlign: 'center' }}>“{heard}”</div>
            )}
            <AutoTextarea style={{ width: '100%', marginTop: 8 }} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="What needs doing?" autoFocus />
          </div>
          <div><label>Description</label><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div className={asPersonal ? 'grid grid-2' : 'grid grid-3'} style={{ gap: 10 }}>
            <div><label>Priority</label><select value={form.priority} onChange={(e) => setPriority(e.target.value)}>{['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}</select></div>
            {!asPersonal && <div><label>Assignee</label><select value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}><option value="">Unassigned</option>{users.filter(u => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}{u.id === user?.id ? ' (me)' : ''}</option>)}</select></div>}
            <div><label>Due date {!dueManual && <span className="muted" style={{ fontWeight: 500, fontSize: 10.5 }}>· auto from priority</span>}</label><input type="date" value={form.due_date} onChange={(e) => { setDueManual(true); setForm({ ...form, due_date: e.target.value }) }} /></div>
          </div>
          <div><label>Category {!form.category && <span className="muted" style={{ fontWeight: 500, fontSize: 10.5 }}>· auto-detected if left blank</span>}</label>
            <select value={form.category || ''} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="">Auto-detect</option>
              {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label>Attachments <span className="muted" style={{ fontWeight: 500, fontSize: 10.5 }}>· reference images, PDFs or videos</span></label>
            <input ref={fileInput} type="file" multiple accept="image/*,application/pdf,video/*" style={{ display: 'none' }} onChange={(e) => addFiles(e.target.files)} />
            <button type="button" className="btn btn-sm row" style={{ gap: 6 }} onClick={() => fileInput.current?.click()}><Ic name="attach" size={14} /> Attach files</button>
            {files.length > 0 && (
              <div className="attach-stage">
                {files.map((f, i) => (
                  <div key={i} className="attach-chip">
                    <Ic name={f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : 'doc'} size={14} />
                    <span className="attach-chip-name" title={f.name}>{f.name}</span>
                    <span className="muted" style={{ fontSize: 11 }}>{fmtBytes(f.size)}</span>
                    <button type="button" className="attach-chip-x" onClick={() => removeFile(i)} aria-label={`Remove ${f.name}`}>✕</button>
                  </div>
                ))}
              </div>
            )}
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
