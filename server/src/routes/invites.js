import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requireRole, signToken, hashPassword } from '../auth.js'
import { publicUser } from './auth.js'
import { id, now, genToken, appUrl, inDays, audit } from '../util.js'
import { sendMail } from '../mailer.js'

const r = Router()
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INVITE_TTL_DAYS = 7

// A pending, non-expired invite for this token — or null.
function validInvite(token) {
  if (!token) return null
  const inv = db.prepare('SELECT * FROM invites WHERE token = ?').get(token)
  if (!inv || inv.status !== 'pending' || inv.expires_at < now()) return null
  return inv
}

function inviteEmailHtml(inviterName, orgName, role, link) {
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto">
    <h2 style="color:#c2410c">You're invited to ${orgName}</h2>
    <p>${inviterName} invited you to join <b>${orgName}</b> on SmartTask as a <b>${role}</b>.</p>
    <p><a href="${link}" style="display:inline-block;background:#c2410c;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Accept invitation</a></p>
    <p style="color:#666;font-size:13px">Or paste this link into your browser:<br>${link}</p>
    <p style="color:#999;font-size:12px">This invitation expires in ${INVITE_TTL_DAYS} days.</p>
  </div>`
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

  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(req.user.org_id)
  const link = `${appUrl()}/accept-invite?token=${token}`
  let emailed = false
  try {
    const sent = await sendMail({
      to: email,
      subject: `You're invited to ${org?.name || 'SmartTask'}`,
      text: `${req.user.name} invited you to join ${org?.name || 'SmartTask'} as a ${role}.\n\nAccept and set your password:\n${link}\n\nThis link expires in ${INVITE_TTL_DAYS} days.`,
      html: inviteEmailHtml(req.user.name, org?.name || 'SmartTask', role, link),
    })
    emailed = sent.sent
  } catch (err) { console.warn('[invites] email failed:', err.message) }

  // Always return the link so the manager can copy/share it manually — essential
  // when SMTP isn't configured (preview mode) or the email is delayed.
  res.status(201).json({ id: invId, email, role, department_id: departmentId, status: 'pending', link, emailed })
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
