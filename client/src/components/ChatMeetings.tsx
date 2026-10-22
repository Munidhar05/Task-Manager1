// "All meetings", "Meeting summaries" and a single meeting's summary: three views
// of the chat info panel (lib/chatInfo.ts holds the shapes and the endpoints).
//
// In a chat a meeting IS a call. Nobody schedules a separate meeting object; they
// ring the group. So the call log is the meeting list, and a summary hangs off the
// call it was recorded in. The summary renderer and the review screen are
// MeetingDetail's own exports, imported rather than copied: the meeting page and
// the panel must never disagree about what a meeting said, or about how its tasks
// get assigned.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { Suggestion, userAvatarUrl } from '../api'
import { pushBackHandler } from '../back'
import { Avatar, Ic, dueLabel, fmtDateTime } from '../ui'
import { toast } from '../lib/toast'
import { resolveConfirm } from '../lib/confirm'
import { listReviewDrafts, loadReviewDraft } from '../lib/reviewDraft'
import {
  chatInfoApi, canReview, fmtDay, fmtClock, fmtDuration, groupRuns,
  CallRow, Me, MeetingDetailPayload, MeetingRow, PersonLite, TaskCounts,
} from '../lib/chatInfo'
import { SUMMARY_SECTIONS, normalisePoints, SummaryPoint, sourceLabel, Assigner, ReviewAssignModal } from '../pages/MeetingDetail'

type IconName = React.ComponentProps<typeof Ic>['name']
type TaskRow = MeetingDetailPayload['tasks'][number]

// ------------------------------------------------------------------ helpers

// Timestamps arrive in two shapes: the app's ISO ('2026-09-30T06:44:46.490Z') and
// SQLite's own ('2026-09-29 08:35:17'), which is UTC but does not say so. new
// Date() reads the second as LOCAL time (five and a half hours out in India) and
// older Safari rejects it outright, so it is made ISO before anything parses it.
// The server normalises call times; meeting rows can be older than that.
const SQLITE_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/
const iso = (s?: string | null) => (!s ? '' : SQLITE_TS.test(s) ? s.replace(' ', 'T') + 'Z' : s)
const readable = (s: string) => !!s && !Number.isNaN(new Date(s).getTime())
const dayOf = (s?: string | null) => { const v = iso(s); return readable(v) ? fmtDay(v) : '' }
const clockOf = (s?: string | null) => { const v = iso(s); return readable(v) ? fmtClock(v) : '' }

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

// You are "You" in your own lists, as in any chat app. Someone whose account has
// since been deleted comes back as null and simply goes unmentioned.
const who = (p: { id: string; name: string } | null | undefined, me: Me) => (!p ? '' : p.id === me.id ? 'You' : p.name || 'Someone')

// 'Asha, Ravi and you' / 'Asha, Ravi and 3 others'. You go last, the way people
// say it.
function peopleText(people: PersonLite[], me: Me) {
  const names = people.filter((p) => p.id !== me.id).map((p) => p.name || 'Someone')
  if (people.some((p) => p.id === me.id)) names.push('you')
  if (!names.length) return ''
  if (names.length === 1) return names[0] === 'you' ? 'You' : names[0]
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`
}

// Who was there, as overlapping faces. Four and a count: at this size a fifth
// face is no longer recognisable, and the number says it better. Where the names
// are already written out beside it (or in the row's label) the stack is hidden
// from screen readers; `label` makes it speak for itself where they are not.
function Faces({ people, me, size = 20, label = false }: { people: PersonLite[]; me: Me; size?: number; label?: boolean }) {
  if (!people.length) return null
  const shown = people.slice(0, 4)
  const extra = people.length - shown.length
  const names = people.map((p) => who(p, me)).join(', ')
  return (
    <span className="ci-mt-faces" title={names} style={{ '--sz': `${size}px` } as React.CSSProperties}
      {...(label ? { role: 'img', 'aria-label': `With ${peopleText(people, me).replace(/^You$/, 'you')}` } : { 'aria-hidden': true })}>
      {shown.map((p) => (
        <Avatar key={p.id} name={p.name} color={p.avatar_color} size={size}
          src={p.avatar_file ? userAvatarUrl(p.id, p.avatar_file) : null} />
      ))}
      {extra > 0 && <span className="ci-mt-faces-more">+{extra}</span>}
    </span>
  )
}

// ------------------------------------------------------------------ loading

// The api helper keeps only the message. A network failure reads 'Failed to
// fetch' and a non-JSON reply a parser error, and neither means anything to the
// person looking at the panel.
function errText(e: any): string {
  if (e instanceof SyntaxError) return 'The server sent an unexpected reply.'
  const msg = String(e?.message || '')
  if (!msg || /failed to fetch|networkerror|load failed|network request failed/i.test(msg)) return 'Check your connection and try again.'
  return /[.!?]$/.test(msg) ? msg : msg + '.'
}
// 404 from either check the server makes: the meeting is gone, or you are no
// longer in the conversation it belongs to.
const isGone = (err: string) => /not found/i.test(err)

// One view's data. A refresh keeps what is on screen until the answer arrives
// (the review screen sits on top of a summary and must not unmount under a
// refresh), and an answer that lands after a newer request, or after the view
// closed, is dropped instead of painting stale data over fresh.
function useRemote<T>(key: string, load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const loadRef = useRef(load)
  useEffect(() => { loadRef.current = load })
  const reload = useCallback(() => {
    const n = ++seq.current
    setLoading(true)
    loadRef.current()
      .then((d) => { if (n === seq.current) { setData(d); setError('') } }, (e) => { if (n === seq.current) setError(errText(e)) })
      .finally(() => { if (n === seq.current) setLoading(false) })
  }, [])
  useEffect(() => {
    setData(null)
    setError('')
    reload()
    return () => { seq.current++ } // orphan whatever is still in flight
  }, [key, reload])
  return { data, error, loading, reload }
}

// Reviewing a summary changes the numbers the call list and the summary cards
// show. If the panel keeps those views mounted under the one on top, they hear
// about it here and refresh, instead of showing a count that is now wrong when
// you step back to them.
const changeListeners = new Set<(convId: string) => void>()
const announceChange = (convId: string) => changeListeners.forEach((l) => l(convId))
function useOnChange(convId: string, reload: () => void) {
  useEffect(() => {
    const l = (id: string) => { if (id === convId) reload() }
    changeListeners.add(l)
    return () => { changeListeners.delete(l) }
  }, [convId, reload])
}

function Loading({ rows = 5, hero = false }: { rows?: number; hero?: boolean }) {
  return (
    <div className="ci-mt" aria-busy="true">
      {hero && <span className="skeleton ci-skel ci-mt-skel-hero" />}
      {Array.from({ length: rows }, (_, i) => <span key={i} className="skeleton ci-skel" />)}
    </div>
  )
}

function Failed({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) {
  return (
    <div className="ci-error" role="alert">
      <Ic name="warning" />
      <span>Couldn't load {what}. {error}</span>
      <button type="button" className="btn btn-sm" onClick={onRetry}>Retry</button>
    </div>
  )
}

function Empty({ icon, title, children }: { icon: IconName; title: string; children: React.ReactNode }) {
  return (
    <div className="ci-empty">
      <div className="ci-empty-ic"><Ic name={icon} size={24} /></div>
      <div className="ci-empty-title">{title}</div>
      <div>{children}</div>
    </div>
  )
}

// A malformed row (a summary an AI engine shaped oddly, a field the server left
// out) must cost one view, not the chat page: nothing above the panel catches a
// render error, and React unmounts the whole app on one nobody catches. Retry
// remounts the view, which refetches.
class Contained extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="ci-error" role="alert">
        <Ic name="warning" />
        <span>Something went wrong showing this.</span>
        <button type="button" className="btn btn-sm" onClick={() => this.setState({ failed: false })}>Retry</button>
      </div>
    )
  }
}

// -------------------------------------------------------------------- calls

const isLive = (c: CallRow) => c.status === 'ringing' || c.status === 'active'

// How a call went, in the call log's words. Never "Missed": that reads as an
// accusation at whoever placed the call, and the person scrolling this list may
// well be the one who didn't pick up.
type Tone = 'live' | 'talked' | 'unanswered' | 'declined'
const TONE_ACCENT: Record<Tone, string> = { live: 'ci-ac-blue', talked: 'ci-ac-green', unanswered: 'ci-ac-red', declined: 'ci-ac-amber' }
function outcome(c: CallRow): { tone: Tone; label: string } {
  if (isLive(c)) return { tone: 'live', label: 'Ongoing' }
  if (c.status === 'declined') return { tone: 'declined', label: 'Declined' }
  const talk = fmtDuration(c.duration_sec)
  if (talk) return { tone: 'talked', label: talk }
  // Answered but over within a second, or one of the rows closed outside the app
  // whose clock runs backwards: it did connect, and a made-up length would be
  // worse than none.
  if (c.answered_at) return { tone: 'talked', label: 'Connected' }
  return { tone: 'unanswered', label: 'No answer' }
}

type CallFilter = 'all' | 'video' | 'audio'
const FILTERS: { key: CallFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'video', label: 'Video' },
  { key: 'audio', label: 'Audio' },
]

// While a call is live the list re-reads itself, so the Join card goes away when
// the call ends instead of offering to "join" what would by then ring everyone
// afresh.
const LIVE_REFRESH_MS = 15000

export function MeetingsView(props: {
  convId: string
  me: Me
  onOpenSummary: (meetingId: string) => void
  onJoinCall: (kind: 'audio' | 'video') => void
}) {
  return <Contained><CallLog {...props} /></Contained>
}

function CallLog({ convId, me, onOpenSummary, onJoinCall }: React.ComponentProps<typeof MeetingsView>) {
  const { data, error, loading, reload } = useRemote(convId, () => chatInfoApi.meetings(convId))
  useOnChange(convId, reload)
  const [filter, setFilter] = useState<CallFilter>('all')

  const calls = data?.calls || []
  // Newest first from the server, so the first live call is the current one.
  const live = calls.find(isLive) || null
  const liveId = live?.id
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!liveId) return
    // Not while this view sits hidden under another in the panel's stack (no
    // offsetParent), nor while the app is in the background: nobody is looking.
    const t = window.setInterval(() => { if (!document.hidden && rootRef.current?.offsetParent) reload() }, LIVE_REFRESH_MS)
    return () => window.clearInterval(t)
  }, [liveId, reload])

  const meetings = useMemo(() => new Map((data?.meetings || []).map((m) => [m.id, m])), [data])

  if (!data) return error && !loading ? <Failed what="the calls" error={error} onRetry={reload} /> : <Loading />
  if (!calls.length) {
    return (
      <Empty icon="video" title="No calls yet">
        Start an audio or video call from the chat header. Every call is listed here, and recorded calls get a summary with tasks.
      </Empty>
    )
  }

  const count = (f: CallFilter) => (f === 'all' ? calls.length : calls.filter((c) => c.kind === f).length)
  const shown = filter === 'all' ? calls : calls.filter((c) => c.kind === filter)
  const runs = groupRuns(shown, (c) => dayOf(c.started_at) || 'Earlier')

  return (
    <div className="ci-mt" ref={rootRef}>
      {/* Shown whatever the filter: it is the one thing here you can act on now,
          and a filter left on Audio must not hide a video call you could join. */}
      {live && <LiveCall call={live} me={me} onJoin={() => onJoinCall(live.kind)} />}
      <div className="chips ci-mt-filters" role="group" aria-label="Show calls">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className={'chip' + (filter === f.key ? ' active' : '')}
            aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}<span className="chip-count">{count(f.key)}</span>
          </button>
        ))}
      </div>
      {runs.length === 0 && <div className="ci-mt-none">No {filter} calls in this chat yet.</div>}
      {/* One day per block, so each day's header sticks only while its own calls
          scroll under it and the next day's pushes it away. */}
      {runs.map((run, i) => (
        <div key={`${run.label}-${i}`} className="ci-mt-run">
          <div className="ci-period">{run.label}</div>
          <div className="ci-section">
            {run.items.map((c) => <CallItem key={c.id} call={c} me={me} meetings={meetings} onOpen={onOpenSummary} />)}
          </div>
        </div>
      ))}
      {data.calls_truncated && <div className="ci-mt-foot">Showing the latest 200 calls</div>}
    </div>
  )
}

function LiveCall({ call: c, me, onJoin }: { call: CallRow; me: Me; onJoin: () => void }) {
  const kind = c.kind === 'video' ? 'video' : 'audio'
  const by = who(c.started_by, me)
  const inCall = (c.participants || []).length
  const sub = [
    by && `Started by ${by === 'You' ? 'you' : by}`,
    c.status === 'ringing' && inCall <= 1 ? 'ringing' : inCall > 0 ? `${inCall} in call` : '',
  ].filter(Boolean).join(' · ')
  return (
    <div className="ci-mt-live">
      <span className="ci-row-ic ci-ac-blue"><Ic name={c.kind === 'video' ? 'video' : 'phone'} size={18} /></span>
      <div className="ci-mt-live-main">
        <div className="ci-mt-live-title"><span className="ci-mt-live-dot" aria-hidden="true" />Ongoing {kind} call</div>
        {sub && <div className="ci-mt-live-sub">{sub}</div>}
      </div>
      <button type="button" className="btn btn-primary btn-sm" onClick={onJoin} aria-label={`Join the ongoing ${kind} call`}>Join</button>
    </div>
  )
}

function CallItem({ call: c, me, meetings, onOpen }: {
  call: CallRow
  me: Me
  meetings: Map<string, MeetingRow>
  onOpen: (meetingId: string) => void
}) {
  const out = outcome(c)
  const title = c.kind === 'video' ? 'Video call' : 'Audio call'
  const by = who(c.started_by, me)
  const people = c.participants || []
  const group = people.length > 1
  const clock = clockOf(c.started_at)
  // Spans, because the row is usually a <button>, which may only hold phrasing
  // content. .ci-mt gives them the block layout the base row rules expect.
  //
  // Who rang comes before how it went: "No answer · You" read as if you were the
  // one who didn't pick up; "You called · No answer" cannot. The time and the
  // outcome are always shown whole, so in a narrow panel it is the caller's name
  // that gives way.
  const head = (
    <>
      <span className={'ci-row-ic ' + TONE_ACCENT[out.tone]}><Ic name={c.kind === 'video' ? 'video' : 'phone'} size={18} /></span>
      <span className="ci-row-main">
        <span className="ci-mt-line">
          <span className="ci-row-title">{title}</span>
          {group && <Faces people={people} me={me} size={18} />}
        </span>
        <span className="ci-row-sub ci-mt-sub">
          {clock && <span className="ci-mt-keep">{clock} · </span>}
          {by && <><span className="ci-mt-who" title={by}>{by}</span><span className="ci-mt-keep"> called · </span></>}
          <span className="ci-mt-keep">{out.label}</span>
        </span>
      </span>
    </>
  )

  // Usually one summary per call. Stopping a recording mid-call and recording
  // again files a second: the row opens the newest, and "Meeting summaries" lists
  // them all. An id the meetings list does not carry is passed over unless it is
  // all there is.
  const filed = c.meeting_ids || []
  const known = filed.filter((id) => meetings.has(id))
  const ids = known.length ? known : filed
  if (!ids.length) {
    return (
      <div className="ci-row static">
        {head}
        {/* Only a call that connected could have been recorded. On every call that
            nobody answered, "No summary" would just be stating the obvious. */}
        {out.tone === 'talked' && <div className="ci-row-end">No summary</div>}
      </div>
    )
  }

  const toReview = canReview(me) ? meetings.get(ids[0])?.tasks?.pending || 0 : 0
  // Spoken instead of the row's text, which reads as a run of dots and a bare
  // number.
  const label = [
    title,
    [dayOf(c.started_at), clock].filter(Boolean).join(' '),
    by && `${by === 'You' ? 'you' : by} called`,
    out.label,
    group && `with ${peopleText(people, me)}`,
    ids.length > 1 ? `${ids.length} summaries, opens the newest` : 'opens its summary',
    toReview > 0 && `${plural(toReview, 'task')} to review`,
  ].filter(Boolean).join(', ')
  return (
    <button type="button" className="ci-row" onClick={() => onOpen(ids[0])} aria-label={label}>
      {head}
      <span className="ci-row-end">
        <span className="ci-pill">{ids.length > 1 ? `${ids.length} summaries` : 'Summary'}</span>
        {toReview > 0 && <span className="ci-count alert">{toReview}</span>}
        <Ic name="chevronRight" />
      </span>
    </button>
  )
}

// ---------------------------------------------------------------- summaries

const NO_TASKS: TaskCounts = { pending: 0, approved: 0, rejected: 0, merged: 0, total: 0 }

const COUNT_CHIPS: { key: keyof MeetingRow['counts']; one: string; warn?: boolean }[] = [
  { key: 'decisions', one: 'decision' },
  { key: 'action_items', one: 'action item' },
  { key: 'risks', one: 'risk', warn: true },
  { key: 'blockers', one: 'blocker', warn: true },
]

export function SummariesView(props: {
  convId: string
  me: Me
  onOpenSummary: (meetingId: string, review?: boolean) => void
}) {
  return <Contained><SummaryCards {...props} /></Contained>
}

function SummaryCards({ convId, me, onOpenSummary }: React.ComponentProps<typeof SummariesView>) {
  const { data, error, loading, reload } = useRemote(convId, () => chatInfoApi.meetings(convId))
  useOnChange(convId, reload)
  const reviewer = canReview(me)
  // Reviews this manager left half-done on this device (the review screen saves
  // as they type). Read again on every load, since finishing one clears it.
  const unfinished = useMemo(
    () => new Set(reviewer ? listReviewDrafts(me.id).map((d) => d.meetingId) : []),
    [reviewer, me.id, data],
  )

  if (!data) return error && !loading ? <Failed what="the summaries" error={error} onRetry={reload} /> : <Loading />
  const meetings = data.meetings || []
  if (!meetings.length) {
    return (
      <Empty icon="ai" title="No meeting summaries yet">
        When a call is recorded, its summary and the tasks it found appear here, ready to review and assign.
      </Empty>
    )
  }
  const waiting = meetings.reduce((n, m) => n + (m.tasks?.pending || 0), 0)
  return (
    <div className="ci-mt">
      <div className="ci-mt-lead">
        <span>{plural(meetings.length, 'summary', 'summaries')}</span>
        {reviewer && waiting > 0 && <span className="ci-mt-alert">{plural(waiting, 'task')} waiting for review</span>}
      </div>
      <div className="ci-mt-cards">
        {meetings.map((m) => (
          <SummaryCard key={m.id} m={m} me={me} reviewer={reviewer} unfinished={unfinished.has(m.id)} onOpen={onOpenSummary} />
        ))}
      </div>
    </div>
  )
}

function SummaryCard({ m, me, reviewer, unfinished, onOpen }: {
  m: MeetingRow
  me: Me
  reviewer: boolean
  unfinished: boolean
  onOpen: (meetingId: string, review?: boolean) => void
}) {
  const label = sourceLabel(m)
  const t = m.tasks || NO_TASKS
  const when = [dayOf(m.created_at), clockOf(m.created_at)].filter(Boolean).join(' · ')
  const chips = COUNT_CHIPS.filter((c) => (m.counts?.[c.key] || 0) > 0)
  const ids = { title: `ci-mt-t-${m.id}`, desc: `ci-mt-d-${m.id}` }
  // Two buttons that cannot nest: the card itself opens the summary, and a
  // manager's Review & Assign sits outside it, lifted above the card's click
  // area in CSS (.ci-mt-card-btn::after). Inside the button every line is a
  // <span> (phrasing content only); each class sets its own block layout.
  return (
    <article className="ci-mt-card">
      <button type="button" className="ci-mt-card-btn" onClick={() => onOpen(m.id)} aria-labelledby={ids.title} aria-describedby={ids.desc}>
        <span className="ci-mt-card-top"><span className="src-tag">{label}</span><span>{when}</span></span>
        <span className="ci-mt-card-title" id={ids.title}>{m.title || 'Untitled meeting'}</span>
        <span className="ci-mt-card-desc" id={ids.desc}>
          {/* A rule-based summary's "summary" is a statistics sentence. Still
              shown: with no AI key on the server it is all there is, and it does
              say how much the meeting produced. */}
          {typeof m.executive_summary === 'string' && m.executive_summary.trim() && <span className="ci-mt-card-sum">{m.executive_summary}</span>}
          {chips.length > 0 && (
            <span className="ci-mt-chips">
              {chips.map((c) => (
                <span key={c.key} className={'ci-mt-chip' + (c.warn ? ' warn' : '')}>{plural(m.counts?.[c.key] || 0, c.one)}</span>
              ))}
            </span>
          )}
          <span className="ci-mt-card-foot">
            <TaskLine t={t} reviewer={reviewer} />
            <Faces people={m.participants || []} me={me} label />
          </span>
        </span>
        {reviewer && unfinished && t.pending > 0 && (
          <span className="mt-inprogress"><Ic name="edit" size={13} /> Your review is unfinished</span>
        )}
      </button>
      {reviewer && t.pending > 0 && (
        <div className="ci-mt-card-act">
          <button type="button" className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); onOpen(m.id, true) }}>
            Review &amp; Assign {label} ({t.pending})
          </button>
        </div>
      )}
    </article>
  )
}

// Where a meeting's tasks stand. A manager is asked to act ("2 to review");
// anyone else is told what is happening ("2 awaiting review"), since the server
// will not let them review.
function TaskLine({ t, reviewer }: { t: TaskCounts; reviewer: boolean }) {
  return (
    <span className="ci-mt-tasks">
      {t.pending > 0 && (reviewer
        ? <span className="ci-count alert">{t.pending} to review</span>
        : <span className="ci-mt-wait">{t.pending} awaiting review</span>)}
      {t.approved > 0 && <span className="ci-mt-ok">{t.approved} assigned</span>}
      {!t.pending && !t.approved && <span>{t.total ? 'All tasks reviewed' : 'No tasks found'}</span>}
    </span>
  )
}

// ------------------------------------------------------------------ summary

const TASK_STATE: Record<Suggestion['status'], { label: string; cls: string }> = {
  pending: { label: 'Awaiting review', cls: 'pending' },
  approved: { label: 'Assigned', cls: 'approved' },
  rejected: { label: 'Rejected', cls: 'rejected' },
  merged: { label: 'Merged', cls: 'merged' },
}

// normalisePoints trusts every point's text to be a string and every quote to be
// text. An engine that returns anything else (a number, a nested object) would
// otherwise throw mid-render; coerce instead, and drop evidence that isn't a quote.
function safePoints(raw: unknown) {
  if (!Array.isArray(raw)) return []
  return normalisePoints(raw.map((it) => {
    if (typeof it === 'string') return it
    if (!it || typeof it !== 'object') return it == null ? '' : String(it)
    const ev = (it as any).evidence
    return { text: String((it as any).text ?? ''), evidence: ev && typeof ev === 'object' && typeof ev.quote === 'string' ? ev : null }
  }))
}

export function SummaryView(props: {
  convId: string
  meetingId: string
  me: Me
  autoReview?: boolean
  // After a review change, once this summary has been read back from the
  // server: the meeting's id and how many of its tasks still await review, so
  // whoever shows that count elsewhere (the chat's meeting card) can update it.
  onChanged?: (meetingId: string, pending: number) => void
}) {
  return <Contained><Summary {...props} /></Contained>
}

function Summary({ convId, meetingId, me, autoReview, onChanged }: React.ComponentProps<typeof SummaryView>) {
  const { data: m, error, loading, reload } = useRemote(`${convId}/${meetingId}`, () => chatInfoApi.meeting(convId, meetingId))
  const reviewer = canReview(me)
  const [reviewing, setReviewing] = useState(false)
  const pending = useMemo(() => (m?.suggestions || []).filter((s) => s.status === 'pending'), [m])
  const gone = isGone(error)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const onChangedRef = useRef(onChanged)
  useEffect(() => { onChangedRef.current = onChanged }, [onChanged])

  // Arriving from a card's "Review & Assign" opens the review once the
  // suggestions are actually here, so it never flashes an empty screen. Decided
  // on the first load only: a later refresh that turns up something pending
  // (someone restored a rejected task) must not throw a modal over what you are
  // reading.
  const autoDone = useRef(false)
  useEffect(() => {
    if (!m || autoDone.current) return
    autoDone.current = true
    if (!autoReview || !reviewer) return
    if (pending.length) setReviewing(true)
    // Nothing to review: the recording produced no tasks at all, or someone
    // else got there between the card and this screen.
    else {
      const what = sourceLabel(m).toLowerCase()
      toast.info((m.suggestions || []).length
        ? `Every task from this ${what} has already been reviewed.`
        : `No tasks were found in this ${what}.`)
    }
  }, [m, autoReview, reviewer, pending])

  // The review reports each approval, rejection and merge as it happens. Refresh
  // this summary behind it and any list of this chat's meetings. The modal itself
  // stays mounted through all of it: its rows were set up once from `pending`
  // and hold the manager's edits.
  const unreported = useRef(false)
  const changed = useCallback(() => {
    unreported.current = true
    reload()
    announceChange(convId)
  }, [reload, convId])

  // onChanged carries the count the server gives once a change has been read
  // back, from whichever answer lands first after it: the refetch the change
  // started, or a later one that overtook it (closing the review refetches too).
  useEffect(() => {
    if (!m || !unreported.current) return
    unreported.current = false
    onChangedRef.current?.(meetingId, pending.length)
  }, [m, pending, meetingId])
  // Popped or closed before that answer arrived: ask once more on the way out,
  // or the chat's meeting card would keep a count the review has made wrong.
  useEffect(() => () => {
    const report = onChangedRef.current
    if (!unreported.current || !report) return
    unreported.current = false
    chatInfoApi.meeting(convId, meetingId)
      .then((d) => report(meetingId, (d.suggestions || []).filter((s) => s.status === 'pending').length), () => {})
  }, [convId, meetingId])

  const closeReview = useCallback(() => {
    // Escape reaches the review's capture-phase handler before the confirm's own.
    // While "Assign all remaining" is asking, the key answers that question; it
    // must not also take away the screen the question was asked from.
    if (document.querySelector('.confirm-center')) return
    setReviewing(false)
    reload()
    // Focus goes back to the Review button, unless the review used up every
    // pending task and took the button with it; then the title catches it rather
    // than dropping a keyboard user at the top of the page.
    requestAnimationFrame(() => {
      const a = document.activeElement
      if (!a || a === document.body) titleRef.current?.focus()
    })
  }, [reload])

  // Android's back button closes the review before it walks the panel's stack,
  // which would close the review only by tearing the summary down with it. This
  // registers after the chat page's own handler, so it runs first.
  useEffect(() => {
    if (!reviewing) return
    return pushBackHandler(() => {
      if (document.querySelector('.confirm-center')) resolveConfirm(false)
      else closeReview()
      return true
    })
  }, [reviewing, closeReview])

  // Deleted while it was open: there is nothing left to review.
  useEffect(() => { if (gone) setReviewing(false) }, [gone])

  if (gone) {
    return (
      <Empty icon="ai" title="This summary is no longer available">
        It may have been deleted, or it belongs to a conversation you are no longer in.
      </Empty>
    )
  }
  if (!m) return error && !loading ? <Failed what="this summary" error={error} onRetry={reload} /> : <Loading rows={4} hero />

  const s = (m.summary && typeof m.summary === 'object' ? m.summary : {}) as Record<string, unknown>
  const exec = typeof s.executive_summary === 'string' ? s.executive_summary.trim() : ''
  const sections = SUMMARY_SECTIONS
    .map((sec) => ({ sec, points: safePoints(s[sec.key]) }))
    .filter((x) => x.points.length > 0)
  const label = sourceLabel(m)
  const talk = m.call ? fmtDuration(m.call.duration_sec) : ''
  const people = m.participants || []
  const suggestions = m.suggestions || []
  const tasks = new Map((m.tasks || []).map((t) => [t.id, t]))
  const by = m.uploaded_by_name ? (m.uploaded_by === me.id ? 'you' : m.uploaded_by_name) : ''
  // Edits from a review this manager started here or on the meeting page and
  // did not finish. They are on this device, and the review will restore them.
  const unfinished = reviewer && pending.length > 0 && !!loadReviewDraft(me.id, m.id)

  return (
    <div className="ci-mt">
      <section className="ci-section ci-mt-hero">
        <span className="src-tag">{label}</span>
        <h3 className="ci-mt-hero-title" ref={titleRef} tabIndex={-1}>{m.title || 'Untitled meeting'}</h3>
        <div className="ci-mt-hero-when">{fmtDateTime(iso(m.created_at))}{talk ? ` · ${talk}` : ''}</div>
        {people.length > 0 && (
          <div className="ci-mt-hero-people">
            <Faces people={people} me={me} size={24} />
            <span>{peopleText(people, me)}</span>
          </div>
        )}
        <div className="ci-mt-hero-note">
          {by && <><span>Summarised by {by}</span><span aria-hidden="true">·</span></>}
          {m.engine === 'rule-based'
            ? <span title="Summarised by the built-in rules, without an AI model">Rule-based summary</span>
            : <span>AI summary</span>}
        </div>
        {reviewer && pending.length > 0 && (
          <div className="ci-mt-review">
            <button type="button" className="btn btn-primary" onClick={() => setReviewing(true)}>
              Review &amp; Assign {label} ({pending.length})
            </button>
            {unfinished && <div className="mt-inprogress"><Ic name="edit" size={13} /> Your review is unfinished. Your changes are saved on this device.</div>}
          </div>
        )}
        {!reviewer && pending.length > 0 && (
          <div className="ci-mt-hero-wait">
            {plural(pending.length, 'task')} from this {label.toLowerCase()} {pending.length === 1 ? 'is' : 'are'} waiting for a manager to review.
          </div>
        )}
      </section>

      <section className="ci-section">
        <div className="ci-section-title">Summary</div>
        <p className={'ci-mt-exec' + (exec ? '' : ' muted')}>{exec || 'No summary was generated for this meeting.'}</p>
        {sections.map(({ sec, points }) => (
          <div key={sec.key} className="ci-mt-sum">
            <div className="ci-mt-sum-head">
              <span className="ci-mt-sum-ic" aria-hidden="true">{sec.icon}</span>
              <span>{sec.label}</span>
              <span className="ci-mt-sum-n">{points.length}</span>
            </div>
            <div className="ci-mt-points">
              {points.map((p, i) => <SummaryPoint key={i} point={p} />)}
            </div>
          </div>
        ))}
      </section>

      <section className="ci-section">
        <div className="ci-section-title">Tasks from this meeting ({suggestions.length})</div>
        {suggestions.length === 0
          ? <div className="ci-mt-none">No tasks were found in this {label.toLowerCase()}.</div>
          : suggestions.map((sg) => (
            <TaskItem key={sg.id} sg={sg} task={sg.created_task_id ? tasks.get(sg.created_task_id) : undefined} />
          ))}
      </section>

      {/* The meeting page's route is manager-only: anyone else following this
          link would be bounced straight back to the dashboard. */}
      {me.role === 'manager' && (
        <Link className="ci-mt-full" to={`/meetings/${m.id}`}>Open the full meeting page <Ic name="arrowRight" size={14} /></Link>
      )}

      {/* Portalled to <body>. Below 1400px the panel is a positioned layer at
          z-index 30, which would cap the modal's own 50, and for its first 180ms
          it slides in on a transform, which would make it the containing block of
          the modal's position:fixed and clip it to the panel. On <body> the modal
          stacks exactly as it does on the meeting page. */}
      {reviewing && createPortal(
        <ReviewAssignModal meeting={m} pending={pending} onChanged={changed} onClose={closeReview} />,
        document.body,
      )}
    </div>
  )
}

function TaskItem({ sg, task }: { sg: Suggestion; task?: TaskRow }) {
  const state = TASK_STATE[sg.status] || { label: String(sg.status || 'Unknown'), cls: 'other' }
  // Once assigned the task can change hands, and its own row knows who holds it
  // now; before that, the suggestion's owner is the only answer.
  const owner = task?.assignee_name || sg.suggested_assignee_name || sg.suggested_assignee_raw || ''
  // A name heard in the meeting that matched no account. Shown, but flagged the
  // way <Assigner> flags an unmatched asker.
  const unmatched = !task?.assignee_name && !sg.suggested_assignee_name && !!sg.suggested_assignee_raw
  const due = task?.due_date ? task : sg
  return (
    <div className={'ci-mt-task is-' + state.cls}>
      <div className="ci-mt-task-top">
        <div className="ci-mt-task-title">{sg.title}</div>
        <span className={'ci-mt-status ' + state.cls}>{state.label}</span>
      </div>
      <div className="ci-mt-task-meta">
        <span>Owner: {owner || 'Unassigned'}{unmatched && <span className="asgn-unmatched">unmatched</span>}</span>
        {(due.due_date || sg.due_date_raw) && <span>Due {dueLabel(due)}</span>}
        {task && <span>Task: {task.status}</span>}
      </div>
      {/* Who asked for it — nothing when the owner volunteered (see askedBy). */}
      <Assigner sg={sg} />
      {sg.source_quote && <div className="ci-mt-quote">“{sg.source_quote}”</div>}
    </div>
  )
}
