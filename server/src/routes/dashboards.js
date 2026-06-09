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

// MANAGER dashboard: team view.
// Optional ?from=&to= (YYYY-MM-DD) scopes every figure to tasks CREATED in that
// window, so the manager's Today / Week / Month / Custom buttons re-filter the
// live dashboard. With no range the whole org is shown.
r.get('/manager', requireRole('manager', 'admin'), (req, res) => {
  const org = req.user.org_id
  let { from, to } = req.query
  const valid = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  const scoped = valid(from) && valid(to)
  if (scoped && from > to) [from, to] = [to, from]
  const inRange = (iso) => { if (!scoped) return true; if (!iso) return false; const day = String(iso).slice(0, 10); return day >= from && day <= to }
  const OPEN_STATUSES = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Reopened']

  const allTasks = db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE t.org_id=? AND t.parent_task_id IS NULL AND t.visible_to_manager=1`).all(org)
  const tasks = allTasks.filter((t) => inRange(t.created_at))
  const overdue = tasks.filter((t) => t.due_date && t.due_date < today() && t.status !== 'Done')

  // Workload is derived from the scoped set in JS so it honours the date range.
  const members = db.prepare("SELECT id, name, avatar_color FROM users WHERE org_id=? AND role='employee'").all(org)
  const workload = members.map((u) => {
    const mine = tasks.filter((t) => t.assignee_id === u.id)
    return {
      id: u.id, name: u.name, avatar_color: u.avatar_color,
      open_count: mine.filter((t) => OPEN_STATUSES.includes(t.status)).length,
      done_count: mine.filter((t) => t.status === 'Done').length,
      overdue_count: mine.filter((t) => t.due_date && t.due_date < today() && t.status !== 'Done').length,
    }
  }).sort((a, b) => b.open_count - a.open_count)
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
    by_status: ['To Do', 'In Progress', 'In Review', 'Blocked', 'Reopened', 'Done'].map((s) => ({ status: s, count: tasks.filter((t) => t.status === s).length })),
    workload,
    projects: projects.map((p) => ({ ...p, progress: p.total ? Math.round((p.done / p.total) * 100) : 0 })),
    overdue: overdue.slice(0, 8),
  })
})

// MANAGER report: activity scoped to a date range [from, to] (inclusive, YYYY-MM-DD).
// Powers the Daily / Weekly / Monthly / custom-range downloadable reports.
r.get('/report', requireRole('manager', 'admin'), (req, res) => {
  const org = req.user.org_id
  let { from, to } = req.query
  const valid = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  if (!valid(from) || !valid(to)) return res.status(400).json({ error: 'from and to dates (YYYY-MM-DD) are required' })
  if (from > to) [from, to] = [to, from]
  const inRange = (iso) => { if (!iso) return false; const day = String(iso).slice(0, 10); return day >= from && day <= to }

  const tasks = db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE t.org_id=? AND t.parent_task_id IS NULL AND t.visible_to_manager=1`).all(org)
  const created = tasks.filter((t) => inRange(t.created_at))
  const completed = tasks.filter((t) => t.status === 'Done' && inRange(t.completed_at))
  const dueInRange = tasks.filter((t) => t.due_date && t.due_date >= from && t.due_date <= to)
  const overdue = tasks.filter((t) => t.due_date && t.due_date < today() && t.status !== 'Done')

  const users = db.prepare("SELECT id, name, avatar_color FROM users WHERE org_id=? AND role='employee'").all(org)
  const workload = users.map((u) => ({
    id: u.id, name: u.name, avatar_color: u.avatar_color,
    created_count: created.filter((t) => t.assignee_id === u.id).length,
    completed_count: completed.filter((t) => t.assignee_id === u.id).length,
    overdue_count: overdue.filter((t) => t.assignee_id === u.id).length,
  })).filter((w) => w.created_count || w.completed_count || w.overdue_count)
    .sort((a, b) => b.completed_count - a.completed_count)

  res.json({
    range: { from, to },
    counts: {
      created: created.length,
      completed: completed.length,
      due: dueInRange.length,
      open: created.filter((t) => t.status !== 'Done').length,
      overdue: overdue.length,
    },
    by_priority: ['Critical', 'High', 'Medium', 'Low'].map((p) => ({ priority: p, count: created.filter((t) => t.priority === p).length })),
    by_status: ['To Do', 'In Progress', 'In Review', 'Blocked', 'Reopened', 'Done'].map((s) => ({ status: s, count: created.filter((t) => t.status === s).length })),
    workload,
    completed_tasks: completed.slice(0, 60).map((t) => ({ id: t.id, title: t.title, assignee_name: t.assignee_name, completed_at: t.completed_at })),
    overdue_tasks: overdue.slice(0, 60).map((t) => ({ id: t.id, title: t.title, assignee_name: t.assignee_name, due_date: t.due_date })),
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
