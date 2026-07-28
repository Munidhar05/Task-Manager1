// Engagement scoring service — counts each person's scoring actions straight out
// of tasks / task_comments / audit_logs and turns them into points. The policy
// (what an action is worth) lives in scoring.js; this file is the DB-facing glue.
//
// Nothing is persisted: a point is a row that already exists in one of those three
// tables, so the leaderboard is always live and there is no job to run, no cache to
// invalidate and no history to rebuild. Changing a task's status updates the board
// on the next read.
//
// Day boundaries are UTC (substr(iso,1,10)) to match the dashboards.

import { db } from './db.js'
import { scoreCounts, pointRules } from './scoring.js'

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10)
const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

// Prepared statements compiled lazily (tables may not exist at import time).
const _cache = new Map()
const P = (sql) => { let s = _cache.get(sql); if (!s) { s = db.prepare(sql); _cache.set(sql, s) } return s }

// --- The four scoring queries -------------------------------------------------
// Each returns {uid, c} per person for one org since a given day. `since` is a
// UTC yyyy-mm-dd; all-time passes '0000-00-00' so the >= comparison always holds.
//
// Each query has an optional `AND <col>=?` slot appended for the single-user case,
// so the leaderboard and the detail view can't drift apart.

// +1 per task this person handed to SOMEONE ELSE. Self-assigned tasks don't count:
// otherwise you could farm 2 points by making a task for yourself and ticking it.
const SQL_ASSIGNED = `
  SELECT assigned_by_id AS uid, COUNT(*) AS c FROM tasks
  WHERE org_id=? AND assigned_by_id IS NOT NULL AND assignee_id IS NOT NULL
    AND assigned_by_id != assignee_id AND substr(created_at,1,10) >= ?`
// +1 per task this person finished (excludes split PARENTS, whose completion is a
// roll-up of their children rather than work done directly).
const SQL_COMPLETED = `
  SELECT assignee_id AS uid, COUNT(*) AS c FROM tasks t
  WHERE org_id=? AND status='Done' AND assignee_id IS NOT NULL AND completed_at IS NOT NULL
    AND substr(completed_at,1,10) >= ?
    AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id=t.id)`
// +1 per TASK commented on, not per comment — ten replies on one task is one point.
const SQL_COMMENTED = `
  SELECT c.user_id AS uid, COUNT(DISTINCT c.task_id) AS c FROM task_comments c
  JOIN tasks t ON t.id=c.task_id
  WHERE t.org_id=? AND substr(c.created_at,1,10) >= ?`
// +1 per status change, EXCLUDING Done — that one is paid as a completion above.
const SQL_STATUS = `
  SELECT a.actor_id AS uid, COUNT(*) AS c FROM audit_logs a
  WHERE a.org_id=? AND a.action='task.status' AND a.entity_type='task'
    AND a.detail IS NOT 'Done' AND a.actor_id IS NOT NULL AND substr(a.created_at,1,10) >= ?`

// key → [sql, groupByColumn]. The group-by column doubles as the single-user filter.
const RULE_SQL = {
  assigned: [SQL_ASSIGNED, 'assigned_by_id'],
  completed: [SQL_COMPLETED, 'assignee_id'],
  commented: [SQL_COMMENTED, 'c.user_id'],
  status: [SQL_STATUS, 'a.actor_id'],
}

// Raw action counts for every person in the org: Map<uid, {assigned,…}>.
function gatherCounts(orgId, since, onlyUserId = null) {
  const out = new Map()
  const bump = (uid, key, c) => {
    if (!uid) return
    if (!out.has(uid)) out.set(uid, { assigned: 0, completed: 0, commented: 0, status: 0 })
    out.get(uid)[key] = c
  }
  for (const [key, [sql, col]] of Object.entries(RULE_SQL)) {
    const q = onlyUserId ? `${sql} AND ${col}=? GROUP BY ${col}` : `${sql} GROUP BY ${col}`
    const args = onlyUserId ? [orgId, since, onlyUserId] : [orgId, since]
    for (const row of P(q).all(...args)) bump(row.uid, key, row.c)
  }
  return out
}

// --- Read side ----------------------------------------------------------------

// Period token → the first UTC day that still counts.
//   day   → today only
//   month → the last 30 days
//   all   → everything
export function periodSince(period) {
  if (period === 'day') return utcDay()
  if (period === 'all') return '0000-00-00'
  return addDays(utcDay(), -30)
}

// The whole-org leaderboard for a period. EVERYONE in the org is listed; people
// with no activity in range score 0 and trail the ranked list. Ranked on total
// points — a straight count of work done, so volume is exactly what it measures.
export function getLeaderboard(orgId, { period = 'month' } = {}) {
  const since = periodSince(period)
  const counts = gatherCounts(orgId, since)
  const users = db.prepare('SELECT id, name, avatar_color, avatar_file, role FROM users WHERE org_id=?').all(orgId)

  const rows = users.map((u) => {
    const { points, breakdown } = scoreCounts(counts.get(u.id))
    return {
      id: u.id, name: u.name, avatar_color: u.avatar_color, avatar_file: u.avatar_file, role: u.role,
      score: points,
      breakdown,
    }
  })

  // Ranked by points, highest first; ties break alphabetically so the order is
  // stable between reloads. Zero-point people are listed but not ranked.
  const active = rows.filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((r, i) => ({ ...r, rank: i + 1 }))
  const idle = rows.filter((r) => r.score === 0).sort((a, b) => a.name.localeCompare(b.name))

  return {
    period,
    since,
    rules: pointRules(),
    ranked: [...active, ...idle],
    scored_count: active.length,
    total_points: active.reduce((s, r) => s + r.score, 0),
  }
}

// One person's detail: their points for the period, the count behind each rule,
// their all-time total, and a per-day series for the chart.
export function getUserDetail(userId, { period = 'month', historyDays = 30 } = {}) {
  const u = db.prepare('SELECT id, name, avatar_color, avatar_file, role, org_id FROM users WHERE id=?').get(userId)
  if (!u) return null
  const since = periodSince(period)
  const { points, breakdown } = scoreCounts(gatherCounts(u.org_id, since, userId).get(userId))
  const allTime = scoreCounts(gatherCounts(u.org_id, '0000-00-00', userId).get(userId))

  return {
    user: { id: u.id, name: u.name, avatar_color: u.avatar_color, avatar_file: u.avatar_file, role: u.role },
    period,
    since,
    points,
    breakdown,
    all_time_points: allTime.points,
    rules: pointRules(),
    history: dailyPoints(u.org_id, userId, historyDays),
  }
}

// Points per day for the last `days` days, oldest first — the detail chart.
// Same four rules, grouped by day instead of by person.
function dailyPoints(orgId, userId, days) {
  const from = addDays(utcDay(), -(days - 1))
  const perDay = new Map()
  const bump = (day, n) => perDay.set(day, (perDay.get(day) || 0) + n)

  const DAY_SQL = {
    assigned: `SELECT substr(created_at,1,10) AS d, COUNT(*) AS c FROM tasks
      WHERE org_id=? AND assigned_by_id=? AND assignee_id IS NOT NULL AND assigned_by_id != assignee_id
        AND substr(created_at,1,10) >= ? GROUP BY d`,
    completed: `SELECT substr(completed_at,1,10) AS d, COUNT(*) AS c FROM tasks t
      WHERE org_id=? AND assignee_id=? AND status='Done' AND completed_at IS NOT NULL
        AND substr(completed_at,1,10) >= ?
        AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id=t.id) GROUP BY d`,
    commented: `SELECT substr(c.created_at,1,10) AS d, COUNT(DISTINCT c.task_id) AS c FROM task_comments c
      JOIN tasks t ON t.id=c.task_id
      WHERE t.org_id=? AND c.user_id=? AND substr(c.created_at,1,10) >= ? GROUP BY d`,
    status: `SELECT substr(a.created_at,1,10) AS d, COUNT(*) AS c FROM audit_logs a
      WHERE a.org_id=? AND a.actor_id=? AND a.action='task.status' AND a.entity_type='task'
        AND a.detail IS NOT 'Done' AND substr(a.created_at,1,10) >= ? GROUP BY d`,
  }
  for (const sql of Object.values(DAY_SQL)) {
    for (const row of P(sql).all(orgId, userId, from)) if (row.d) bump(row.d, row.c)
  }

  const out = []
  for (let d = from; d <= utcDay(); d = addDays(d, 1)) out.push({ day: d, points: perDay.get(d) || 0 })
  return out
}
