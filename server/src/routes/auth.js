import { Router } from 'express'
import { db } from '../db.js'
import { signToken, verifyPassword, hashPassword, authRequired } from '../auth.js'
import { audit, id, now } from '../util.js'

const r = Router()

// Every new org starts with the same four departments the seed uses, so the
// product is immediately usable after signup.
const DEFAULT_DEPARTMENTS = ['IT', 'Marketing', 'Sales', 'Management']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// SELF-SERVE SIGNUP: create a brand-new organization plus its first account (a
// "manager" — the de-facto org admin in this app) in one atomic step. This is what
// lets a new company onboard itself without anyone provisioning them by hand.
r.post('/signup', (req, res) => {
  const company = String(req.body?.company || '').trim()
  const name = String(req.body?.name || '').trim()
  const email = String(req.body?.email || '').toLowerCase().trim()
  const password = String(req.body?.password || '')

  if (!company || !name || !email || !password) {
    return res.status(400).json({ error: 'Company, name, email and password are all required.' })
  }
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })

  // Email is globally unique (one login = one person). Friendly check up front so
  // we don't surface a raw SQLite constraint error.
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' })
  }

  // Provision org + departments + first user atomically: if anything fails, nothing
  // is left half-created.
  const provision = db.transaction(() => {
    const orgId = id('org')
    db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)').run(orgId, company, now())
    let mgmtDeptId = null
    for (const dept of DEFAULT_DEPARTMENTS) {
      const did = id('dep')
      db.prepare('INSERT INTO departments (id, org_id, name) VALUES (?,?,?)').run(did, orgId, dept)
      if (dept === 'Management') mgmtDeptId = did
    }
    const uid = id('usr')
    db.prepare(`INSERT INTO users
      (id, org_id, department_id, name, email, password_hash, role, aliases, preferred_language, avatar_color, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      uid, orgId, mgmtDeptId, name, email, hashPassword(password), 'manager', '', 'en', '#6366f1', now())
    return db.prepare('SELECT * FROM users WHERE id = ?').get(uid)
  })

  let user
  try { user = provision() }
  catch (err) {
    console.error('[auth] signup failed:', err.message)
    // Unique-constraint race (email taken between the check and the insert).
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' })
    }
    return res.status(500).json({ error: 'Could not create your account. Please try again.' })
  }

  audit(user.org_id, user.id, 'org.signup', 'organization', user.org_id, company)
  res.status(201).json({ token: signToken(user), user: publicUser(user) })
})

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
