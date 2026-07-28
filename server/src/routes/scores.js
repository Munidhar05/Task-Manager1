// Employee performance scores — the leaderboard and per-employee detail.
// Scores are visible to everyone in the org (by design); cross-org access is
// blocked. The heavy lifting lives in performance.js / scoring.js.
import { Router } from 'express'
import { db } from '../db.js'
import { authRequired } from '../auth.js'
import { getLeaderboard, getUserDetail } from '../performance.js'

const r = Router()
r.use(authRequired)

// day | month | all — anything else falls back to month.
const PERIODS = ['day', 'month', 'all']
const clampPeriod = (v) => (PERIODS.includes(v) ? v : 'month')

// Whole-org leaderboard. ?period=day|month|all selects today / last 30 days / all-time.
r.get('/leaderboard', (req, res) => {
  res.json(getLeaderboard(req.user.org_id, { period: clampPeriod(req.query.period) }))
})

// The signed-in user's own detail.
r.get('/me', (req, res) => {
  const detail = getUserDetail(req.user.id, { period: clampPeriod(req.query.period) })
  if (!detail) return res.status(404).json({ error: 'No score yet' })
  res.json(detail)
})

// Any user's detail — same org only.
r.get('/:userId', (req, res) => {
  const target = db.prepare('SELECT org_id FROM users WHERE id=?').get(req.params.userId)
  if (!target) return res.status(404).json({ error: 'User not found' })
  if (target.org_id !== req.user.org_id) return res.status(403).json({ error: 'Out of organization' })
  const detail = getUserDetail(req.params.userId, { period: clampPeriod(req.query.period) })
  if (!detail) return res.status(404).json({ error: 'No score yet' })
  res.json(detail)
})

// No /recompute any more: points are counted live from tasks / task_comments /
// audit_logs on every read, so there is no stored history that can go stale.

export default r
