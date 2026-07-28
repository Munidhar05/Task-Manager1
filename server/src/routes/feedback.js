// In-app feedback: a star rating + optional comment about the app. Anyone in the
// org can leave (and update) their own; managers/admins see the whole org's
// reviews and the average, so they can gauge how the team rates the product.
import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requireRole } from '../auth.js'
import { id, now } from '../util.js'

const r = Router()
r.use(authRequired)

// The signed-in user's own current rating (null if they haven't rated), so the
// form can open pre-filled and read "update" rather than "submit".
r.get('/mine', (req, res) => {
  const row = db.prepare('SELECT rating, comment, updated_at FROM app_feedback WHERE user_id=?').get(req.user.id)
  res.json(row || null)
})

// Submit or update the user's rating. One row per user (UNIQUE user_id), so a
// repeat submission overwrites their previous one instead of stacking duplicates.
r.post('/', (req, res) => {
  const rating = Number(req.body?.rating)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' })
  }
  const comment = String(req.body?.comment || '').trim().slice(0, 2000) || null
  const existing = db.prepare('SELECT id, created_at FROM app_feedback WHERE user_id=?').get(req.user.id)
  const ts = now()
  if (existing) {
    db.prepare('UPDATE app_feedback SET rating=?, comment=?, updated_at=? WHERE id=?').run(rating, comment, ts, existing.id)
  } else {
    db.prepare('INSERT INTO app_feedback (id, org_id, user_id, rating, comment, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id('fb'), req.user.org_id, req.user.id, rating, comment, ts, ts)
  }
  res.status(existing ? 200 : 201).json({ ok: true, rating, comment })
})

// The whole org's feedback + summary — managers/admins only. Ratings are the
// team's opinion of the product, so they belong to whoever runs the workspace.
r.get('/', requireRole('manager', 'admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT f.id, f.rating, f.comment, f.updated_at, u.name AS user_name, u.avatar_color, u.avatar_file, u.role
    FROM app_feedback f JOIN users u ON u.id=f.user_id
    WHERE f.org_id=? ORDER BY f.updated_at DESC`).all(req.user.org_id)
  const count = rows.length
  const average = count ? Math.round((rows.reduce((s, x) => s + x.rating, 0) / count) * 10) / 10 : null
  // Star histogram (5→1) for a quick distribution bar.
  const distribution = [5, 4, 3, 2, 1].map((star) => ({ star, count: rows.filter((x) => x.rating === star).length }))
  res.json({ average, count, distribution, reviews: rows })
})

export default r
