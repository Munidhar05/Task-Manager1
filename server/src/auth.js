import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { db } from './db.js'
import { id, now, deviceLabel } from './util.js'

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'
// How long a login stays valid. Long-lived so users aren't logged out mid-use;
// override with JWT_EXPIRES_IN (e.g. '12h', '7d', '30d').
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d'

export const hashPassword = (pw) => bcrypt.hashSync(pw, 10)
export const verifyPassword = (pw, hash) => bcrypt.compareSync(pw, hash)

// Every login opens a session row, and its id rides in the token. That is what
// makes signing out mean something: the JWT is stateless and lives 30 days, so
// before this a token could not be taken back once issued — "log out this
// device" could not reach the phone that held it.
export function createSession(user, req) {
  const sid = id('ses')
  const ts = now()
  const ip = String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').split(',')[0].trim() || null
  db.prepare('INSERT INTO sessions (id, user_id, device, ip, created_at, last_seen_at) VALUES (?,?,?,?,?,?)')
    .run(sid, user.id, deviceLabel(req?.get?.('user-agent')), ip, ts, ts)
  return sid
}

export function signToken(user, sessionId = null) {
  const payload = { sub: user.id, role: user.role, org_id: user.org_id, name: user.name }
  if (sessionId) payload.sid = sessionId
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN })
}

// A token is good only while its session is. Tokens issued before sessions
// existed carry no sid — those stay valid rather than logging everyone out on
// deploy; they simply can't be listed or revoked until their next sign-in.
function sessionOk(payload) {
  if (!payload?.sid) return true
  const row = db.prepare('SELECT revoked_at FROM sessions WHERE id=?').get(payload.sid)
  return !!row && !row.revoked_at
}
// Cheap "last seen": only write when the stored value is over a minute old, so
// an active client doesn't cost a write per request.
function touchSession(sid) {
  if (!sid) return
  const row = db.prepare('SELECT last_seen_at FROM sessions WHERE id=?').get(sid)
  if (row && Date.now() - Date.parse(row.last_seen_at) > 60000) {
    db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(now(), sid)
  }
}

// Verify a raw JWT (e.g. from a WebSocket query string, where headers can't be
// set) and return the matching user row, or null if invalid/expired/unknown.
export function verifyToken(token) {
  if (!token) return null
  try {
    const payload = jwt.verify(token, SECRET)
    if (!sessionOk(payload)) return null   // a revoked device must not keep its socket either
    return db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub) || null
  } catch {
    return null
  }
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Authentication required' })
  try {
    const payload = jwt.verify(token, SECRET)
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub)
    if (!user) return res.status(401).json({ error: 'Invalid session' })
    if (!sessionOk(payload)) return res.status(401).json({ error: 'This device was signed out' })
    touchSession(payload.sid)
    req.user = user
    req.sessionId = payload.sid || null
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

// Role-gate. Usage: requireRole('admin') or requireRole('admin','manager')
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' })
    }
    next()
  }
}

// Platform-admin gate: only a flagged super-admin may access cross-org routes.
// This is the single, deliberate exception to per-org isolation.
export function requirePlatformAdmin(req, res, next) {
  if (!req.user || !req.user.platform_admin) {
    return res.status(403).json({ error: 'Platform admin access required' })
  }
  next()
}

// Emails designated as platform admins via env (comma-separated). The operator
// controls this on the server, so super-admins can't be self-granted in the app.
export function platformAdminEmails() {
  return (process.env.PLATFORM_ADMIN_EMAILS || '')
    .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)
}
