// In-app feedback: a star rating + optional comment about the app. Anyone in the
// org can leave (and update) their own; managers/admins see the whole org's
// reviews, the average, and the full submission trail — who sent what, when, from
// which screen and which device.
//
// Two tables, on purpose:
//   app_feedback    — one CURRENT row per person (what the average is built from,
//                     so nobody can vote twice)
//   feedback_events — every submission ever, append-only (the tracking log)
import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requireRole } from '../auth.js'
import { id, now } from '../util.js'

const r = Router()
r.use(authRequired)

// A short, human device label from the User-Agent — "Chrome on Windows" reads
// better in a review list than 120 characters of UA string. Best-effort only:
// unknown clients fall back to 'Unknown device' rather than guessing.
function deviceLabel(ua = '') {
  const s = String(ua)
  if (/SmartTask|Capacitor|wv\)/i.test(s) && /Android/i.test(s)) return 'Android app'
  const os = /Windows/i.test(s) ? 'Windows'
    : /iPhone|iPad|iPod/i.test(s) ? 'iOS'
    : /Android/i.test(s) ? 'Android'
    : /Mac OS X/i.test(s) ? 'macOS'
    : /Linux/i.test(s) ? 'Linux' : ''
  // Order matters — Edge and Chrome both claim "Chrome", Chrome claims "Safari".
  const browser = /Edg\//i.test(s) ? 'Edge'
    : /OPR\//i.test(s) ? 'Opera'
    : /Firefox\//i.test(s) ? 'Firefox'
    : /Chrome\//i.test(s) ? 'Chrome'
    : /Safari\//i.test(s) ? 'Safari' : ''
  if (browser && os) return `${browser} on ${os}`
  return browser || os || 'Unknown device'
}

// Keep the recorded route short and free of ids/query strings — "/tasks/abc123"
// is noise; "/tasks" is the answer to "where were they when they said this?".
function cleanPage(raw) {
  const p = String(raw || '').trim().split('?')[0].split('#')[0]
  if (!p.startsWith('/')) return null
  return p.slice(0, 120) || null
}

// The signed-in user's own current rating (null if they haven't rated), so the
// form can open pre-filled and read "update" rather than "submit".
r.get('/mine', (req, res) => {
  const row = db.prepare('SELECT rating, comment, updated_at FROM app_feedback WHERE user_id=?').get(req.user.id)
  res.json(row || null)
})

// Submit or update the user's rating. One row per user in app_feedback (UNIQUE
// user_id), so a repeat submission overwrites their previous opinion — but every
// submission is also appended to feedback_events, so the history survives.
r.post('/', (req, res) => {
  const rating = Number(req.body?.rating)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' })
  }
  const comment = String(req.body?.comment || '').trim().slice(0, 2000) || null
  const page = cleanPage(req.body?.page)
  const appVersion = String(req.body?.app_version || '').trim().slice(0, 40) || null
  const device = deviceLabel(req.get('user-agent'))

  const existing = db.prepare('SELECT id, created_at FROM app_feedback WHERE user_id=?').get(req.user.id)
  const ts = now()
  db.transaction(() => {
    if (existing) {
      db.prepare('UPDATE app_feedback SET rating=?, comment=?, updated_at=? WHERE id=?').run(rating, comment, ts, existing.id)
    } else {
      db.prepare('INSERT INTO app_feedback (id, org_id, user_id, rating, comment, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(id('fb'), req.user.org_id, req.user.id, rating, comment, ts, ts)
    }
    db.prepare(`INSERT INTO feedback_events (id, org_id, user_id, rating, comment, kind, page, device, app_version, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id('fbe'), req.user.org_id, req.user.id, rating, comment, existing ? 'update' : 'new', page, device, appVersion, ts)
  })()

  res.status(existing ? 200 : 201).json({ ok: true, rating, comment })
})

// The whole org's feedback + summary — managers/admins only. Ratings are the
// team's opinion of the product, so they belong to whoever runs the workspace.
// Each review carries its tracking context: how many times that person has
// submitted, when they first did, and the screen/device of their latest send.
r.get('/', requireRole('manager', 'admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT f.id, f.user_id, f.rating, f.comment, f.created_at, f.updated_at,
           u.name AS user_name, u.email AS user_email, u.avatar_color, u.avatar_file, u.role,
           (SELECT COUNT(*) FROM feedback_events e WHERE e.user_id=f.user_id) AS submissions,
           (SELECT e.page FROM feedback_events e WHERE e.user_id=f.user_id ORDER BY e.created_at DESC LIMIT 1) AS page,
           (SELECT e.device FROM feedback_events e WHERE e.user_id=f.user_id ORDER BY e.created_at DESC LIMIT 1) AS device
    FROM app_feedback f JOIN users u ON u.id=f.user_id
    WHERE f.org_id=? ORDER BY f.updated_at DESC`).all(req.user.org_id)
  const count = rows.length
  const average = count ? Math.round((rows.reduce((s, x) => s + x.rating, 0) / count) * 10) / 10 : null
  // Star histogram (5→1) for a quick distribution bar.
  const distribution = [5, 4, 3, 2, 1].map((star) => ({ star, count: rows.filter((x) => x.rating === star).length }))
  res.json({ average, count, distribution, reviews: rows })
})

// The submission trail — every send and edit, newest first. Managers/admins only.
// `?userId=` narrows it to one person; `?limit=` caps the page (default 100).
r.get('/history', requireRole('manager', 'admin'), (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)
  const userId = req.query.userId ? String(req.query.userId) : null
  const rows = db.prepare(`
    SELECT e.id, e.user_id, e.rating, e.comment, e.kind, e.page, e.device, e.app_version, e.created_at,
           u.name AS user_name, u.email AS user_email, u.avatar_color, u.avatar_file, u.role
    FROM feedback_events e JOIN users u ON u.id=e.user_id
    WHERE e.org_id=? ${userId ? 'AND e.user_id=?' : ''}
    ORDER BY e.created_at DESC LIMIT ?`)
    .all(...(userId ? [req.user.org_id, userId, limit] : [req.user.org_id, limit]))
  res.json({ count: rows.length, events: rows })
})

export default r
