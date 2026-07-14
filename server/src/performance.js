// Employee performance service — turns task/meeting/chat history into daily scores
// and a rolling all-time rating, persisted in performance_daily. The scoring maths
// live in scoring.js; this file is the DB-facing glue: it gathers each day's rows,
// advances every user's rating one day at a time (idempotent, resumable via the
// `perf_last_day` marker in app_meta), and reads it back for the leaderboard.
//
// Day boundaries are UTC (substr(iso,1,10)) to match the existing dashboards, which
// derive "today"/overdue the same way. Only calendar days that are fully over are
// scored — today is never scored until it becomes yesterday.

import { db } from './db.js'
import {
  dailyScore, advanceRating, engagementScore, priorityWeight,
  RATING_START, DEFAULT_DAILY_TARGET,
} from './scoring.js'

// The weighted throughput that maxes out the throughput component, per day. Fixed
// (not auto-calibrated) so historical scores are deterministic and never shift
// retroactively; calibrateDailyTarget() below surfaces a *suggested* value from
// live data for a manager to review. Override with PERF_DAILY_TARGET.
const DAILY_TARGET = Number(process.env.PERF_DAILY_TARGET) || DEFAULT_DAILY_TARGET
// Cap how far back a cold start will backfill, to bound first-run work.
const BACKFILL_DAYS = Number(process.env.PERF_BACKFILL_DAYS) || 120

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10)
const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const daysBetween = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000)

// Prepared statements are compiled lazily on first use (memoised) rather than at
// module load — on a fresh DB the tables don't exist until initSchema() runs, which
// happens AFTER this module is imported. Matches the rest of the codebase.
const _cache = new Map()
const P = (sql) => { let s = _cache.get(sql); if (!s) { s = db.prepare(sql); _cache.set(sql, s) } return s }

// --- Per-day gather queries (one pass over all users for a single day) --------
const SQL_COMPLETIONS = `
  SELECT assignee_id, priority, due_date, completed_at FROM tasks t
  WHERE status='Done' AND assignee_id IS NOT NULL AND completed_at IS NOT NULL
    AND substr(completed_at,1,10)=?
    AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id=t.id)`
const SQL_REOPENS = `
  SELECT t.assignee_id AS uid FROM audit_logs a JOIN tasks t ON t.id=a.entity_id
  WHERE a.action='task.status' AND a.detail='Reopened' AND substr(a.created_at,1,10)=?
    AND t.assignee_id IS NOT NULL`
const SQL_REJECTS = `
  SELECT t.assignee_id AS uid FROM audit_logs a JOIN tasks t ON t.id=a.entity_id
  WHERE a.action='task.approval' AND a.detail='rejected' AND substr(a.created_at,1,10)=?
    AND t.assignee_id IS NOT NULL`
// Open + past-due as of day D: existed by D, not completed on/before D, due before D.
const SQL_OVERDUE = `
  SELECT assignee_id, priority, due_date FROM tasks
  WHERE assignee_id IS NOT NULL AND due_date IS NOT NULL AND due_date < ?
    AND substr(created_at,1,10) <= ?
    AND (completed_at IS NULL OR substr(completed_at,1,10) > ?)`
const SQL_MEETINGS = `
  SELECT mp.user_id AS uid, COUNT(*) c FROM meeting_participants mp
  JOIN meetings m ON m.id=mp.meeting_id WHERE substr(m.meeting_date,1,10)=? GROUP BY mp.user_id`
const SQL_MESSAGES = "SELECT sender_id AS uid, COUNT(*) c FROM chat_messages WHERE substr(created_at,1,10)=? GROUP BY sender_id"
const SQL_COMMENTS = "SELECT user_id AS uid, COUNT(*) c FROM task_comments WHERE substr(created_at,1,10)=? GROUP BY user_id"
const SQL_DELEGATIONS = `
  SELECT assigned_by_id AS uid, COUNT(*) c FROM tasks
  WHERE assigned_by_id IS NOT NULL AND assigned_by_id != assignee_id AND substr(created_at,1,10)=? GROUP BY assigned_by_id`
const SQL_INSERT = `
  INSERT OR IGNORE INTO performance_daily
    (user_id, org_id, day, day_score, rating_after, tasks_done, weighted, on_time_rate, quality_rate, engagement, penalty, overdue_open)
  VALUES (@user_id,@org_id,@day,@day_score,@rating_after,@tasks_done,@weighted,@on_time_rate,@quality_rate,@engagement,@penalty,@overdue_open)`

const getMeta = (k) => P('SELECT value FROM app_meta WHERE key=?').get(k)?.value ?? null
const setMeta = (k, v) => P('INSERT INTO app_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v))

// Group a list of {uid,...} rows into a Map keyed by uid.
function groupBy(rows, key = 'uid') {
  const m = new Map()
  for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r) }
  return m
}
function countMap(rows) {
  const m = new Map()
  for (const r of rows) m.set(r.uid, r.c)
  return m
}

// Score every user for a single calendar day and append their rows. `ratingByUser`
// is a live Map of each user's current rating, mutated forward. Only users with real
// task activity that day (a completion, reopen, or rejection) get a row / rating move.
function processDay(day, orgByUser, ratingByUser) {
  const completions = groupBy(P(SQL_COMPLETIONS).all(day), 'assignee_id')
  const reopens = groupBy(P(SQL_REOPENS).all(day))
  const rejects = groupBy(P(SQL_REJECTS).all(day))
  const overdue = groupBy(P(SQL_OVERDUE).all(day, day, day), 'assignee_id')
  const meetings = countMap(P(SQL_MEETINGS).all(day))
  const messages = countMap(P(SQL_MESSAGES).all(day))
  const comments = countMap(P(SQL_COMMENTS).all(day))
  const delegations = countMap(P(SQL_DELEGATIONS).all(day))

  // Which users had SOME task activity today → the ones whose rating advances.
  const active = new Set([...completions.keys(), ...reopens.keys(), ...rejects.keys()])

  for (const uid of active) {
    const org = orgByUser.get(uid)
    if (!org) continue // user deleted / unknown
    const done = completions.get(uid) || []
    let doneOnTime = 0, doneLate = 0, weighted = 0
    for (const t of done) {
      weighted += priorityWeight(t.priority)
      if (t.due_date) {
        if (t.completed_at.slice(0, 10) <= t.due_date) doneOnTime++
        else doneLate++
      }
    }
    const reopenN = (reopens.get(uid) || []).length
    const rejectN = (rejects.get(uid) || []).length
    const resolved = done.length + reopenN + rejectN
    const overTasks = (overdue.get(uid) || []).map((t) => ({ priority: t.priority, daysLate: daysBetween(day, t.due_date) }))

    const engagement = engagementScore({
      meetingsAttended: meetings.get(uid) || 0,
      messagesSent: messages.get(uid) || 0,
      commentsPosted: comments.get(uid) || 0,
      tasksDelegated: delegations.get(uid) || 0,
    })

    const { score, penalty } = dailyScore({
      doneOnTime, doneLate,
      weightedThroughput: weighted,
      resolved, reopenedOrRejected: reopenN + rejectN,
      engagement, overdueTasks: overTasks, dailyTarget: DAILY_TARGET,
    })

    const prev = ratingByUser.get(uid) ?? RATING_START
    const rating = advanceRating(prev, score)
    ratingByUser.set(uid, rating)

    const dueResolved = doneOnTime + doneLate
    P(SQL_INSERT).run({
      user_id: uid, org_id: org, day,
      day_score: score, rating_after: Math.round(rating * 10) / 10,
      tasks_done: done.length, weighted,
      on_time_rate: dueResolved > 0 ? doneOnTime / dueResolved : null,
      quality_rate: resolved > 0 ? 1 - (reopenN + rejectN) / resolved : null,
      engagement, penalty, overdue_open: overTasks.length,
    })
  }
}

// Earliest day worth scoring: the first task's creation date, floored at the
// backfill cap. Returns null when there are no tasks at all.
function earliestStart() {
  const row = db.prepare('SELECT MIN(substr(created_at,1,10)) d FROM tasks').get()
  if (!row?.d) return null
  const cap = addDays(utcDay(), -BACKFILL_DAYS)
  return row.d < cap ? cap : row.d
}

let running = false
// Advance scoring from the last processed day up to (and including) yesterday.
// Idempotent: safe to call on every request — it no-ops once caught up. Guarded by
// an in-process lock so overlapping calls don't double-score.
export function advancePerformance() {
  if (running) return { skipped: 'locked' }
  const yesterday = addDays(utcDay(), -1)
  const last = getMeta('perf_last_day')
  let start = last ? addDays(last, 1) : earliestStart()
  if (!start) return { days: 0 } // no tasks yet
  if (start > yesterday) return { days: 0 } // already current

  running = true
  try {
    // Seed each user's current rating from their latest stored day.
    const orgByUser = new Map(db.prepare('SELECT id, org_id FROM users').all().map((u) => [u.id, u.org_id]))
    const ratingByUser = new Map(
      db.prepare(`SELECT pd.user_id, pd.rating_after FROM performance_daily pd
        JOIN (SELECT user_id, MAX(day) mx FROM performance_daily GROUP BY user_id) t
          ON t.user_id=pd.user_id AND t.mx=pd.day`).all().map((r) => [r.user_id, r.rating_after])
    )
    let count = 0
    for (let day = start; day <= yesterday; day = addDays(day, 1)) {
      // One transaction per day: rows + marker move together, so a crash resumes cleanly.
      db.transaction(() => { processDay(day, orgByUser, ratingByUser); setMeta('perf_last_day', day) })()
      count++
    }
    return { days: count, through: yesterday }
  } finally {
    running = false
  }
}

// --- Read side ----------------------------------------------------------------

const MIN_TASKS_TO_RANK = Number(process.env.PERF_MIN_TASKS) || 5

// Suggested (not applied) daily throughput target: the median, across employees
// with real recent output, of their weighted throughput per active day over the
// trailing 30 days. Shown to managers so they can tune PERF_DAILY_TARGET.
export function calibrateDailyTarget(orgId) {
  const since = addDays(utcDay(), -30)
  const rows = db.prepare(`SELECT user_id, AVG(weighted) avg_w, COUNT(*) days FROM performance_daily
    WHERE org_id=? AND day>=? AND weighted>0 GROUP BY user_id HAVING days>=3`).all(orgId, since)
  const vals = rows.map((r) => r.avg_w).sort((a, b) => a - b)
  if (!vals.length) return { suggested: null, current: DAILY_TARGET, sampleUsers: 0 }
  const median = vals[Math.floor(vals.length / 2)]
  return { suggested: Math.round(Math.max(0.8, Math.min(3, median)) * 100) / 100, current: DAILY_TARGET, sampleUsers: vals.length }
}

// Average day_score over the last `windowDays` for one user (null if no scored days).
function windowAvg(userId, windowDays) {
  const since = addDays(utcDay(), -windowDays)
  const row = db.prepare('SELECT AVG(day_score) a, COUNT(*) c FROM performance_daily WHERE user_id=? AND day>=?').get(userId, since)
  return row.c ? { avg: row.a, days: row.c } : { avg: null, days: 0 }
}

// This-week vs last-week average day_score → trend direction + delta.
function weeklyTrend(userId) {
  const thisWeekFrom = addDays(utcDay(), -7)
  const lastWeekFrom = addDays(utcDay(), -14)
  const avg = (from, to) => db.prepare('SELECT AVG(day_score) a FROM performance_daily WHERE user_id=? AND day>=? AND day<?').get(userId, from, to).a
  const cur = avg(thisWeekFrom, addDays(utcDay(), 1))
  const prev = avg(lastWeekFrom, thisWeekFrom)
  if (cur == null || prev == null) return { direction: 'flat', delta: null, current: cur, previous: prev }
  const delta = Math.round((cur - prev) * 10) / 10
  return { direction: delta > 1 ? 'up' : delta < -1 ? 'down' : 'flat', delta, current: cur, previous: prev }
}

// The whole-org leaderboard for a given recent window. Everyone with a rating is
// listed; only those with >= MIN_TASKS_TO_RANK assigned tasks in the window are
// ranked (others are shown as "not enough activity"). Ranked by all-time rating.
export function getLeaderboard(orgId, { windowDays = 30 } = {}) {
  advancePerformance() // lazy catch-up so reads are always current
  const since = addDays(utcDay(), -windowDays)
  const users = db.prepare("SELECT id, name, avatar_color, avatar_file, role FROM users WHERE org_id=?").all(orgId)

  const latestRating = db.prepare(`SELECT pd.rating_after FROM performance_daily pd WHERE pd.user_id=? ORDER BY pd.day DESC LIMIT 1`)
  // "Active on" a task in the window = created, completed, or due within it — so
  // someone finishing older tasks still counts, not only brand-new assignments.
  const assignedInWindow = db.prepare(`SELECT COUNT(*) c FROM tasks WHERE assignee_id=@uid AND (
      substr(created_at,1,10)>=@since
      OR (completed_at IS NOT NULL AND substr(completed_at,1,10)>=@since)
      OR (due_date IS NOT NULL AND due_date>=@since))`)
  const latestScore = db.prepare('SELECT day_score, day FROM performance_daily WHERE user_id=? ORDER BY day DESC LIMIT 1')

  const rows = users.map((u) => {
    const rating = latestRating.get(u.id)?.rating_after ?? null
    const win = windowAvg(u.id, windowDays)
    const assigned = assignedInWindow.get({ uid: u.id, since }).c
    const last = latestScore.get(u.id)
    return {
      id: u.id, name: u.name, avatar_color: u.avatar_color, avatar_file: u.avatar_file, role: u.role,
      rating: rating == null ? null : Math.round(rating),
      window_score: win.avg == null ? null : Math.round(win.avg * 10) / 10,
      window_days_scored: win.days,
      latest_score: last ? Math.round(last.day_score * 10) / 10 : null,
      latest_day: last?.day ?? null,
      assigned_in_window: assigned,
      trend: weeklyTrend(u.id),
      eligible: assigned >= MIN_TASKS_TO_RANK && rating != null,
    }
  })

  const ranked = rows.filter((r) => r.eligible).sort((a, b) => b.rating - a.rating).map((r, i) => ({ ...r, rank: i + 1 }))
  const unranked = rows.filter((r) => !r.eligible).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
  return { window_days: windowDays, min_tasks_to_rank: MIN_TASKS_TO_RANK, ranked, unranked }
}

// One employee's detail: current standing, the last scored day's component
// breakdown, recent daily scores, and the rating trajectory (for a sparkline).
export function getUserDetail(userId, { windowDays = 30, historyDays = 60 } = {}) {
  advancePerformance()
  const u = db.prepare('SELECT id, name, avatar_color, avatar_file, role, org_id FROM users WHERE id=?').get(userId)
  if (!u) return null
  const since = addDays(utcDay(), -historyDays)
  const history = db.prepare(`SELECT day, day_score, rating_after, tasks_done, weighted, on_time_rate, quality_rate, engagement, penalty, overdue_open
    FROM performance_daily WHERE user_id=? AND day>=? ORDER BY day ASC`).all(userId, since)
  const latest = history.length ? history[history.length - 1] : null
  const rating = latest?.rating_after ?? null
  const win = windowAvg(userId, windowDays)

  // Window aggregate ("why is my score what it is") straight from stored days.
  const winRows = db.prepare('SELECT * FROM performance_daily WHERE user_id=? AND day>=?').all(userId, addDays(utcDay(), -windowDays))
  const avgOf = (rows, f) => { const v = rows.map(f).filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null }
  const aggregate = {
    on_time_rate: avgOf(winRows, (r) => r.on_time_rate),
    quality_rate: avgOf(winRows, (r) => r.quality_rate),
    avg_weighted: avgOf(winRows, (r) => r.weighted),
    avg_engagement: avgOf(winRows, (r) => r.engagement),
    avg_penalty: avgOf(winRows, (r) => r.penalty),
    tasks_done: winRows.reduce((s, r) => s + r.tasks_done, 0),
    days_scored: winRows.length,
  }

  return {
    user: { id: u.id, name: u.name, avatar_color: u.avatar_color, avatar_file: u.avatar_file, role: u.role },
    rating: rating == null ? null : Math.round(rating),
    window_score: win.avg == null ? null : Math.round(win.avg * 10) / 10,
    window_days: windowDays,
    latest, aggregate,
    trend: weeklyTrend(userId),
    history,
  }
}
