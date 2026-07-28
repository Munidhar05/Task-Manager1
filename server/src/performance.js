// Engagement scoring service — turns task/comment/meeting/audit history into a
// daily 0-100 score per person, persisted in performance_daily. The scoring policy
// (section budgets, per-priority points) lives in scoring.js; this file is the
// DB-facing glue: it gathers each day's contributions, scores them per the user's
// role, and reads them back for the leaderboard.
//
// Day boundaries are UTC (substr(iso,1,10)) to match the dashboards. Only calendar
// days that are fully over are scored — today is never scored until it's yesterday.
// Backfillable: because every scored action already writes to task_comments /
// audit_logs / tasks, a fresh install (or a scoring-policy bump) rebuilds the whole
// history from those tables.

import { db } from './db.js'
import { dailyScore, SCORING_VERSION, rubricSections } from './scoring.js'

const BACKFILL_DAYS = Number(process.env.PERF_BACKFILL_DAYS) || 180

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10)
const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

// Prepared statements compiled lazily (tables may not exist at import time).
const _cache = new Map()
const P = (sql) => { let s = _cache.get(sql); if (!s) { s = db.prepare(sql); _cache.set(sql, s) } return s }

// --- Per-day gather queries (one pass over all users for a single day) --------
// Each returns rows of {uid, priority} (priority-weighted streams) or {uid, c}
// (counts). Priority is read from the live task where possible; audit-sourced
// streams LEFT JOIN the task, so a since-deleted task yields NULL → Medium.

// Completions: tasks the user finished that day (excludes split PARENTS, whose
// completion is a roll-up of children rather than direct work).
const SQL_COMPLETIONS = `
  SELECT assignee_id AS uid, priority FROM tasks t
  WHERE status='Done' AND assignee_id IS NOT NULL AND completed_at IS NOT NULL
    AND substr(completed_at,1,10)=?
    AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id=t.id)`
// First comment a user ever made on a task, if that first comment fell on day D.
// Repeat comments on the same task earn nothing.
const SQL_FIRST_COMMENTS = `
  SELECT c.user_id AS uid, t.priority FROM task_comments c
  JOIN tasks t ON t.id=c.task_id
  WHERE substr(c.created_at,1,10)=?
    AND c.created_at=(SELECT MIN(c2.created_at) FROM task_comments c2
                      WHERE c2.task_id=c.task_id AND c2.user_id=c.user_id)`
// Status changes the user made that day, EXCLUDING Done (Done is paid in the
// completion section, so counting it here too would double-pay the final step).
const SQL_STATUS_CHANGES = `
  SELECT a.actor_id AS uid, t.priority FROM audit_logs a
  LEFT JOIN tasks t ON t.id=a.entity_id
  WHERE a.action='task.status' AND a.entity_type='task'
    AND a.detail IS NOT 'Done' AND substr(a.created_at,1,10)=? AND a.actor_id IS NOT NULL`
// Delegations / assignments the user made that day: a task they assigned to
// SOMEONE ELSE (not a self-task). Serves employee "delegate" and manager "assign".
const SQL_DELEGATIONS = `
  SELECT assigned_by_id AS uid, priority FROM tasks
  WHERE assigned_by_id IS NOT NULL AND assignee_id IS NOT NULL
    AND assigned_by_id != assignee_id AND substr(created_at,1,10)=?`
// Approval decisions the user made that day (approved or rejected — both are review
// work). Manager rubric only, but gathered for everyone; non-managers won't route it.
const SQL_APPROVALS = `
  SELECT a.actor_id AS uid, t.priority FROM audit_logs a
  LEFT JOIN tasks t ON t.id=a.entity_id
  WHERE a.action='task.approval' AND a.entity_type='task'
    AND substr(a.created_at,1,10)=? AND a.actor_id IS NOT NULL`
// Meetings the user ran that day (they uploaded/created it).
const SQL_MEETINGS = `
  SELECT uploaded_by AS uid, COUNT(*) c FROM meetings
  WHERE uploaded_by IS NOT NULL AND substr(meeting_date,1,10)=? GROUP BY uploaded_by`
// Tasks RECEIVED that day (for the "most received" side-badge; not scored).
const SQL_RECEIVED = `
  SELECT assignee_id AS uid, COUNT(*) c FROM tasks
  WHERE assignee_id IS NOT NULL AND substr(created_at,1,10)=? GROUP BY assignee_id`

const SQL_INSERT = `
  INSERT OR IGNORE INTO performance_daily
    (user_id, org_id, day, day_score, rating_after, tasks_done, weighted, breakdown)
  VALUES (@user_id,@org_id,@day,@day_score,@rating_after,@tasks_done,@weighted,@breakdown)`

const getMeta = (k) => P('SELECT value FROM app_meta WHERE key=?').get(k)?.value ?? null
const setMeta = (k, v) => P('INSERT INTO app_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v))

// Group {uid, priority} rows into Map<uid, priority[]>.
function groupPriorities(rows) {
  const m = new Map()
  for (const r of rows) { if (!m.has(r.uid)) m.set(r.uid, []); m.get(r.uid).push(r.priority) }
  return m
}
function countMap(rows) { const m = new Map(); for (const r of rows) m.set(r.uid, r.c); return m }

// Score every user who did anything on `day`, and append their rows.
function processDay(day, roleByUser, orgByUser) {
  const completions = groupPriorities(P(SQL_COMPLETIONS).all(day))
  const firstComments = groupPriorities(P(SQL_FIRST_COMMENTS).all(day))
  const statusChanges = groupPriorities(P(SQL_STATUS_CHANGES).all(day))
  const delegations = groupPriorities(P(SQL_DELEGATIONS).all(day))
  const approvals = groupPriorities(P(SQL_APPROVALS).all(day))
  const meetings = countMap(P(SQL_MEETINGS).all(day))

  // Anyone who contributed in any stream gets scored for the day.
  const active = new Set([
    ...completions.keys(), ...firstComments.keys(), ...statusChanges.keys(),
    ...delegations.keys(), ...approvals.keys(), ...meetings.keys(),
  ])

  for (const uid of active) {
    const org = orgByUser.get(uid)
    if (!org) continue // deleted / unknown user
    const role = roleByUser.get(uid) || 'employee'
    const contributions = {
      completions: completions.get(uid) || [],
      firstComments: firstComments.get(uid) || [],
      statusChanges: statusChanges.get(uid) || [],
      delegations: delegations.get(uid) || [],
      approvals: approvals.get(uid) || [],
      meetings: meetings.get(uid) || 0,
    }
    const { score, breakdown } = dailyScore(role, contributions)
    P(SQL_INSERT).run({
      user_id: uid, org_id: org, day,
      day_score: score, rating_after: score, // rating_after kept = score (legacy col, NOT NULL)
      tasks_done: contributions.completions.length,
      weighted: 0,
      breakdown: JSON.stringify(breakdown),
    })
  }
}

// Earliest day worth scoring: the first task's creation date, floored at the cap.
function earliestStart() {
  const row = db.prepare('SELECT MIN(substr(created_at,1,10)) d FROM tasks').get()
  if (!row?.d) return null
  const cap = addDays(utcDay(), -BACKFILL_DAYS)
  return row.d < cap ? cap : row.d
}

// When the scoring policy changes, stored days are stale. Wipe them and reset the
// progress marker so the next advance rebuilds the whole history under the new
// rules. Runs once per version bump (guarded by the stored version marker).
function ensureVersion() {
  if (getMeta('perf_version') === SCORING_VERSION) return
  db.transaction(() => {
    db.prepare('DELETE FROM performance_daily').run()
    setMeta('perf_last_day', '')
    setMeta('perf_version', SCORING_VERSION)
  })()
}

let running = false
// Advance scoring from the last processed day up to (and including) yesterday.
// Idempotent: safe to call on every read — no-ops once caught up.
export function advancePerformance() {
  if (running) return { skipped: 'locked' }
  ensureVersion()
  const yesterday = addDays(utcDay(), -1)
  const last = getMeta('perf_last_day')
  let start = last ? addDays(last, 1) : earliestStart()
  if (!start) return { days: 0 }
  if (start > yesterday) return { days: 0 }

  running = true
  try {
    const roleByUser = new Map(db.prepare('SELECT id, role FROM users').all().map((u) => [u.id, u.role]))
    const orgByUser = new Map(db.prepare('SELECT id, org_id FROM users').all().map((u) => [u.id, u.org_id]))
    let count = 0
    for (let day = start; day <= yesterday; day = addDays(day, 1)) {
      db.transaction(() => { processDay(day, roleByUser, orgByUser); setMeta('perf_last_day', day) })()
      count++
    }
    return { days: count, through: yesterday }
  } finally {
    running = false
  }
}

// Force a full rebuild (manager "recompute" button) regardless of version.
export function rebuildPerformance() {
  db.transaction(() => { db.prepare('DELETE FROM performance_daily').run(); setMeta('perf_last_day', '') })()
  return advancePerformance()
}

// --- Read side ----------------------------------------------------------------

// Map a period token to a day window. 'day' = latest scored day only.
const periodWindow = (period) => (period === 'day' ? 1 : period === 'all' ? 100000 : 30)

// Average day_score over the last `windowDays` for one user (null if none).
function windowAvg(userId, windowDays) {
  const since = addDays(utcDay(), -windowDays)
  const row = db.prepare('SELECT AVG(day_score) a, COUNT(*) c FROM performance_daily WHERE user_id=? AND day>=?').get(userId, since)
  return row.c ? { avg: row.a, days: row.c } : { avg: null, days: 0 }
}

// The whole-org leaderboard for a period. EVERYONE in the org is listed (no
// eligibility gate) and ranked by their score for the chosen period:
//   day   → the latest scored day's score
//   month → average day_score over the last 30 days
//   all   → average day_score over all scored days
// Ranked on the (average) score, so consistency wins over raw volume. Also returns
// per-person active-days and the two daily volume leaders (received / completed)
// as side-stats — shown, never folded into the score.
export function getLeaderboard(orgId, { period = 'month' } = {}) {
  advancePerformance() // lazy catch-up so reads are current
  const windowDays = periodWindow(period)
  const since = addDays(utcDay(), -windowDays)
  const users = db.prepare("SELECT id, name, avatar_color, avatar_file, role FROM users WHERE org_id=?").all(orgId)

  const latestDay = db.prepare('SELECT day_score, day, breakdown FROM performance_daily WHERE user_id=? ORDER BY day DESC LIMIT 1')
  const activeDaysAll = db.prepare('SELECT COUNT(*) c FROM performance_daily WHERE user_id=?')
  const activeDaysWin = db.prepare('SELECT COUNT(*) c FROM performance_daily WHERE user_id=? AND day>=?')

  const rows = users.map((u) => {
    const last = latestDay.get(u.id)
    let score
    if (period === 'day') score = last ? last.day_score : null
    else { const w = windowAvg(u.id, windowDays); score = w.avg == null ? null : Math.round(w.avg * 10) / 10 }
    return {
      id: u.id, name: u.name, avatar_color: u.avatar_color, avatar_file: u.avatar_file, role: u.role,
      score,
      latest_score: last ? last.day_score : null,
      latest_day: last?.day ?? null,
      latest_breakdown: last?.breakdown ? safeParse(last.breakdown) : null,
      active_days: activeDaysAll.get(u.id).c,
      active_days_window: activeDaysWin.get(u.id, since).c,
    }
  })

  // Side-badges: who received / completed the most in the window (not scored).
  const topReceived = topBy(orgId, since, SQL_RECEIVED_WINDOW)
  const topCompleted = topBy(orgId, since, SQL_COMPLETED_WINDOW)

  // Rank everyone with a score; the scoreless (no activity in range) trail, sorted
  // by their all-time activity so the list still reads sensibly.
  const scored = rows.filter((r) => r.score != null).sort((a, b) => b.score - a.score).map((r, i) => ({ ...r, rank: i + 1 }))
  const idle = rows.filter((r) => r.score == null).sort((a, b) => b.active_days - a.active_days)
  return { period, window_days: windowDays, ranked: [...scored, ...idle], scored_count: scored.length, top_received: topReceived, top_completed: topCompleted }
}

const SQL_RECEIVED_WINDOW = `
  SELECT assignee_id AS uid, COUNT(*) c FROM tasks
  WHERE org_id=? AND assignee_id IS NOT NULL AND substr(created_at,1,10)>=? GROUP BY assignee_id ORDER BY c DESC LIMIT 1`
const SQL_COMPLETED_WINDOW = `
  SELECT assignee_id AS uid, COUNT(*) c FROM tasks
  WHERE org_id=? AND status='Done' AND assignee_id IS NOT NULL AND substr(completed_at,1,10)>=? GROUP BY assignee_id ORDER BY c DESC LIMIT 1`
function topBy(orgId, since, sql) {
  const r = db.prepare(sql).get(orgId, since)
  return r ? { user_id: r.uid, count: r.c } : null
}
function safeParse(s) { try { return JSON.parse(s) } catch { return null } }

// One person's detail: current standing, the latest day's section breakdown,
// period average, active-days, and recent daily scores for a sparkline.
export function getUserDetail(userId, { period = 'month', historyDays = 60 } = {}) {
  advancePerformance()
  const u = db.prepare('SELECT id, name, avatar_color, avatar_file, role, org_id FROM users WHERE id=?').get(userId)
  if (!u) return null
  const windowDays = periodWindow(period)
  const since = addDays(utcDay(), -historyDays)
  const history = db.prepare('SELECT day, day_score, tasks_done, breakdown FROM performance_daily WHERE user_id=? AND day>=? ORDER BY day ASC')
    .all(userId, since).map((h) => ({ ...h, breakdown: safeParse(h.breakdown) }))
  const latest = history.length ? history[history.length - 1] : null
  const win = windowAvg(userId, windowDays)
  const allDays = db.prepare('SELECT COUNT(*) c, SUM(tasks_done) t FROM performance_daily WHERE user_id=?').get(userId)

  return {
    user: { id: u.id, name: u.name, avatar_color: u.avatar_color, avatar_file: u.avatar_file, role: u.role },
    period,
    period_score: win.avg == null ? null : Math.round(win.avg * 10) / 10,
    period_days_scored: win.days,
    latest,
    active_days: allDays.c,
    tasks_done_total: allDays.t || 0,
    // The section labels/caps for this person's rubric, so the UI can render the
    // breakdown without hard-coding the policy.
    sections: rubricSections(u.role),
    history,
  }
}
