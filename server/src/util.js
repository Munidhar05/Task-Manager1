import { customAlphabet } from 'nanoid'
import crypto from 'node:crypto'

const nano = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12)
export const id = (prefix = '') => (prefix ? `${prefix}_` : '') + nano()
export const now = () => new Date().toISOString()

// A high-entropy, URL-safe token for invite / password-reset / verification links.
// 32 random bytes → 43-char base64url string (far stronger than an id()).
export const genToken = () => crypto.randomBytes(32).toString('base64url')

// Base URL of the front-end, used to build links inside emails. In production the
// API and the web client share one origin (set APP_URL to it on Render); locally
// the Vite dev server runs on :5173.
export const appUrl = () => (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')

// An ISO timestamp `days` in the future — for token expiry.
export const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString()

// Default lead time (in days from today) for each priority — used to auto-fill a
// task's due date when none was set. Critical = today, High = tomorrow, etc.
const DUE_DAYS_BY_PRIORITY = { Critical: 0, High: 1, Medium: 3, Low: 5 }

// Compute a default due date (YYYY-MM-DD, in the server's local timezone) from a
// priority. Local date parts are used so "same day" is correct for IST evenings.
export function dueDateForPriority(priority, from = new Date()) {
  const days = DUE_DAYS_BY_PRIORITY[priority] ?? DUE_DAYS_BY_PRIORITY.Medium
  const d = new Date(from)
  d.setDate(d.getDate() + days)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${da}`
}

import { db } from './db.js'
import { sendPushToUser } from './push.js'

// --- Password safety: reject the most common/breached passwords server-side ---
// (Defense in depth — the client also blocks these, but the API enforces it too.)
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890',
  'qwerty', 'qwertyui', 'qwerty123', '11111111', '00000000', 'abc12345', 'iloveyou',
  'admin123', 'welcome1', 'welcome123', 'letmein1', 'letmein123', 'football', 'monkey12',
  'sunshine', 'princess', 'dragon123', 'master123', 'login123', 'changeme', 'secret12',
])
export function isCommonPassword(pw) {
  return COMMON_PASSWORDS.has(String(pw || '').toLowerCase())
}

// --- Per-org allowed email domains -----------------------------------------
// An org may restrict which email domains its members can use (e.g. befach.com,
// gmail.com). Empty list = no restriction (any domain allowed). Used by user
// creation, imports, and invites so every org enforces its OWN domains.
export function orgAllowedDomains(orgId) {
  const org = db.prepare('SELECT allowed_domains FROM organizations WHERE id=?').get(orgId)
  const raw = (org?.allowed_domains || '').trim()
  return raw ? raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean) : []
}
export function emailDomainAllowed(orgId, email) {
  const domains = orgAllowedDomains(orgId)
  if (!domains.length) return true // no restriction configured
  const dom = String(email || '').toLowerCase().split('@')[1] || ''
  return domains.includes(dom)
}

export function audit(orgId, actorId, action, entityType, entityId, detail = '') {
  db.prepare(
    `INSERT INTO audit_logs (id, org_id, actor_id, action, entity_type, entity_id, detail, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id('aud'), orgId, actorId, action, entityType, entityId, typeof detail === 'string' ? detail : JSON.stringify(detail), now())
}

// Short, human title per notification type — shown as the push heading.
const PUSH_TITLES = {
  task_assigned: 'New task assigned',
  task_comment: 'New comment',
  task_submitted: 'Task submitted',
  task_approved: 'Task approved',
  task_reopened: 'Task reopened',
  chat_message: 'New message',
}

// Create an in-app notification for a single recipient, and fire a native push
// to their devices (no-op if FCM isn't configured). Push is fire-and-forget so a
// slow/failed send never blocks the request.
export function notify(orgId, userId, type, message, taskId = null) {
  if (!userId) return
  db.prepare(
    `INSERT INTO notifications (id, org_id, user_id, type, message, task_id, read, created_at)
     VALUES (?,?,?,?,?,?,0,?)`
  ).run(id('ntf'), orgId, userId, type, message, taskId, now())
  sendPushToUser(userId, { title: PUSH_TITLES[type] || 'SmartTask', body: message, data: { type, taskId } })
    .catch(() => {})
}

// Notify every manager/admin in the org (e.g. when an employee submits work).
export function notifyManagers(orgId, type, message, taskId = null, excludeId = null) {
  const mgrs = db.prepare("SELECT id FROM users WHERE org_id=? AND role IN ('manager','admin')").all(orgId)
  for (const m of mgrs) if (m.id !== excludeId) notify(orgId, m.id, type, message, taskId)
}
