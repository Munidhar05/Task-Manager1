// Per-owner task email. Three triggers, one gate, one module:
//
//   1. daily      — every morning at TASK_MAIL_DAILY_HOUR, everything still open
//                   that this person owns, Critical first and the rest below it.
//   2. assigned   — within a minute of a Critical task being pointed at someone:
//                   "a critical task was set for you at <time>", its deadline,
//                   and the rest of their critical work for context.
//   3. deadline   — one hour before a Critical task's deadline falls due.
//
// Deliberately separate from digest.js, which is a whole-team standup posted to a
// Cliq channel. This is addressed mail: each message goes to exactly one person
// and names only their own work.
//
// THE DELIVERY GATE. Reaching real owners requires TASK_MAIL_TO_OWNERS=true in
// the environment. Every other configuration — unset, empty, 'false', a typo — is
// a rehearsal: the same messages are built from the same live data, but all of
// them are addressed to TASK_MAIL_TEST_TO instead, each carrying a banner naming
// the owner it would have reached. Default-off is the whole point. Mail aimed at
// an entire organization cannot be recalled once it lands, so the configuration
// mistake that is easy to make has to be the harmless one.
//
// Every hour and date here is read in TASK_MAIL_TZ (default Asia/Kolkata), NOT in
// the server's local time. The Render service runs in UTC, so scheduler.js's
// `new Date().getHours()` would make "10 am" mean 15:30 to everyone using this.
import { db } from './db.js'
import { sendMail, mailerMode } from './mailer.js'
import { appUrl, now } from './util.js'

const OPEN = "('To Do','In Progress','Blocked','In Review','Reopened')"
// Critical first, then descending urgency — the order tasks appear in every mail.
const PRIORITY_ORDER = "CASE priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END"

export const tz = () => process.env.TASK_MAIL_TZ || 'Asia/Kolkata'
export const dailyHour = () => Number(process.env.TASK_MAIL_DAILY_HOUR || 10)
// due_date is a DATE with no time of day, so "the deadline" needs an hour to mean
// anything. 18:00 = end of the working day; the one-hour warning then goes at 17:00.
export const deadlineHour = () => Number(process.env.TASK_MAIL_DEADLINE_HOUR || 18)

// Compared as a string, not coerced: Boolean('false') is true, and this flag is
// the only thing standing between a rehearsal and mail hitting real inboxes.
export function toOwnersEnabled() {
  return String(process.env.TASK_MAIL_TO_OWNERS || '').trim().toLowerCase() === 'true'
}
export function testRecipient() {
  return String(process.env.TASK_MAIL_TEST_TO || '').trim()
}

// --- Wall-clock helpers, all in tz() ----------------------------------------

// { date: 'YYYY-MM-DD', hour: 0-23, minute: 0-59 } as read on a clock in tz().
export function zonedNow(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const o = {}
  for (const p of f.formatToParts(d)) if (p.type !== 'literal') o[p.type] = p.value
  return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour), minute: Number(o.minute) }
}

// "7:00 PM" — the time something happened, as the reader's clock showed it.
function clockLabel(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-US', { timeZone: tz(), hour: 'numeric', minute: '2-digit', hour12: true }).format(d)
}

const shiftDate = (ymd, days) => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

// The wall-clock slot at which a task due on `dueDate` gets its 1-hour warning.
// Rolls onto the previous evening when the deadline itself is midnight.
export function warningSlot(dueDate) {
  const h = deadlineHour()
  return h === 0 ? { date: shiftDate(dueDate, -1), hour: 23 } : { date: dueDate, hour: h - 1 }
}

const isOverdue = (t, todayStr) => !!t.due_date && t.due_date < todayStr

// --- Who owns what -----------------------------------------------------------

const OWNER_COLS = 'u.id AS owner_id, u.name AS owner_name, u.email AS owner_email'

function groupByOwner(rows) {
  const byOwner = new Map()
  for (const t of rows) {
    if (!byOwner.has(t.owner_id)) {
      byOwner.set(t.owner_id, { id: t.owner_id, name: t.owner_name, email: t.owner_email, tasks: [] })
    }
    byOwner.get(t.owner_id).tasks.push(t)
  }
  return [...byOwner.values()]
}

// Every open task that belongs to somebody, Critical first. No visible_to_manager
// filter, unlike the team summary in digest.js: a private employee draft is still
// that employee's own task, and this mail is read by nobody but them.
export function openTasksByOwner({ criticalOnly = false } = {}) {
  return groupByOwner(db.prepare(
    `SELECT t.id, t.title, t.status, t.due_date, t.priority, t.assigned_at, t.created_at, ${OWNER_COLS}
       FROM tasks t JOIN users u ON u.id = t.assignee_id
      WHERE t.parent_task_id IS NULL AND t.status IN ${OPEN}
        ${criticalOnly ? "AND t.priority = 'Critical'" : ''}
      ORDER BY u.name, ${PRIORITY_ORDER}, t.due_date IS NULL, t.due_date, t.title`
  ).all())
}

export function countUnassignedCritical() {
  return db.prepare(
    `SELECT COUNT(*) c FROM tasks WHERE priority = 'Critical' AND parent_task_id IS NULL
        AND status IN ${OPEN} AND (assignee_id IS NULL OR assignee_id = '')`
  ).get().c
}

// --- Send-once bookkeeping ---------------------------------------------------
// The two event alerts fire off a poll rather than a hook in the task routes:
// tasks reach Critical from half a dozen places (routes/tasks.js, meeting review,
// the voice assistant, the MCP server, the public API) and a poll cannot be
// bypassed by the next one added. The cost is needing to remember what has
// already gone out, which is what critical_alerts_sent is for.

const alreadySent = db.prepare('SELECT 1 FROM critical_alerts_sent WHERE task_id=? AND owner_id=? AND kind=? AND due_date=?')
const markSent = db.prepare(
  `INSERT OR IGNORE INTO critical_alerts_sent (task_id, owner_id, kind, due_date, sent_at) VALUES (?,?,?,?,?)`
)

// First boot after this feature ships, every critical task in the database looks
// brand new. Record them as already-alerted so the rollout doesn't fire a burst
// of "a critical task was set for you" for work assigned weeks ago.
export function seedAlertBaseline() {
  const seen = db.prepare('SELECT value FROM app_meta WHERE key=?').get('task_mail_baseline')
  if (seen) return 0
  let n = 0
  for (const g of openTasksByOwner({ criticalOnly: true })) {
    for (const t of g.tasks) { markSent.run(t.id, g.id, 'assigned', '', now()); n++ }
  }
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run('task_mail_baseline', '1')
  if (n) console.log(`  [task-mail] baseline: ${n} existing critical task(s) marked as already announced`)
  return n
}

// --- Message building --------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function dueLabel(t, todayStr) {
  if (!t.due_date) return 'no due date'
  return `due ${t.due_date}${isOverdue(t, todayStr) ? ' — OVERDUE' : ''}`
}

function taskLinesText(tasks, todayStr) {
  return tasks.flatMap((t) => [`  • [${t.priority}] ${t.title}`, `      ${t.status} · ${dueLabel(t, todayStr)}`])
}

function taskRowsHtml(tasks, todayStr) {
  return tasks.map((t) => {
    const crit = t.priority === 'Critical'
    const due = t.due_date
      ? `${esc(t.due_date)}${isOverdue(t, todayStr) ? ' <b style="color:#b91c1c">· OVERDUE</b>' : ''}`
      : '<span style="color:#999">no due date</span>'
    return `<tr><td style="padding:9px 0;border-bottom:1px solid #eee">
      <div style="font-weight:600">${crit ? '<span style="color:#b91c1c">⚠ </span>' : ''}${esc(t.title)}</div>
      <div style="color:#666;font-size:13px">${esc(t.priority)} · ${esc(t.status)} · ${due}</div>
    </td></tr>`
  }).join('')
}

function shell(inner, banner, footer) {
  const bannerHtml = banner
    ? `<p style="background:#fef3c7;border:1px solid #fcd34d;color:#78350f;padding:10px 12px;border-radius:8px;font-size:13px">${esc(banner)}</p>`
    : ''
  return `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto">
    ${bannerHtml}${inner}
    <p><a href="${appUrl()}/tasks" style="display:inline-block;background:#c2410c;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Open VoTask</a></p>
    <p style="color:#999;font-size:12px">${esc(footer)}</p>
  </div>`
}

// 1. The 10am list: everything open, critical pulled to the top.
export function buildDailyMail(owner, tasks, todayStr, banner) {
  const crit = tasks.filter((t) => t.priority === 'Critical')
  const rest = tasks.filter((t) => t.priority !== 'Critical')
  const text = []
  if (banner) text.push(banner, '')
  text.push(`Good morning ${owner.name},`, '')
  if (crit.length) {
    text.push(`CRITICAL — ${crit.length} task${crit.length === 1 ? '' : 's'} needing attention first:`, '')
    text.push(...taskLinesText(crit, todayStr), '')
  }
  if (rest.length) {
    text.push(`Your other open tasks (${rest.length}):`, '')
    text.push(...taskLinesText(rest, todayStr), '')
  }
  text.push(`Open them here: ${appUrl()}/tasks`, '', '— VoTask')

  const html = shell(
    `<h2 style="color:#c2410c">Your tasks for ${esc(todayStr)}</h2>` +
    (crit.length
      ? `<h3 style="color:#b91c1c;margin-bottom:4px">Critical — ${crit.length}</h3>
         <table style="width:100%;border-collapse:collapse">${taskRowsHtml(crit, todayStr)}</table>`
      : '<p style="color:#666">Nothing critical on your plate today.</p>') +
    (rest.length
      ? `<h3 style="margin-bottom:4px">Other open tasks — ${rest.length}</h3>
         <table style="width:100%;border-collapse:collapse">${taskRowsHtml(rest, todayStr)}</table>`
      : ''),
    banner, `Daily task mail · ${todayStr}`)

  const summary = crit.length
    ? `${crit.length} critical${rest.length ? `, ${rest.length} other` : ''}`
    : `${rest.length} open`
  return { subject: `Your tasks for ${todayStr} — ${summary}`, text: text.join('\n'), html }
}

// 2. A critical task has just been pointed at this person.
export function buildAssignedMail(owner, task, others, todayStr, banner) {
  const at = clockLabel(task.assigned_at || task.created_at)
  const opener = `There is a critical task set for you${at ? ` at ${at}` : ''}.`
  const deadline = task.due_date
    ? `The deadline is ${task.due_date}${isOverdue(task, todayStr) ? ' — already past' : ''}.`
    : 'No deadline has been set on it yet.'
  const text = []
  if (banner) text.push(banner, '')
  text.push(`${owner.name},`, '', opener, '')
  text.push(`  • ${task.title}`, `      ${task.status} · ${deadline}`, '')
  if (others.length) {
    text.push(`And these are the rest of your critical tasks as well (${others.length}):`, '')
    text.push(...taskLinesText(others, todayStr), '')
  }
  text.push(`Open them here: ${appUrl()}/tasks`, '', '— VoTask')

  const html = shell(
    `<h2 style="color:#b91c1c">A critical task was set for you</h2>
     <p>${esc(opener)} ${esc(deadline)}</p>
     <table style="width:100%;border-collapse:collapse">${taskRowsHtml([task], todayStr)}</table>` +
    (others.length
      ? `<h3 style="margin-bottom:4px">The rest of your critical tasks — ${others.length}</h3>
         <table style="width:100%;border-collapse:collapse">${taskRowsHtml(others, todayStr)}</table>`
      : ''),
    banner, `Critical task alert · ${todayStr}`)

  return { subject: `⚠️ Critical task set for you — ${task.title}`, text: text.join('\n'), html }
}

// 3. One hour to go.
export function buildDeadlineMail(owner, task, todayStr, banner) {
  const text = []
  if (banner) text.push(banner, '')
  text.push(`${owner.name},`, '')
  text.push('Within 1 hour, there is a deadline for your critical task.', '')
  text.push(`  • ${task.title}`, `      ${task.status} · due ${task.due_date} at ${String(deadlineHour()).padStart(2, '0')}:00`, '')
  text.push(`Open it here: ${appUrl()}/tasks`, '', '— VoTask')

  const html = shell(
    `<h2 style="color:#b91c1c">1 hour to your deadline</h2>
     <p>Within 1 hour, there is a deadline for your critical task.</p>
     <table style="width:100%;border-collapse:collapse">${taskRowsHtml([task], todayStr)}</table>`,
    banner, `Deadline warning · ${todayStr}`)

  return { subject: `⏰ 1 hour left — ${task.title}`, text: text.join('\n'), html }
}

// --- Delivery ----------------------------------------------------------------

// The single choke point every message passes through. `overrideTo` forces a
// rehearsal to one address regardless of the environment and can never go live.
async function deliver(owner, build, { overrideTo }) {
  const live = !overrideTo && toOwnersEnabled()
  const to = live ? owner.email : (overrideTo || testRecipient())
  if (!to) return false // nobody to reach: no address on file, or a rehearsal with no test inbox
  const banner = live ? null : `TEST COPY — in live mode this would have been sent to ${owner.name} <${owner.email || 'no email on file'}>.`
  const msg = build(banner)
  try {
    await sendMail({ to, subject: (live ? '' : '[TEST] ') + msg.subject, text: msg.text, html: msg.html })
    return true
  } catch (e) {
    console.error(`[task-mail] send to ${to} failed:`, e.message)
    return false
  }
}

const modeOf = (overrideTo) =>
  overrideTo ? 'test' : (toOwnersEnabled() ? 'owners' : (testRecipient() ? 'test' : 'off'))

// 1. The daily list, one mail per owner who has anything open.
export async function sendDailyTaskMail({ overrideTo = null } = {}) {
  const todayStr = zonedNow().date
  let sent = 0, skipped = 0
  const groups = openTasksByOwner()
  for (const owner of groups) {
    const ok = await deliver(owner, (b) => buildDailyMail(owner, owner.tasks, todayStr, b), { overrideTo })
    ok ? sent++ : skipped++
  }
  const summary = { kind: 'daily', date: todayStr, mode: modeOf(overrideTo), owners: groups.length, sent, skipped, emailMode: mailerMode() }
  console.log(`[task-mail] daily ${todayStr} → mode:${summary.mode} owners:${groups.length} sent:${sent}${skipped ? ` skipped:${skipped}` : ''}`)
  return summary
}

// 2. Critical tasks that have appeared since the last poll.
export async function sendNewCriticalAlerts({ overrideTo = null } = {}) {
  const todayStr = zonedNow().date
  let sent = 0
  for (const owner of openTasksByOwner({ criticalOnly: true })) {
    for (const task of owner.tasks) {
      if (alreadySent.get(task.id, owner.id, 'assigned', '')) continue
      const others = owner.tasks.filter((t) => t.id !== task.id)
      const ok = await deliver(owner, (b) => buildAssignedMail(owner, task, others, todayStr, b), { overrideTo })
      // Marked either way: a bounced address must not re-fire this alert every
      // minute for the life of the task.
      markSent.run(task.id, owner.id, 'assigned', '', now())
      if (ok) sent++
    }
  }
  if (sent) console.log(`[task-mail] new-critical → mode:${modeOf(overrideTo)} sent:${sent}`)
  return { kind: 'assigned', mode: modeOf(overrideTo), sent }
}

// 3. Critical tasks whose deadline is an hour out, right now.
export async function sendDeadlineWarnings({ overrideTo = null } = {}) {
  const nowZ = zonedNow()
  let sent = 0
  for (const owner of openTasksByOwner({ criticalOnly: true })) {
    for (const task of owner.tasks) {
      if (!task.due_date) continue
      const slot = warningSlot(task.due_date)
      if (slot.date !== nowZ.date || slot.hour !== nowZ.hour) continue
      // Keyed on due_date, so moving the deadline re-arms the warning.
      if (alreadySent.get(task.id, owner.id, 'deadline', task.due_date)) continue
      const ok = await deliver(owner, (b) => buildDeadlineMail(owner, task, nowZ.date, b), { overrideTo })
      markSent.run(task.id, owner.id, 'deadline', task.due_date, now())
      if (ok) sent++
    }
  }
  if (sent) console.log(`[task-mail] deadline-1h → mode:${modeOf(overrideTo)} sent:${sent}`)
  return { kind: 'deadline', mode: modeOf(overrideTo), sent }
}

// A rehearsal to one inbox, ignoring both the gate and the send-once bookkeeping
// — this is the "show me what these look like" button, so it must produce mail
// even when everything has already been alerted today.
//
// `full` is the difference between reviewing the format and auditing the blast:
// off (the default) sends ONE example of each of the three kinds, built from real
// people's real tasks; on, it sends every message the live run would send, which
// is one per owner plus the critical alerts — read the count before asking for it.
export async function sendTestBundle(to, { full = false } = {}) {
  const todayStr = zonedNow().date
  const daily = openTasksByOwner()
  const crit = openTasksByOwner({ criticalOnly: true })
  // For the sample, pick the fullest example of each so the layout is worth looking
  // at: the owner with the most open tasks, and a critical task that has a deadline.
  const dailyPick = full ? daily : daily.slice().sort((a, b) => b.tasks.length - a.tasks.length).slice(0, 1)
  const critPick = full ? crit : crit.filter((g) => g.tasks.some((t) => t.due_date)).slice(0, 1)
  const critFallback = critPick.length ? critPick : crit.slice(0, 1)

  let sent = 0
  for (const owner of dailyPick) {
    if (await deliver(owner, (b) => buildDailyMail(owner, owner.tasks, todayStr, b), { overrideTo: to })) sent++
  }
  for (const owner of critFallback) {
    const task = owner.tasks.find((t) => t.due_date) || owner.tasks[0]
    const others = owner.tasks.filter((t) => t.id !== task.id)
    if (await deliver(owner, (b) => buildAssignedMail(owner, task, others, todayStr, b), { overrideTo: to })) sent++
    if (await deliver(owner, (b) => buildDeadlineMail(owner, task, todayStr, b), { overrideTo: to })) sent++
  }
  const summary = {
    kind: full ? 'test-bundle-full' : 'test-bundle-sample', to, date: todayStr, sent,
    wouldEmailOwnersDaily: daily.length, wouldEmailOwnersCritical: crit.length,
    unassignedCritical: countUnassignedCritical(), emailMode: mailerMode(),
  }
  console.log(`[task-mail] TEST ${full ? 'BUNDLE (full)' : 'SAMPLE'} → ${to} · ${sent} message(s)`)
  return summary
}
