import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, User } from '../api'
import { Avatar, EmptyState, Ic, PriorityBadge, StatusBadge, fmtDateTime } from '../ui'

// The Tasks page's third view: everything that happened to the work, read top
// to bottom — created, assigned, moved, completed, reopened, deleted — with who
// did it. One row is one entry of GET /tasks/activity; the route explains how
// each audit action becomes a kind.

type IcName = Parameters<typeof Ic>[0]['name']
type Tone = 'primary' | 'success' | 'warning' | 'info' | 'danger'
type Person = { id: string; name: string; avatar_color?: string }

export interface ActivityItem {
  id: string; kind: string; action: string; at: string
  status_to: string | null; fields: string[]; file: string | null
  actor: Person | null
  target: { id: string; name: string } | null
  meeting: { id: string; title: string } | null
  task: {
    id: string; title: string; state: 'live' | 'deleted' | 'gone'
    priority?: string | null; status?: string | null; category?: string | null
    assignee: Person | null
  }
}

// Chip order is the order work moves through. Keys and kinds mirror
// ACTIVITY_GROUPS on the server, which does the actual filtering.
const GROUPS: { key: string; label: string; kinds: string[] }[] = [
  { key: 'created', label: 'Created', kinds: ['created'] },
  { key: 'assigned', label: 'Assigned', kinds: ['assigned', 'reassigned', 'split'] },
  { key: 'progress', label: 'Started', kinds: ['started', 'todo'] },
  { key: 'blocked', label: 'Blocked', kinds: ['blocked'] },
  { key: 'submitted', label: 'Submitted', kinds: ['submitted'] },
  { key: 'completed', label: 'Completed', kinds: ['completed', 'approved'] },
  { key: 'reopened', label: 'Reopened', kinds: ['reopened', 'rejected'] },
  { key: 'edited', label: 'Edited', kinds: ['edited'] },
  { key: 'commented', label: 'Comments', kinds: ['commented'] },
  { key: 'attached', label: 'Files', kinds: ['attached'] },
  { key: 'deleted', label: 'Deleted', kinds: ['deleted', 'purged'] },
  { key: 'restored', label: 'Restored', kinds: ['restored'] },
]
const GROUP_OF_KIND: Record<string, (typeof GROUPS)[number]> =
  Object.fromEntries(GROUPS.flatMap((g) => g.kinds.map((k) => [k, g])))

const LOOK: Record<string, { icon: IcName; tone: Tone }> = {
  created: { icon: 'taskAdd', tone: 'primary' },
  assigned: { icon: 'user', tone: 'primary' },
  reassigned: { icon: 'swap', tone: 'warning' },
  split: { icon: 'scissors', tone: 'primary' },
  started: { icon: 'play', tone: 'info' },
  todo: { icon: 'arrowLeft', tone: 'info' },
  blocked: { icon: 'block', tone: 'danger' },
  submitted: { icon: 'send', tone: 'info' },
  completed: { icon: 'check', tone: 'success' },
  approved: { icon: 'check', tone: 'success' },
  reopened: { icon: 'refresh', tone: 'warning' },
  rejected: { icon: 'refresh', tone: 'warning' },
  edited: { icon: 'edit', tone: 'info' },
  commented: { icon: 'chat', tone: 'info' },
  attached: { icon: 'attach', tone: 'info' },
  deleted: { icon: 'trash', tone: 'danger' },
  purged: { icon: 'trash', tone: 'danger' },
  restored: { icon: 'box', tone: 'success' },
}

// What the actor did, as the rest of the sentence after their name.
function describe(e: ActivityItem): React.ReactNode {
  switch (e.kind) {
    case 'created':
      // Made up from the task itself (no create entry): a meeting task, whose
      // "actor" is the person who asked for the work in that meeting.
      return e.action === 'task.made' && e.meeting
        ? <>assigned it in the meeting <b>“{e.meeting.title}”</b></>
        : 'created it'
    case 'assigned': return e.target ? <>assigned it to <b>{e.target.name}</b></> : 'unassigned it'
    case 'reassigned': return <>reassigned it to <b>{e.target?.name || 'someone else'}</b></>
    case 'split': return <>split off this part for <b>{e.target?.name || 'a colleague'}</b></>
    case 'started': return <>moved it to <b>In Progress</b></>
    case 'todo': return <>moved it back to <b>To Do</b></>
    case 'blocked': return <>marked it <b>Blocked</b></>
    case 'submitted': return <>submitted it for <b>review</b></>
    case 'completed':
      return e.action === 'task.rollup'
        ? <>finished its last part, so it closed as <b>Done</b></>
        : <>marked it <b>Done</b></>
    case 'approved': return <>approved it, so it is <b>Done</b></>
    case 'reopened':
      return e.action === 'task.rollup'
        ? <>reopened one of its parts, so it <b>reopened</b> too</>
        : <><b>reopened</b> it</>
    case 'rejected': return <>sent it back: <b>needs changes</b></>
    case 'edited': return <>changed the {e.fields.join(', ') || 'details'}</>
    case 'commented':
      return e.action === 'task.comment.edit' ? 'edited a comment'
        : e.action === 'task.comment.delete' ? 'deleted a comment' : 'commented'
    case 'attached': return e.file ? <>attached <b>{e.file}</b></> : 'attached a file'
    case 'deleted': return <><b>deleted</b> it</>
    case 'purged': return <>deleted it <b>permanently</b></>
    case 'restored': return 'restored it from Deleted Tasks'
    default: return e.kind
  }
}

const RANGES = [
  { key: 'any', label: 'Any time' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'custom', label: 'Custom dates…' },
]
// Bounds are worked out here, in the viewer's own timezone, and sent as UTC
// instants — the server runs in UTC and must not decide when "today" starts.
function rangeBounds(range: string, from: string, to: string): { since?: string; until?: string } {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const days = (n: number, base = today) => { const d = new Date(base); d.setDate(d.getDate() + n); return d }
  switch (range) {
    case 'today': return { since: today.toISOString() }
    case 'yesterday': return { since: days(-1).toISOString(), until: today.toISOString() }
    case '7d': return { since: days(-6).toISOString() }
    case '30d': return { since: days(-29).toISOString() }
    case 'month': return { since: new Date(today.getFullYear(), today.getMonth(), 1).toISOString() }
    case 'custom': return {
      since: from ? new Date(from + 'T00:00:00').toISOString() : undefined,
      until: to ? days(1, new Date(to + 'T00:00:00')).toISOString() : undefined,
    }
    default: return {}
  }
}

const SORTS = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'task', label: 'Task (A–Z)' },
  { key: 'person', label: 'Person (A–Z)' },
  { key: 'type', label: 'Activity type' },
  { key: 'priority', label: 'Priority' },
]
const PRIORITY_ORDER = ['Critical', 'High', 'Medium', 'Low']
const isTimeSort = (s: string) => s === 'newest' || s === 'oldest'

const localDay = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// Same wording as the list's day groups: "Today · Wednesday, 22 October 2026".
function dayHeading(day: string) {
  const d = new Date(day + 'T00:00:00')
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const diff = Math.round((today.getTime() - d.getTime()) / 86400000)
  const rel = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : null
  const full = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  return rel ? `${rel} · ${full}` : full
}
// The heading rows follow whatever the list is sorted by, so a sort by person
// reads as one block per person rather than a flat run of names.
function groupOf(e: ActivityItem, sort: string): { key: string; label: string } {
  switch (sort) {
    case 'task': return { key: e.task.id, label: e.task.title }
    case 'person': return { key: e.actor?.id || '-', label: e.actor?.name || 'Someone' }
    case 'type': { const g = GROUP_OF_KIND[e.kind]; return { key: g?.key || e.kind, label: g?.label || e.kind } }
    case 'priority': return { key: e.task.priority || '-', label: e.task.priority || 'No priority' }
    default: { const day = localDay(e.at); return { key: day, label: dayHeading(day) } }
  }
}

const PAGE = 50

export default function TaskActivity({ filters, users, personal, refreshKey, onOpen, onClearPageFilters }: {
  // The page toolbar's own search and filters apply here too: search matches the
  // task, the person who acted or the owner; status is the task's status now.
  filters: { q: string; priority: string; status: string; assignee: string }
  users: User[]
  personal: boolean
  refreshKey: number
  onOpen: (taskId: string) => void
  onClearPageFilters: () => void
}) {
  const [picked, setPicked] = useState<string[]>([])
  const [actor, setActor] = useState('')
  const [range, setRange] = useState('any')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sort, setSort] = useState('newest')

  const [items, setItems] = useState<ActivityItem[]>([])
  const [total, setTotal] = useState(0)
  const [all, setAll] = useState(0)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState(false)
  const reqRef = useRef(0)

  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (picked.length) p.set('types', picked.join(','))
    if (actor) p.set('actor', actor)
    if (filters.q) p.set('q', filters.q)
    if (filters.priority) p.set('priority', filters.priority)
    if (filters.status) p.set('status', filters.status)
    if (filters.assignee) p.set('assignee', filters.assignee)
    if (personal) p.set('mine', '1')
    const b = rangeBounds(range, from, to)
    if (b.since) p.set('since', b.since)
    if (b.until) p.set('until', b.until)
    p.set('sort', sort)
    p.set('limit', String(PAGE))
    return p
  }, [picked, actor, filters, personal, range, from, to, sort])

  // offset 0 replaces the list; anything else appends the next page. Only the
  // newest request may land, so a quick run of filter clicks can't interleave.
  const fetchPage = (offset: number) => {
    const my = ++reqRef.current
    const p = new URLSearchParams(query)
    p.set('offset', String(offset))
    if (offset) setMore(true); else setError(false)
    api.get('/tasks/activity?' + p.toString())
      .then((d) => {
        if (my !== reqRef.current) return
        setItems((prev) => (offset ? [...prev, ...d.items] : d.items))
        setTotal(d.total); setAll(d.all); setCounts(d.counts || {})
      })
      .catch(() => { if (my === reqRef.current && !offset) setError(true) })
      .finally(() => { if (my === reqRef.current) { setLoading(false); setMore(false) } })
  }
  useEffect(() => { fetchPage(0) }, [query, refreshKey])
  // The voice assistant and other surfaces announce their changes this way.
  useEffect(() => {
    const on = () => fetchPage(0)
    window.addEventListener('tasks-changed', on)
    return () => window.removeEventListener('tasks-changed', on)
  }, [query])

  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]))
  const narrowed = picked.length > 0 || !!actor || range !== 'any' ||
    !!(filters.q || filters.priority || filters.status || filters.assignee)
  const clearAll = () => {
    setPicked([]); setActor(''); setRange('any'); setFrom(''); setTo('')
    onClearPageFilters()
  }

  // Consecutive rows that share a heading; the server already sorted them.
  const sections = useMemo(() => {
    const out: { key: string; label: string; rows: ActivityItem[] }[] = []
    for (const e of items) {
      const g = groupOf(e, sort)
      const last = out[out.length - 1]
      if (last && last.key === g.key) last.rows.push(e)
      else out.push({ ...g, rows: [e] })
    }
    return out
  }, [items, sort])

  const people = useMemo(() => [...users].sort((a, b) => a.name.localeCompare(b.name)), [users])

  return (
    <div className="act">
      <div className="act-types" role="group" aria-label="Activity type">
        <button className={'chip' + (picked.length === 0 ? ' active' : '')} onClick={() => setPicked([])}>
          All activity<span className="chip-count">{all}</span>
        </button>
        {GROUPS.map((g) => (
          <button key={g.key} className={'chip' + (picked.includes(g.key) ? ' active' : '')} aria-pressed={picked.includes(g.key)}
            disabled={!counts[g.key] && !picked.includes(g.key)} onClick={() => toggle(g.key)}>
            {g.label}<span className="chip-count">{counts[g.key] || 0}</span>
          </button>
        ))}
      </div>

      <div className="act-bar">
        <select value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Done by">
          <option value="">Done by anyone</option>
          {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="When">
          {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        {range === 'custom' && (
          <span className="act-dates">
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <span className="muted">to</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </span>
        )}
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        {narrowed && <button className="btn btn-ghost btn-sm" onClick={clearAll}>Clear filters</button>}
        <span className="act-count">
          {loading ? '' : total === 0 ? '' : items.length < total ? `Showing ${items.length} of ${total}` : `${total} ${total === 1 ? 'activity' : 'activities'}`}
        </span>
      </div>

      {error ? (
        <div className="card">
          <EmptyState icon={<Ic name="warning" size={40} />} title="Couldn't load activity" hint="Check your connection and try again."
            action={<button className="btn btn-primary btn-sm" onClick={() => fetchPage(0)}>Retry</button>} />
        </div>
      ) : loading ? (
        <div className="card" aria-busy="true">
          <div className="card-pad">{Array.from({ length: 6 }).map((_, i) => <span key={i} className="skeleton skel-row" />)}</div>
        </div>
      ) : items.length === 0 ? (
        <div className="card">
          {narrowed ? (
            <EmptyState icon={<Ic name="search" size={40} />} title="No activity matches your filters"
              hint="Try another type, person or date range, or clear the filters to see everything."
              action={<button className="btn btn-sm" onClick={clearAll}>Clear filters</button>} />
          ) : (
            <EmptyState icon={<Ic name="clock" size={40} />} title="No activity yet"
              hint="Everything that happens to a task — created, assigned, completed, reopened, deleted — will show up here with who did it." />
          )}
        </div>
      ) : (
        <div className="card act-feed">
          {sections.map((s, si) => (
            <section key={s.key + ':' + si} className="act-section">
              <div className="act-head">
                <span className="act-head-label">{s.label}</span>
                <span className="day-group-count">{s.rows.length}</span>
              </div>
              <ol className="act-list">
                {s.rows.map((e) => <ActivityRow key={e.id} e={e} timeOnly={isTimeSort(sort)} onOpen={onOpen} />)}
              </ol>
            </section>
          ))}
          {items.length < total && (
            <div className="act-more">
              <button className="btn btn-sm" disabled={more} onClick={() => fetchPage(items.length)}>
                {more ? <span className="spinner" /> : `Load ${Math.min(PAGE, total - items.length)} more`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ActivityRow({ e, timeOnly, onOpen }: { e: ActivityItem; timeOnly: boolean; onOpen: (id: string) => void }) {
  const look = LOOK[e.kind] || { icon: 'doc' as IcName, tone: 'info' as Tone }
  // A deleted task has no drawer to open; the row stays readable, just inert.
  const live = e.task.state === 'live'
  const open = () => { if (live) onOpen(e.task.id) }
  const d = new Date(e.at)
  return (
    <li className={'act-row' + (live ? ' is-link' : ' is-gone')} data-kind={e.kind}
      {...(live ? { role: 'button', tabIndex: 0, onClick: open, onKeyDown: (ev: React.KeyboardEvent) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open() } } } : {})}>
      <span className="act-ic" data-tone={look.tone}><Ic name={look.icon} size={15} /></span>
      <div className="act-main">
        <div className="act-line">
          {e.actor
            ? <span className="act-who"><Avatar name={e.actor.name} color={e.actor.avatar_color} size={18} /> {e.actor.name}</span>
            : <span className="act-who">Someone</span>}{' '}
          {describe(e)}
        </div>
        <div className="act-task">{e.task.title}</div>
        <div className="act-meta">
          {e.task.priority && PRIORITY_ORDER.includes(e.task.priority) && <PriorityBadge p={e.task.priority} />}
          {live
            ? (e.task.status && <StatusBadge s={e.task.status} />)
            : <span className="act-gone">{e.task.state === 'deleted' ? 'In Deleted Tasks' : 'Deleted permanently'}</span>}
          {e.task.assignee && (
            <span className="act-owner"><Avatar name={e.task.assignee.name} color={e.task.assignee.avatar_color} size={16} /> {e.task.assignee.name}</span>
          )}
        </div>
      </div>
      <time className="act-time" dateTime={e.at} title={fmtDateTime(e.at)}>
        {timeOnly ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : fmtDateTime(e.at)}
      </time>
    </li>
  )
}
