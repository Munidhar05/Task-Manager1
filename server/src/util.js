import { customAlphabet } from 'nanoid'

const nano = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12)
export const id = (prefix = '') => (prefix ? `${prefix}_` : '') + nano()
export const now = () => new Date().toISOString()

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
