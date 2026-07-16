// Employee performance scores — the leaderboard and per-employee detail.
// Scores are visible to everyone in the org (by design); cross-org access is
// blocked. The heavy lifting lives in performance.js / scoring.js.
import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requireRole } from '../auth.js'
import { getLeaderboard, getUserDetail, calibrateDailyTarget, advancePerformance } from '../performance.js'

const r = Router()
r.use(authRequired)

const clampWindow = (v, def) => { const n = Number(v); return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.floor(n) : def }

// Whole-org leaderboard. ?window=7|30|90 selects the recent averaging window.
r.get('/leaderboard', (req, res) => {
  const windowDays = clampWindow(req.query.window, 30)
  res.json(getLeaderboard(req.user.org_id, { windowDays }))
})

// Suggested throughput target from live data (managers tune PERF_DAILY_TARGET).
r.get('/calibration', requireRole('manager', 'admin'), (req, res) => {
  res.json(calibrateDailyTarget(req.user.org_id))
})

// The signed-in user's own detail.
r.get('/me', (req, res) => {
  const windowDays = clampWindow(req.query.window, 30)
  const detail = getUserDetail(req.user.id, { windowDays })
  if (!detail) return res.status(404).json({ error: 'No score yet' })
  res.json(detail)
})

// Any employee's detail — same org only.
r.get('/:userId', (req, res) => {
  const target = db.prepare('SELECT org_id FROM users WHERE id=?').get(req.params.userId)
  if (!target) return res.status(404).json({ error: 'User not found' })
  if (target.org_id !== req.user.org_id) return res.status(403).json({ error: 'Out of organization' })
  const windowDays = clampWindow(req.query.window, 30)
  const detail = getUserDetail(req.params.userId, { windowDays })
  if (!detail) return res.status(404).json({ error: 'No score yet' })
  res.json(detail)
})

// Manager-triggered recompute of any not-yet-scored days (normally automatic).
r.post('/recompute', requireRole('manager', 'admin'), (req, res) => {
  res.json(advancePerformance())
})

export default r
