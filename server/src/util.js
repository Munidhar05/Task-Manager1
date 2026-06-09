import { customAlphabet } from 'nanoid'

const nano = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12)
export const id = (prefix = '') => (prefix ? `${prefix}_` : '') + nano()
export const now = () => new Date().toISOString()

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
export function audit(orgId, actorId, action, entityType, entityId, detail = '') {
  db.prepare(
    `INSERT INTO audit_logs (id, org_id, actor_id, action, entity_type, entity_id, detail, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id('aud'), orgId, actorId, action, entityType, entityId, typeof detail === 'string' ? detail : JSON.stringify(detail), now())
}

// Create an in-app notification for a single recipient.
export function notify(orgId, userId, type, message, taskId = null) {
  if (!userId) return
  db.prepare(
    `INSERT INTO notifications (id, org_id, user_id, type, message, task_id, read, created_at)
     VALUES (?,?,?,?,?,?,0,?)`
  ).run(id('ntf'), orgId, userId, type, message, taskId, now())
}

// Notify every manager/admin in the org (e.g. when an employee submits work).
export function notifyManagers(orgId, type, message, taskId = null, excludeId = null) {
  const mgrs = db.prepare("SELECT id FROM users WHERE org_id=? AND role IN ('manager','admin')").all(orgId)
  for (const m of mgrs) if (m.id !== excludeId) notify(orgId, m.id, type, message, taskId)
}
