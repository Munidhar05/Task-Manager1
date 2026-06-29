import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requirePlatformAdmin } from '../auth.js'
import { audit } from '../util.js'

// CROSS-ORG platform admin routes. The ONLY place that reads/writes across orgs —
// gated to a flagged super-admin. Normal org isolation is untouched everywhere else.
const r = Router()
r.use(authRequired, requirePlatformAdmin)

// Platform-wide totals.
r.get('/stats', (req, res) => {
  res.json({
    orgs: db.prepare('SELECT COUNT(*) c FROM organizations').get().c,
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    tasks: db.prepare('SELECT COUNT(*) c FROM tasks').get().c,
  })
})

// Every organization with per-org counts, owner, and last activity.
r.get('/orgs', (req, res) => {
  const rows = db.prepare(`
    SELECT o.id, o.name, o.is_personal, o.allowed_domains, o.created_at,
      (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id) AS user_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.org_id = o.id) AS task_count,
      (SELECT MAX(created_at) FROM audit_logs a WHERE a.org_id = o.id) AS last_activity,
      (SELECT email FROM users u WHERE u.org_id = o.id ORDER BY created_at ASC LIMIT 1) AS owner_email
    FROM organizations o
    ORDER BY o.created_at DESC`).all()
  res.json(rows.map((o) => ({ ...o, allowed_domains: (o.allowed_domains || '').split(',').filter(Boolean) })))
})

// One org's members + task breakdown by status (read-only detail). Counts only —
// no task content crosses the org boundary, keeping tenant isolation intact.
r.get('/orgs/:id', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(req.params.id)
  if (!org) return res.status(404).json({ error: 'Not found' })
  const members = db.prepare('SELECT id, name, email, role, platform_admin, created_at FROM users WHERE org_id=? ORDER BY created_at').all(org.id)
  const by_status = db.prepare('SELECT status, COUNT(*) AS count FROM tasks WHERE org_id=? GROUP BY status ORDER BY count DESC').all(org.id)
  const task_count = by_status.reduce((sum, s) => sum + s.count, 0)
  res.json({ org: { ...org, allowed_domains: (org.allowed_domains || '').split(',').filter(Boolean) }, members, by_status, task_count })
})

// Org-scoped tables, deleted in dependency order. Tables without org_id are skipped
// safely (the DELETE throws "no such column" and is caught).
const ORG_TABLES = [
  'transcript_segments', 'task_dependencies', 'task_comments', 'attachments', 'suggested_tasks', 'tasks',
  'meeting_participants', 'meetings', 'chat_reactions', 'chat_stars', 'chat_message_hidden', 'chat_messages',
  'chat_participants', 'chat_conversations', 'conversations', 'notifications', 'device_tokens', 'embeddings',
  'invites', 'audit_logs', 'projects', 'departments', 'users',
]

// DELETE an organization and ALL its data. Cannot delete your own org from here.
r.delete('/orgs/:id', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(req.params.id)
  if (!org) return res.status(404).json({ error: 'Not found' })
  if (org.id === req.user.org_id) return res.status(400).json({ error: 'You cannot delete your own organization from here.' })
  // Disable FK enforcement for the bulk wipe so delete order doesn't matter, then
  // re-enable. (PRAGMA foreign_keys must be toggled OUTSIDE a transaction.)
  db.pragma('foreign_keys = OFF')
  try {
    const tx = db.transaction(() => {
      const userIds = db.prepare('SELECT id FROM users WHERE org_id=?').all(org.id).map((u) => u.id)
      for (const uid of userIds) {
        try { db.prepare('DELETE FROM password_resets WHERE user_id=?').run(uid) } catch {}
        try { db.prepare('DELETE FROM email_verifications WHERE user_id=?').run(uid) } catch {}
      }
      for (const t of ORG_TABLES) { try { db.prepare(`DELETE FROM ${t} WHERE org_id=?`).run(org.id) } catch {} }
      db.prepare('DELETE FROM organizations WHERE id=?').run(org.id)
    })
    tx()
  } finally {
    db.pragma('foreign_keys = ON')
  }
  audit(req.user.org_id, req.user.id, 'platform.org_delete', 'organization', org.id, org.name)
  res.json({ ok: true })
})

export default r
