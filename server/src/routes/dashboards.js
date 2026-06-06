import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requireRole } from '../auth.js'

const r = Router()
r.use(authRequired)
const today = () => new Date().toISOString().slice(0, 10)
const OPEN = "('To Do','In Progress','Blocked','In Review','Reopened')"

// EMPLOYEE dashboard: my work
r.get('/employee', (req, res) => {
  const uid = req.user.id
  const mine = db.prepare(`SELECT t.*, m.title AS meeting_title FROM tasks t LEFT JOIN meetings m ON m.id=t.meeting_id
    WHERE t.assignee_id=? AND t.parent_task_id IS NULL`).all(uid)
  const open = mine.filter((t) => !['Done'].includes(t.status))
  res.json({
    counts: {
      assigned: mine.length,
      pending: open.length,
      completed: mine.filter((t) => t.status === 'Done').length,
      overdue: mine.filter((t) => t.due_date && t.due_date < today() && t.status !== 'Done').length,
      blocked: mine.filter((t) => t.status === 'Blocked').length,
    },
    upcoming: open.filter((t) => t.due_date).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || '')).slice(0, 6),
    by_status: ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done'].map((s) => ({ status: s, count: mine.filter((t) => t.status === s).length })),
    needs_confirmation: mine.filter((t) => t.ownership_confidence === 'needs_confirmation').length,
  })
})

// MANAGER dashboard: team view
r.get('/manager', requireRole('manager', 'admin'), (req, res) => {
  const org = req.user.org_id
  const tasks = db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE t.org_id=? AND t.parent_task_id IS NULL AND t.visible_to_manager=1`).all(org)
  const overdue = tasks.filter((t) => t.due_date && t.due_date < today() && t.status !== 'Done')
  const workload = db.prepare(`
    SELECT u.id, u.name, u.avatar_color,
      SUM(CASE WHEN t.status IN ${OPEN} THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN t.status='Done' THEN 1 ELSE 0 END) AS done_count,
      SUM(CASE WHEN t.due_date < ? AND t.status!='Done' AND t.due_date IS NOT NULL THEN 1 ELSE 0 END) AS overdue_count
    FROM users u LEFT JOIN tasks t ON t.assignee_id=u.id AND t.parent_task_id IS NULL AND t.visible_to_manager=1
    WHERE u.org_id=? AND u.role='employee' GROUP BY u.id ORDER BY open_count DESC
  `).all(today(), org)
  const projects = db.prepare(`
    SELECT p.id, p.name,
      COUNT(t.id) AS total,
      SUM(CASE WHEN t.status='Done' THEN 1 ELSE 0 END) AS done
    FROM projects p LEFT JOIN tasks t ON t.project_id=p.id WHERE p.org_id=? GROUP BY p.id
  `).all(org)
  const meetings = db.prepare('SELECT COUNT(*) c FROM meetings WHERE org_id=?').get(org).c
  res.json({
    counts: {
      total: tasks.length,
      open: tasks.filter((t) => t.status !== 'Done').length,
      completed: tasks.filter((t) => t.status === 'Done').length,
      overdue: overdue.length,
      blocked: tasks.filter((t) => t.status === 'Blocked').length,
      needs_confirmation: tasks.filter((t) => t.ownership_confidence === 'needs_confirmation').length,
      meetings,
    },
    by_priority: ['Critical', 'High', 'Medium', 'Low'].map((p) => ({ priority: p, count: tasks.filter((t) => t.priority === p && t.status !== 'Done').length })),
    workload,
    projects: projects.map((p) => ({ ...p, progress: p.total ? Math.round((p.done / p.total) * 100) : 0 })),
    overdue: overdue.slice(0, 8),
  })
})

// ADMIN dashboard: org-wide. The manager is the org admin, so it owns this view.
r.get('/admin', requireRole('manager', 'admin'), (req, res) => {
  const org = req.user.org_id
  const users = db.prepare('SELECT role, COUNT(*) c FROM users WHERE org_id=? GROUP BY role').all(org)
  const tasks = db.prepare('SELECT status, COUNT(*) c FROM tasks WHERE org_id=? AND parent_task_id IS NULL GROUP BY status').all(org)
  const totals = {
    users: db.prepare('SELECT COUNT(*) c FROM users WHERE org_id=?').get(org).c,
    tasks: db.prepare('SELECT COUNT(*) c FROM tasks WHERE org_id=? AND parent_task_id IS NULL').get(org).c,
    meetings: db.prepare('SELECT COUNT(*) c FROM meetings WHERE org_id=?').get(org).c,
    projects: db.prepare('SELECT COUNT(*) c FROM projects WHERE org_id=?').get(org).c,
  }
  const recentAudit = db.prepare(`SELECT a.*, u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
    WHERE a.org_id=? ORDER BY a.created_at DESC LIMIT 25`).all(org)
  res.json({ totals, users_by_role: users, tasks_by_status: tasks, recent_audit: recentAudit })
})

export default r
