// Shareable join link + org code, with manager approval.
//
// The org already had per-person invites (routes/invites.js): a manager types an
// email, the recipient gets a token bound to that address, one use. That works,
// but it does not scale — bringing twenty people in means twenty typed emails,
// and the manager has to know every address up front.
//
// This is the other half: ONE link (and a short code for reading aloud) that a
// manager can drop in a group chat. Because that reverses who initiates, every
// request lands in a queue and becomes an account only when a manager approves
// it. A leaked link therefore costs an approval prompt, never access.
//
// Two deliberate differences from invites:
//   - `email_verified` stays 0. An invite link proves the address (we sent it
//     there); here the person typed it, so nothing is proven.
//   - The org's allowed-domains rule still applies. A new door must not bypass a
//     lock the org already chose to fit.
import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requireRole, hashPassword } from '../auth.js'
import { publicUser } from './auth.js'
import { id, now, appUrl, audit, emailDomainAllowed, orgAllowedDomains, isCommonPassword, notifyManagers } from '../util.js'
import { sendMail } from '../mailer.js'

const r = Router()
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Codes get read out loud and typed on phones, so the alphabet omits the pairs
// that get misheard or mistyped: no O/0, I/1/L, S/5, B/8. 6 chars from 26 symbols
// is ~309M combinations — far past guessing, while still short enough to say.
const CODE_ALPHABET = '234679ACDEFGHJKMNPQRTUVWXY'
const CODE_LEN = 6

function newCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    let c = ''
    for (let i = 0; i < CODE_LEN; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    if (!db.prepare('SELECT 1 FROM organizations WHERE join_code = ?').get(c)) return c
  }
  throw new Error('Could not allocate a unique join code')
}

const orgRow = (orgId) => db.prepare('SELECT id, name, join_code, join_enabled, join_role, join_expires_at FROM organizations WHERE id = ?').get(orgId)
const linkFor = (code) => `${appUrl()}/join/${code}`

// The public shape of the setting, shared by every manager-facing response.
function settings(org) {
  return {
    code: org.join_code || null,
    link: org.join_code ? linkFor(org.join_code) : null,
    enabled: !!org.join_enabled,
    role: org.join_role || 'employee',
    expires_at: org.join_expires_at || null,
    allowed_domains: orgAllowedDomains(org.id),
  }
}

// An org that is currently accepting joins on this code — or null. Every public
// route funnels through here so "disabled" and "expired" can never be forgotten
// at one call site.
function openOrgFor(code) {
  if (!code) return null
  const org = db.prepare('SELECT * FROM organizations WHERE join_code = ?').get(String(code).toUpperCase().trim())
  if (!org || !org.join_enabled) return null
  if (org.join_expires_at && org.join_expires_at < now()) return null
  return org
}

/* ------------------------------------------------------------------ public -- */

// What the /join/:code screen shows before anyone types anything. Deliberately
// thin: the org name (so you know where you are landing) and nothing else.
r.get('/lookup/:code', (req, res) => {
  const org = openOrgFor(req.params.code)
  if (!org) return res.status(404).json({ error: 'This join link is not active. Ask your manager for a new one.' })
  res.json({ org_name: org.name, role: org.join_role || 'employee', allowed_domains: orgAllowedDomains(org.id) })
})

// Ask to join. Creates a REQUEST, never a user.
r.post('/request', (req, res) => {
  const org = openOrgFor(req.body?.code)
  if (!org) return res.status(404).json({ error: 'This join link is not active. Ask your manager for a new one.' })

  const name = String(req.body?.name || '').trim()
  const email = String(req.body?.email || '').toLowerCase().trim()
  const password = String(req.body?.password || '')
  if (!name) return res.status(400).json({ error: 'Please enter your name.' })
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })
  if (isCommonPassword(password)) return res.status(400).json({ error: 'That password is too common — please choose a stronger one.' })
  if (!emailDomainAllowed(org.id, email)) {
    return res.status(400).json({ error: `This workspace only accepts ${orgAllowedDomains(org.id).join(', ')} addresses.` })
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with this email already exists. Please log in instead.' })
  }
  const pending = db.prepare("SELECT 1 FROM join_requests WHERE org_id=? AND email=? AND status='pending'").get(org.id, email)
  if (pending) return res.status(409).json({ error: 'You have already asked to join. A manager still needs to approve it.' })

  const reqId = id('jr')
  db.prepare(`INSERT INTO join_requests (id, org_id, name, email, password_hash, status, created_at)
    VALUES (?,?,?,?,?, 'pending', ?)`).run(reqId, org.id, name, email, hashPassword(password), now())
  audit(org.id, null, 'join.request', 'join_request', reqId, email)
  notifyManagers(org.id, 'join_request', `${name} (${email}) asked to join the workspace`)
  res.status(201).json({ ok: true, org_name: org.name })
})

/* ----------------------------------------------------------------- manager -- */
r.use(authRequired)

r.get('/code', requireRole('manager', 'admin'), (req, res) => res.json(settings(orgRow(req.user.org_id))))

// Rotate. The previous code stops working the instant this returns — that is the
// whole point, it is the "someone shared it too widely" button.
r.post('/code/rotate', requireRole('manager', 'admin'), (req, res) => {
  const code = newCode()
  db.prepare('UPDATE organizations SET join_code=? WHERE id=?').run(code, req.user.org_id)
  audit(req.user.org_id, req.user.id, 'join.code_rotate', 'organization', req.user.org_id, code)
  res.json(settings(orgRow(req.user.org_id)))
})

r.patch('/code', requireRole('manager', 'admin'), (req, res) => {
  const org = orgRow(req.user.org_id)
  const patch = {}
  if (req.body?.enabled !== undefined) patch.join_enabled = req.body.enabled ? 1 : 0
  if (req.body?.role !== undefined) {
    const role = String(req.body.role).toLowerCase()
    if (!['employee', 'manager'].includes(role)) return res.status(400).json({ error: 'Joins can only grant employee or manager.' })
    // Mirrors the invites rule: a manager cannot mint admins, so the join link
    // must not become a way around that.
    patch.join_role = role
  }
  if (req.body?.expires_at !== undefined) patch.join_expires_at = req.body.expires_at || null

  // Turning it on with no code yet mints one, so a manager never sees an enabled
  // link with nothing to share.
  if (patch.join_enabled === 1 && !org.join_code) patch.join_code = newCode()

  const keys = Object.keys(patch)
  if (keys.length) {
    db.prepare(`UPDATE organizations SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`)
      .run(...keys.map((k) => patch[k]), req.user.org_id)
    audit(req.user.org_id, req.user.id, 'join.code_update', 'organization', req.user.org_id, keys.join(','))
  }
  res.json(settings(orgRow(req.user.org_id)))
})

r.get('/requests', requireRole('manager', 'admin'), (req, res) => {
  res.json(db.prepare(
    "SELECT id, name, email, created_at FROM join_requests WHERE org_id=? AND status='pending' ORDER BY created_at ASC"
  ).all(req.user.org_id))
})

// Approve: replay the request into `users` with the password they already chose,
// so they can sign in immediately with what they typed and nothing needs resetting.
r.post('/requests/:id/approve', requireRole('manager', 'admin'), async (req, res) => {
  const jr = db.prepare("SELECT * FROM join_requests WHERE id=? AND org_id=? AND status='pending'").get(req.params.id, req.user.org_id)
  if (!jr) return res.status(404).json({ error: 'That request is no longer pending.' })
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(jr.email)) {
    db.prepare("UPDATE join_requests SET status='denied', decided_at=?, decided_by=? WHERE id=?").run(now(), req.user.id, jr.id)
    return res.status(409).json({ error: 'Someone already signed up with that email.' })
  }
  const org = orgRow(req.user.org_id)
  const role = org.join_role || 'employee'

  const approve = db.transaction(() => {
    const uid = id('usr')
    // email_verified stays 0: unlike an invite link, nothing here proved the
    // address — the person typed it themselves.
    db.prepare(`INSERT INTO users
      (id, org_id, department_id, name, email, password_hash, role, aliases, preferred_language, avatar_color, email_verified, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`).run(
      uid, jr.org_id, null, jr.name, jr.email, jr.password_hash, role, '', 'en', '#6366f1', now())
    db.prepare("UPDATE join_requests SET status='approved', decided_at=?, decided_by=? WHERE id=?").run(now(), req.user.id, jr.id)
    return db.prepare('SELECT * FROM users WHERE id=?').get(uid)
  })
  const user = approve()
  audit(req.user.org_id, req.user.id, 'join.approve', 'user', user.id, jr.email)
  try {
    await sendMail({
      to: jr.email,
      subject: `You're in — ${org.name}`,
      text: `${req.user.name} approved your request to join ${org.name}.\n\nSign in at ${appUrl()}/login with the password you chose.`,
    })
  } catch (err) { console.warn('[join] approval email failed:', err.message) }
  res.status(201).json({ user: publicUser(user) })
})

r.post('/requests/:id/deny', requireRole('manager', 'admin'), (req, res) => {
  const jr = db.prepare("SELECT * FROM join_requests WHERE id=? AND org_id=? AND status='pending'").get(req.params.id, req.user.org_id)
  if (!jr) return res.status(404).json({ error: 'That request is no longer pending.' })
  db.prepare("UPDATE join_requests SET status='denied', decided_at=?, decided_by=? WHERE id=?").run(now(), req.user.id, jr.id)
  audit(req.user.org_id, req.user.id, 'join.deny', 'join_request', jr.id, jr.email)
  res.json({ ok: true })
})

export default r
