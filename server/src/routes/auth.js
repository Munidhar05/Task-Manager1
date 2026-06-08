import { Router } from 'express'
import { db } from '../db.js'
import { signToken, verifyPassword, authRequired } from '../auth.js'
import { audit } from '../util.js'

const r = Router()

r.post('/login', (req, res) => {
  const { email, password } = req.body || {}
  if (!email || !password) return res.status(400).json({ error: 'email and password required' })
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim())
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }
  audit(user.org_id, user.id, 'auth.login', 'user', user.id)
  res.json({ token: signToken(user), user: publicUser(user) })
})

r.get('/me', authRequired, (req, res) => {
  res.json({ user: publicUser(req.user) })
})

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, org_id: u.org_id, phone: u.phone,
    department_id: u.department_id, preferred_language: u.preferred_language, avatar_color: u.avatar_color,
    avatar_file: u.avatar_file || null }
}

export default r
export { publicUser }
