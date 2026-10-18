// Six-digit email confirmation codes.
//
// Confirming an address used to mean clicking an emailed link. A link only
// works when whoever opens the mail is the person at the screen, and the
// add-user form is exactly the case where they are not: a manager is creating
// the account and the teammate is the one with the inbox. A code can be read
// out across a desk or over a call; a link can't. The same codes then serve
// people confirming their own address later, so there is one mechanism.
//
// Two scopes share the table:
//   - user_id set: someone confirming their OWN address. A match marks the
//     user verified directly.
//   - user_id NULL: a manager confirming an address before the account exists
//     (or before moving an account onto it). A match hands back a one-time
//     `proof`, which the create / edit request presents so the address lands
//     already verified.
//
// Six digits is only a million values, so the defence is not the length but
// the attempt cap: a code dies after MAX_ATTEMPTS wrong guesses, and a fresh
// one can be asked for once per RESEND_COOLDOWN_MS.
import crypto from 'node:crypto'
import { db } from './db.js'
import { id, now, genToken, appUrl } from './util.js'
import { sendMail } from './mailer.js'

const MAX_ATTEMPTS = 5
const RESEND_COOLDOWN_MS = 60 * 1000
// Someone confirming their own address may not open the mail for days (an
// admin-created account whose owner hasn't signed in yet), so theirs lasts as
// long as the old link did. A manager's code is read out while both people are
// on the line, so it has no reason to outlive the conversation.
const SELF_TTL_MS = 7 * 86400000
const MANAGER_TTL_MS = 15 * 60000
// How long a matched manager code stays good for before the form is submitted.
const PROOF_TTL_MS = 60 * 60000
// A manager can mail a code to any address at all, so cap how many an hour —
// otherwise the add-user form is a way to send our mail to strangers.
const MANAGER_HOURLY_CAP = 20

const isoIn = (ms) => new Date(Date.now() + ms).toISOString()
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0')
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const orgName = (orgId) => db.prepare('SELECT name FROM organizations WHERE id=?').get(orgId)?.name || 'your team'

// The rows one code request competes with. Self scope includes the address,
// so changing your email doesn't leave you waiting out the cooldown of the
// code you were sent for the old one.
function scope({ orgId, email, userId, createdBy }) {
  return userId
    ? { where: 'user_id = ? AND email = ?', args: [userId, email] }
    : { where: 'user_id IS NULL AND org_id = ? AND email = ? AND created_by = ?', args: [orgId, email, createdBy] }
}

// Create a code and mail it. Never throws: a mail failure comes back as an
// error so callers that send best-effort (signup) and callers that report it
// (the resend button) can both decide for themselves.
async function issueAndSend(s, { orgId, email, userId, createdBy, ttlMs, mail }) {
  const last = db.prepare(`SELECT created_at FROM email_codes WHERE ${s.where} ORDER BY created_at DESC LIMIT 1`).get(...s.args)
  const wait = last ? Math.ceil((Date.parse(last.created_at) + RESEND_COOLDOWN_MS - Date.now()) / 1000) : 0
  if (wait > 0) return { error: `A code was just sent. You can ask for another in ${wait}s.`, status: 429 }

  const code = newCode()
  const rowId = id('ec')
  db.transaction(() => {
    // Only the newest code is live, so an older mail can't be the one that works.
    db.prepare(`UPDATE email_codes SET used_at=? WHERE ${s.where} AND used_at IS NULL`).run(now(), ...s.args)
    db.prepare(`INSERT INTO email_codes (id, org_id, user_id, email, code, expires_at, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(rowId, orgId, userId || null, email, code, isoIn(ttlMs), createdBy, now())
  })()
  try {
    const sent = await sendMail({ to: email, ...mail(code) })
    return { ok: true, delivered: sent.mode === 'smtp' }
  } catch (e) {
    // Drop the row so the cooldown doesn't stop an immediate retry of a send
    // that never reached anyone.
    db.prepare('DELETE FROM email_codes WHERE id=?').run(rowId)
    console.warn('[emailCodes] send failed:', e.message)
    return { error: 'Could not send the code. Please try again.', status: 502 }
  }
}

// Find the live code in a scope and compare. A wrong guess is counted against
// that code; the caller decides what a match means.
function match(s, code) {
  const row = db.prepare(`SELECT * FROM email_codes WHERE ${s.where} AND used_at IS NULL AND verified_at IS NULL
    ORDER BY created_at DESC LIMIT 1`).get(...s.args)
  if (!row || row.expires_at < now()) return { error: 'That code has expired. Send a new one.' }
  if (row.attempts >= MAX_ATTEMPTS) return { error: 'Too many wrong codes. Send a new one.' }
  if (String(code || '').replace(/\D/g, '') !== row.code) {
    db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id=?').run(row.id)
    const left = MAX_ATTEMPTS - row.attempts - 1
    return { error: left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Send a new one.' }
  }
  return { row }
}

// --- Confirming your own address -------------------------------------------

// `addedBy` is the manager who just created the account: the mail then says
// who added them and where to sign in, since it is the first they've heard.
export function sendVerificationEmail(user, { addedBy } = {}) {
  const email = String(user.email || '').toLowerCase().trim()
  const s = scope({ email, userId: user.id })
  const intro = addedBy
    ? `${addedBy.name} added you to ${orgName(user.org_id)} on SmartTask. Sign in at ${appUrl()} with ${email} and enter this code to confirm your email:`
    : `Enter this code in SmartTask to confirm ${email}:`
  return issueAndSend(s, {
    orgId: user.org_id, email, userId: user.id, createdBy: addedBy?.id || user.id, ttlMs: SELF_TTL_MS,
    mail: (code) => ({
      subject: `${code} is your SmartTask confirmation code`,
      text: `${intro}\n\n${code}\n\nThe code expires in 7 days. If you weren't expecting this, you can ignore this email.`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#c2410c">Confirm your email</h2>
        <p>${esc(intro)}</p>
        <p style="font-size:30px;font-weight:700;letter-spacing:8px;margin:18px 0">${code}</p>
        <p style="color:#999;font-size:12px">The code expires in 7 days. If you weren't expecting this, you can ignore this email.</p></div>`,
    }),
  })
}

// Checks the code against the address the user has NOW — a code mailed to an
// address they've since moved off can't confirm the new one.
export function confirmOwnEmail(user, code) {
  const email = String(user.email || '').toLowerCase().trim()
  const m = match(scope({ email, userId: user.id }), code)
  if (m.error) return m
  db.transaction(() => {
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id)
    db.prepare('UPDATE email_codes SET verified_at=?, used_at=? WHERE id=?').run(now(), now(), m.row.id)
  })()
  return { ok: true }
}

// The address on an account is about to change: nothing issued for the old
// one may confirm the new one. That includes legacy links, which are keyed to
// the user rather than to an address.
export function clearEmailConfirmations(userId) {
  db.prepare('UPDATE email_codes SET used_at=? WHERE user_id=? AND used_at IS NULL').run(now(), userId)
  db.prepare('UPDATE email_verifications SET used=1 WHERE user_id=? AND used=0').run(userId)
}

// --- A manager confirming an address for someone else ----------------------

export function sendManagerCode(manager, email) {
  const sent = db.prepare("SELECT COUNT(*) n FROM email_codes WHERE user_id IS NULL AND created_by=? AND created_at > ?")
    .get(manager.id, new Date(Date.now() - 3600000).toISOString()).n
  if (sent >= MANAGER_HOURLY_CAP) return Promise.resolve({ error: 'Too many codes sent this hour. Try again later.', status: 429 })
  const s = scope({ orgId: manager.org_id, email, createdBy: manager.id })
  const org = orgName(manager.org_id)
  const intro = `${manager.name} is adding ${email} to ${org} on SmartTask. To confirm this address is yours, give them this code:`
  return issueAndSend(s, {
    orgId: manager.org_id, email, createdBy: manager.id, ttlMs: MANAGER_TTL_MS,
    mail: (code) => ({
      subject: `${code} is your code to join ${org} on SmartTask`,
      text: `${intro}\n\n${code}\n\nThe code expires in 15 minutes. If you weren't expecting this, ignore this email.`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#c2410c">Confirm your email</h2>
        <p>${esc(intro)}</p>
        <p style="font-size:30px;font-weight:700;letter-spacing:8px;margin:18px 0">${code}</p>
        <p style="color:#999;font-size:12px">The code expires in 15 minutes. If you weren't expecting this, ignore this email.</p></div>`,
    }),
  })
}

export function checkManagerCode(manager, email, code) {
  const m = match(scope({ orgId: manager.org_id, email, createdBy: manager.id }), code)
  if (m.error) return m
  const proof = genToken()
  db.prepare('UPDATE email_codes SET verified_at=?, proof=? WHERE id=?').run(now(), proof, m.row.id)
  return { proof }
}

// Look up a proof without spending it, so a request that fails for some other
// reason (a taken email, a bad phone number) can be fixed and resubmitted.
// Returns the row id to pass to useProof once the account is saved.
export function findProof(manager, email, proof) {
  if (!proof) return null
  const row = db.prepare(`SELECT id, verified_at FROM email_codes WHERE user_id IS NULL AND org_id=? AND email=?
    AND created_by=? AND proof=? AND used_at IS NULL`).get(manager.org_id, email, manager.id, String(proof))
  if (!row || Date.parse(row.verified_at) + PROOF_TTL_MS < Date.now()) return null
  return row.id
}

export function useProof(rowId) {
  db.prepare('UPDATE email_codes SET used_at=? WHERE id=?').run(now(), rowId)
}
