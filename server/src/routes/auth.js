import { Router } from 'express'
import { db } from '../db.js'
import { signToken, verifyPassword, hashPassword, authRequired } from '../auth.js'
import { audit, id, now, genToken, appUrl, inDays, isCommonPassword } from '../util.js'
import { sendMail } from '../mailer.js'

const r = Router()

// Every new org starts with the same four departments the seed uses, so the
// product is immediately usable after signup.
const DEFAULT_DEPARTMENTS = ['IT', 'Marketing', 'Sales', 'Management']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// SELF-SERVE SIGNUP: create a brand-new organization plus its first account (a
// "manager" — the de-facto org admin in this app) in one atomic step. This is what
// lets a new company onboard itself without anyone provisioning them by hand.
// Append the workspace type so the client can tailor the UI: a "personal" (solo)
// workspace hides team features; a company workspace keeps them. Reuses the same
// org-scoped data model — a solo user is simply an organization of one.
function userWithWorkspace(user) {
  const org = db.prepare('SELECT is_personal FROM organizations WHERE id = ?').get(user.org_id)
  return { ...publicUser(user), workspace_personal: org?.is_personal ? 1 : 0 }
}

r.post('/signup', (req, res) => {
  const personal = !!req.body?.personal
  const name = String(req.body?.name || '').trim()
  const email = String(req.body?.email || '').toLowerCase().trim()
  const password = String(req.body?.password || '')
  // SOLO accounts need no company name — auto-derive a workspace name from the
  // person's name. COMPANY signups still require one. Either way the user is the
  // manager of their own org (org-of-one for solo), so nothing about orgs changes.
  const company = personal
    ? `${(name.split(' ')[0] || name || 'My')}'s workspace`
    : String(req.body?.company || '').trim()

  if (!name || !email || !password || (!personal && !company)) {
    return res.status(400).json({ error: personal
      ? 'Name, email and password are all required.'
      : 'Company, name, email and password are all required.' })
  }
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })
  if (isCommonPassword(password)) return res.status(400).json({ error: 'That password is too common — please choose a stronger one.' })

  // Email is globally unique (one login = one person). Friendly check up front so
  // we don't surface a raw SQLite constraint error.
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' })
  }

  // Provision org + departments + first user atomically: if anything fails, nothing
  // is left half-created.
  // Seed the org's allowed email domains from the founder's domain (company mode).
  // Solo workspaces get no restriction. Admins can edit the list later.
  const founderDomain = email.split('@')[1] || ''
  const provision = db.transaction(() => {
    const orgId = id('org')
    db.prepare('INSERT INTO organizations (id, name, is_personal, allowed_domains, created_at) VALUES (?,?,?,?,?)')
      .run(orgId, company, personal ? 1 : 0, personal ? null : founderDomain, now())
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

  audit(user.org_id, user.id, personal ? 'account.signup' : 'org.signup', 'organization', user.org_id, company)
  sendVerificationEmail(user).catch((e) => console.warn('[auth] verification email failed:', e.message))
  res.status(201).json({ token: signToken(user), user: userWithWorkspace(user) })
})

r.post('/login', (req, res) => {
  const { email, password } = req.body || {}
  if (!email || !password) return res.status(400).json({ error: 'email and password required' })
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim())
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }
  audit(user.org_id, user.id, 'auth.login', 'user', user.id)
  res.json({ token: signToken(user), user: userWithWorkspace(user) })
})

r.get('/me', authRequired, (req, res) => {
  res.json({ user: userWithWorkspace(req.user) })
})

// ---------------------------------------------------------------------------
// Email verification (non-blocking: users can still use the app while unverified;
// the client shows a gentle "verify your email" banner).
// ---------------------------------------------------------------------------
async function sendVerificationEmail(user) {
  const token = genToken()
  db.prepare('INSERT INTO email_verifications (token, user_id, expires_at, used, created_at) VALUES (?,?,?,?,?)')
    .run(token, user.id, inDays(7), 0, now())
  const link = `${appUrl()}/verify-email?token=${token}`
  await sendMail({
    to: user.email,
    subject: 'Verify your email for SmartTask',
    text: `Welcome to SmartTask! Confirm your email address:\n${link}\n\nThis link expires in 7 days.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto">
      <h2 style="color:#c2410c">Confirm your email</h2>
      <p>Welcome to SmartTask! Click below to verify <b>${user.email}</b>.</p>
      <p><a href="${link}" style="display:inline-block;background:#c2410c;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Verify email</a></p>
      <p style="color:#999;font-size:12px">This link expires in 7 days.</p></div>`,
  })
}

// Confirm an email-verification token.
r.post('/verify-email', (req, res) => {
  const token = String(req.body?.token || '')
  const row = db.prepare('SELECT * FROM email_verifications WHERE token = ?').get(token)
  if (!row || row.used || row.expires_at < now()) {
    return res.status(400).json({ error: 'This verification link is invalid or has expired.' })
  }
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id)
    db.prepare('UPDATE email_verifications SET used = 1 WHERE token = ?').run(token)
  })
  tx()
  res.json({ ok: true })
})

// Re-send the verification email to the logged-in user.
r.post('/resend-verification', authRequired, async (req, res) => {
  if (req.user.email_verified) return res.json({ ok: true, already: true })
  try { await sendVerificationEmail(req.user) } catch (e) { console.warn('[auth] resend failed:', e.message) }
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Password reset ("forgot password").
// ---------------------------------------------------------------------------

// Request a reset link. Always returns 200 so we never reveal whether an email
// is registered (prevents account enumeration).
r.post('/forgot-password', async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim()
  const user = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null
  if (user) {
    const token = genToken()
    db.prepare('INSERT INTO password_resets (token, user_id, expires_at, used, created_at) VALUES (?,?,?,?,?)')
      .run(token, user.id, inDays(1), 0, now())
    const link = `${appUrl()}/reset-password?token=${token}`
    try {
      await sendMail({
        to: email,
        subject: 'Reset your SmartTask password',
        text: `Reset your password:\n${link}\n\nThis link expires in 24 hours. If you didn't request this, you can ignore this email.`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#c2410c">Reset your password</h2>
          <p><a href="${link}" style="display:inline-block;background:#c2410c;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Choose a new password</a></p>
          <p style="color:#666;font-size:13px">Or paste this link into your browser:<br>${link}</p>
          <p style="color:#999;font-size:12px">This link expires in 24 hours. If you didn't request this, ignore this email.</p></div>`,
      })
    } catch (e) { console.warn('[auth] reset email failed:', e.message) }
  }
  res.json({ ok: true })
})

// Complete the reset with a valid token.
r.post('/reset-password', (req, res) => {
  const token = String(req.body?.token || '')
  const password = String(req.body?.password || '')
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })
  if (isCommonPassword(password)) return res.status(400).json({ error: 'That password is too common — please choose a stronger one.' })
  const row = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token)
  if (!row || row.used || row.expires_at < now()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired.' })
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id)
  if (!user) return res.status(400).json({ error: 'This reset link is invalid or has expired.' })
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id)
    db.prepare('UPDATE password_resets SET used = 1 WHERE token = ?').run(token)
    // Invalidate any other outstanding reset tokens for this user.
    db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0').run(user.id)
  })
  tx()
  audit(user.org_id, user.id, 'auth.password_reset', 'user', user.id)
  res.json({ ok: true })
})

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, org_id: u.org_id, phone: u.phone,
    department_id: u.department_id, preferred_language: u.preferred_language, avatar_color: u.avatar_color,
    avatar_file: u.avatar_file || null, email_verified: u.email_verified ? 1 : 0 }
}

export default r
export { publicUser }
