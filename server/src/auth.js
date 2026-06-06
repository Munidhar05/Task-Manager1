import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { db } from './db.js'

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'

export const hashPassword = (pw) => bcrypt.hashSync(pw, 10)
export const verifyPassword = (pw, hash) => bcrypt.compareSync(pw, hash)

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, org_id: user.org_id, name: user.name },
    SECRET,
    { expiresIn: '12h' }
  )
}

// Verify a raw JWT (e.g. from a WebSocket query string, where headers can't be
// set) and return the matching user row, or null if invalid/expired/unknown.
export function verifyToken(token) {
  if (!token) return null
  try {
    const payload = jwt.verify(token, SECRET)
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
    req.user = user
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
