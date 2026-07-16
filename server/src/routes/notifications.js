import { Router } from 'express'
import { db } from '../db.js'
import { authRequired } from '../auth.js'
import { saveDeviceToken, removeDeviceToken } from '../push.js'

const r = Router()
r.use(authRequired)

// Register this device's FCM token so the user gets native push. Called by the
// app after it obtains a token (and on every login, in case the token rotated).
r.post('/register-device', (req, res) => {
  const { token, platform } = req.body || {}
  if (!token) return res.status(400).json({ error: 'token required' })
  saveDeviceToken(req.user.id, token, platform || 'android')
  res.json({ ok: true })
})

// Unregister on logout so a shared device stops receiving this user's pushes.
r.post('/unregister-device', (req, res) => {
  const { token } = req.body || {}
  removeDeviceToken(token)
  res.json({ ok: true })
})

// My notifications, newest first.
r.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.id)
  const unread = rows.filter((n) => !n.read).length
  res.json({ items: rows, unread })
})

// Mark all my notifications read.
r.post('/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET read=1 WHERE user_id=? AND read=0').run(req.user.id)
  res.json({ ok: true })
})

// Mark a single notification read.
r.post('/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(req.params.id, req.user.id)
  res.json({ ok: true })
})

export default r
