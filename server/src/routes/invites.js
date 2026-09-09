import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requireRole, signToken, hashPassword } from '../auth.js'
import { publicUser } from './auth.js'
import { id, now, genToken, appUrl, inDays, audit, emailDomainAllowed, orgAllowedDomains, isCommonPassword } from '../util.js'

const r = Router()
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INVITE_TTL_DAYS = 7

// Invites are LINK-ONLY. No mail is attempted: SMTP is not configured, and a
// send that silently no-ops taught the UI to apologise for a failure that was
// really just missing config. The link is the deliverable — the manager copies it
// and sends it however they already talk to the person.

// A pending, non-expired invite for this token — or null.
function validInvite(token) {
  if (!token) return null
  const inv = db.prepare('SELECT * FROM invites WHERE token = ?').get(token)
  if (!inv || inv.status !== 'pending' || inv.expires_at < now()) return null
  return inv
}

// ---------------------------------------------------------------------------
// Authed: a manager/admin creates, lists, and revokes invites for THEIR org.
// ---------------------------------------------------------------------------

// CREATE an invitation and email it.
r.post('/', authRequired, requireRole('manager', 'admin'), async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim()
  let role = String(req.body?.role || 'employee').toLowerCase().trim()
  const departmentId = req.body?.department_id || null
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required.' })
  // Enforce the org's allowed email domains (if any are configured).
  if (!emailDomainAllowed(req.user.org_id, email)) {
    return res.status(400).json({ error: `Email domain not allowed. This organization permits: ${orgAllowedDomains(req.user.org_id).join(', ')}` })
  }
  if (!['manager', 'employee', 'admin'].includes(role)) role = 'employee'
  // Managers cannot mint admins (mirrors the users route rule).
  if (req.user.role === 'manager' && role === 'admin') {
    return res.status(403).json({ error: 'Managers cannot invite admins.' })
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'Someone with this email already has an account.' })
  }
  if (departmentId) {
    const d = db.prepare('SELECT id FROM departments WHERE id = ? AND org_id = ?').get(departmentId, req.user.org_id)
    if (!d) return res.status(400).json({ error: 'Invalid department.' })
  }

  // Re-inviting the same email supersedes any earlier pending invite.
  db.prepare("UPDATE invites SET status='revoked' WHERE org_id=? AND email=? AND status='pending'").run(req.user.org_id, email)

  const token = genToken()
  const invId = id('inv')
  db.prepare(`INSERT INTO invites
    (id, org_id, email, role, department_id, token, invited_by, status, created_at, accepted_at, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    invId, req.user.org_id, email, role, departmentId, token, req.user.id, 'pending', now(), null, inDays(INVITE_TTL_DAYS))
  audit(req.user.org_id, req.user.id, 'invite.create', 'invite', invId, email)

  const link = `${appUrl()}/accept-invite?token=${token}`

  res.status(201).json({ id: invId, email, role, department_id: departmentId, status: 'pending', link })
})

// LIST pending invites for the org.
r.get('/', authRequired, requireRole('manager', 'admin'), (req, res) => {
  const rows = db.prepare(
    "SELECT id, email, role, department_id, status, created_at, expires_at FROM invites WHERE org_id=? AND status='pending' ORDER BY created_at DESC"
  ).all(req.user.org_id)
  res.json(rows)
})

// REVOKE a pending invite.
r.delete('/:id', authRequired, requireRole('manager', 'admin'), (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!inv) return res.status(404).json({ error: 'Not found' })
  db.prepare("UPDATE invites SET status='revoked' WHERE id=?").run(inv.id)
  audit(req.user.org_id, req.user.id, 'invite.revoke', 'invite', inv.id, inv.email)
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Public (no auth): the invitee looks up and accepts their invitation.
// ---------------------------------------------------------------------------

// LOOK UP an invite so the accept page can show the org name + role.
r.get('/lookup', (req, res) => {
  const inv = validInvite(String(req.query.token || ''))
  if (!inv) return res.status(404).json({ error: 'This invitation is invalid or has expired.' })
  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(inv.org_id)
  res.json({ email: inv.email, role: inv.role, org_name: org?.name || '' })
})

// ACCEPT: create the user (email already proven by the link) and log them in.
r.post('/accept', (req, res) => {
  const inv = validInvite(String(req.body?.token || ''))
  if (!inv) return res.status(404).json({ error: 'This invitation is invalid or has expired.' })
  const name = String(req.body?.name || '').trim()
  const password = String(req.body?.password || '')
  if (!name) return res.status(400).json({ error: 'Please enter your name.' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })
  if (isCommonPassword(password)) return res.status(400).json({ error: 'That password is too common — please choose a stronger one.' })
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(inv.email)) {
    db.prepare("UPDATE invites SET status='accepted', accepted_at=? WHERE id=?").run(now(), inv.id)
    return res.status(409).json({ error: 'An account with this email already exists. Please log in.' })
  }

  const accept = db.transaction(() => {
    const uid = id('usr')
    db.prepare(`INSERT INTO users
      (id, org_id, department_id, name, email, password_hash, role, aliases, preferred_language, avatar_color, email_verified, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      uid, inv.org_id, inv.department_id, name, inv.email, hashPassword(password), inv.role, '', 'en', '#6366f1', 1, now())
    db.prepare("UPDATE invites SET status='accepted', accepted_at=? WHERE id=?").run(now(), inv.id)
    return db.prepare('SELECT * FROM users WHERE id = ?').get(uid)
  })
  const user = accept()
  audit(inv.org_id, user.id, 'invite.accept', 'user', user.id, inv.email)
  res.status(201).json({ token: signToken(user), user: publicUser(user) })
})

export default r
