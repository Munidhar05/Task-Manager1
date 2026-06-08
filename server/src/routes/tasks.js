import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requireRole } from '../auth.js'
import { id, now, audit, notify, notifyManagers, dueDateForPriority } from '../util.js'
import { resolveUser } from '../ai/extractor.js'

const r = Router()
r.use(authRequired)

const VALID_STATUS = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened']

function hydrate(t) {
  if (!t) return t
  const assignee = t.assignee_id ? db.prepare('SELECT id,name,avatar_color,role FROM users WHERE id=?').get(t.assignee_id) : null
  const assignedBy = t.assigned_by_id ? db.prepare('SELECT id,name FROM users WHERE id=?').get(t.assigned_by_id) : null
  const project = t.project_id ? db.prepare('SELECT id,name FROM projects WHERE id=?').get(t.project_id) : null
  const subtasks = db.prepare('SELECT * FROM tasks WHERE parent_task_id=? ORDER BY created_at').all(t.id)
  const comments = db.prepare(`SELECT c.*, u.name AS user_name, u.avatar_color FROM task_comments c JOIN users u ON u.id=c.user_id WHERE c.task_id=? ORDER BY c.created_at`).all(t.id)
  const deps = db.prepare(`SELECT d.depends_on_task_id AS id, t2.title, t2.status FROM task_dependencies d JOIN tasks t2 ON t2.id=d.depends_on_task_id WHERE d.task_id=?`).all(t.id)
  const attachments = db.prepare('SELECT * FROM attachments WHERE task_id=?').all(t.id)
  return { ...t, assignee, assignedBy, project, subtasks, comments, dependencies: deps, attachments }
}

// LIST with filters: ?status=&priority=&assignee=&project=&meeting=&mine=1&q=
r.get('/', (req, res) => {
  const { status, priority, assignee, project, meeting, mine, q, confidence } = req.query
  let sql = `SELECT t.* FROM tasks t WHERE t.org_id=? AND t.parent_task_id IS NULL`
  const args = [req.user.org_id]
  if (req.user.role === 'employee') {
    // Employees see all of their own tasks (including private drafts).
    sql += ' AND t.assignee_id=?'; args.push(req.user.id)
  } else {
    // Managers/admins don't see an employee's private draft until it's submitted.
    sql += ' AND (t.visible_to_manager=1 OR t.assignee_id=?)'; args.push(req.user.id)
  }
  if (mine) { sql += ' AND t.assignee_id=?'; args.push(req.user.id) }
  if (status) { sql += ' AND t.status=?'; args.push(status) }
  if (priority) { sql += ' AND t.priority=?'; args.push(priority) }
  if (assignee === 'unassigned') { sql += ' AND t.assignee_id IS NULL' }
  else if (assignee) { sql += ' AND t.assignee_id=?'; args.push(assignee) }
  if (project) { sql += ' AND t.project_id=?'; args.push(project) }
  if (meeting) { sql += ' AND t.meeting_id=?'; args.push(meeting) }
  if (confidence) { sql += ' AND t.ownership_confidence=?'; args.push(confidence) }
  if (q) { sql += ' AND (t.title LIKE ? OR t.description LIKE ?)'; args.push(`%${q}%`, `%${q}%`) }
  sql += " ORDER BY CASE t.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, t.due_date IS NULL, t.due_date"
  const rows = db.prepare(sql).all(...args)
  res.json(rows.map(hydrate))
})

r.get('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  res.json(hydrate(t))
})

// CREATE
r.post('/', (req, res) => {
  const b = req.body || {}
  if (!b.title) return res.status(400).json({ error: 'title required' })
  const isEmployee = req.user.role === 'employee'
  // An employee's new task is a PRIVATE self-task: owned by them, hidden from the
  // manager until they submit it. Managers/admins create normal, visible tasks.
  const assignee = isEmployee
    ? { id: req.user.id }
    : (b.assignee_id ? db.prepare('SELECT id FROM users WHERE id=? AND org_id=?').get(b.assignee_id, req.user.org_id) : null)
  const visible = isEmployee ? 0 : 1
  const confidence = isEmployee ? 'high' : (b.ownership_confidence || (assignee ? 'high' : 'needs_confirmation'))
  const priority = b.priority || 'Medium'
  // Auto-fill the due date from priority when the caller didn't supply one.
  const dueDate = b.due_date || dueDateForPriority(priority)
  const tid = id('task')
  db.prepare(`INSERT INTO tasks
    (id, org_id, title, description, assignee_id, assigned_by_id, due_date, due_date_raw, priority, status,
     project_id, department_id, meeting_id, ownership_confidence, parent_task_id, progress, approval_status, source_quote,
     assigned_at, visible_to_manager, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    tid, req.user.org_id, b.title, b.description || '', assignee?.id || null, req.user.id,
    dueDate, b.due_date_raw || null, priority, b.status || 'To Do',
    b.project_id || null, b.department_id || req.user.department_id || null, b.meeting_id || null,
    confidence, b.parent_task_id || null,
    0, 'none', b.source_quote || null, assignee ? now() : null, visible, now(), now())
  audit(req.user.org_id, req.user.id, 'task.create', 'task', tid, b.title)
  res.status(201).json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(tid)))
})

// UPDATE (general fields)
r.patch('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const b = req.body || {}
  const fields = ['title', 'description', 'priority', 'due_date', 'due_date_raw', 'project_id', 'department_id', 'progress', 'ownership_confidence']
  const sets = [], args = []
  for (const f of fields) if (f in b) { sets.push(`${f}=?`); args.push(b[f]) }
  let newlyAssigned = null
  if ('assignee_id' in b) {
    sets.push('assignee_id=?'); args.push(b.assignee_id || null)
    sets.push('ownership_confidence=?'); args.push(b.assignee_id ? 'high' : 'needs_confirmation')
    if (b.assignee_id && b.assignee_id !== t.assignee_id) {
      newlyAssigned = b.assignee_id
      sets.push('assigned_at=?'); args.push(now())
    }
  }
  if ('status' in b) {
    if (!VALID_STATUS.includes(b.status)) return res.status(400).json({ error: 'invalid status' })
    sets.push('status=?'); args.push(b.status)
    if (b.status === 'Done') { sets.push('progress=?'); args.push(100); sets.push('completed_at=?'); args.push(now()) }
    if (b.status === 'In Review') { sets.push('submitted_at=?'); args.push(now()) }
  }
  // Auto-fill a due date from priority when assigning or (re)prioritizing a task
  // that has none — unless the caller explicitly set due_date in this request.
  if (!('due_date' in b) && !t.due_date && (newlyAssigned || 'priority' in b)) {
    const effectivePriority = ('priority' in b && b.priority) ? b.priority : t.priority
    sets.push('due_date=?'); args.push(dueDateForPriority(effectivePriority))
  }
  if (!sets.length) return res.json(hydrate(t))
  sets.push('updated_at=?'); args.push(now())
  args.push(t.id)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id=?`).run(...args)
  audit(req.user.org_id, req.user.id, 'task.update', 'task', t.id, b)
  if (newlyAssigned) notify(t.org_id, newlyAssigned, 'task_assigned', `${req.user.name} assigned you "${t.title}"`, t.id)
  res.json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)))
})

// STATUS transitions with workflow semantics
r.post('/:id/status', (req, res) => {
  const { status } = req.body || {}
  if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'invalid status' })
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  let approval = t.approval_status
  let progress = t.progress
  let submittedAt = t.submitted_at
  let completedAt = t.completed_at
  let visible = t.visible_to_manager
  if (status === 'In Review') { approval = 'pending'; submittedAt = now(); visible = 1 } // surface private drafts on submit
  if (status === 'Done') { progress = 100; completedAt = now() }
  if (status === 'Reopened') { approval = 'none'; progress = Math.min(progress, 80); completedAt = null }
  db.prepare('UPDATE tasks SET status=?, approval_status=?, progress=?, submitted_at=?, completed_at=?, visible_to_manager=?, updated_at=? WHERE id=?')
    .run(status, approval, progress, submittedAt, completedAt, visible, now(), t.id)
  audit(req.user.org_id, req.user.id, 'task.status', 'task', t.id, status)
  // Employee submitted work for approval → ping the managers.
  if (status === 'In Review') {
    notifyManagers(t.org_id, 'task_submitted', `${req.user.name} submitted "${t.title}" for approval`, t.id, req.user.id)
  }
  res.json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)))
})

// APPROVAL workflow (managers/admins)
r.post('/:id/approve', requireRole('manager', 'admin'), (req, res) => {
  const { decision } = req.body || {} // approved | rejected
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const approved = decision === 'approved'
  db.prepare('UPDATE tasks SET approval_status=?, status=?, completed_at=?, updated_at=? WHERE id=?')
    .run(approved ? 'approved' : 'rejected', approved ? 'Done' : 'Reopened', approved ? now() : null, now(), t.id)
  audit(req.user.org_id, req.user.id, 'task.approval', 'task', t.id, decision)
  // Tell the assignee the verdict.
  notify(
    t.org_id, t.assignee_id,
    approved ? 'task_approved' : 'task_reopened',
    approved ? `✓ "${t.title}" was approved by ${req.user.name}` : `↩ "${t.title}" needs changes — reopened by ${req.user.name}`,
    t.id,
  )
  res.json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)))
})

// COMMENTS
r.post('/:id/comments', (req, res) => {
  const { body } = req.body || {}
  if (!body) return res.status(400).json({ error: 'body required' })
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const cid = id('cmt')
  db.prepare('INSERT INTO task_comments (id, task_id, user_id, body, created_at) VALUES (?,?,?,?,?)')
    .run(cid, t.id, req.user.id, body, now())
  audit(req.user.org_id, req.user.id, 'task.comment', 'task', t.id)
  // Notify the people involved (assignee + whoever assigned it), except the commenter.
  const snippet = body.length > 80 ? body.slice(0, 77) + '…' : body
  const recipients = new Set([t.assignee_id, t.assigned_by_id].filter(Boolean))
  recipients.delete(req.user.id)
  for (const uid of recipients) {
    notify(t.org_id, uid, 'task_comment', `${req.user.name} commented on "${t.title}": ${snippet}`, t.id)
  }
  res.status(201).json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)))
})

// DEPENDENCIES
r.post('/:id/dependencies', (req, res) => {
  const { depends_on } = req.body || {}
  const t = db.prepare('SELECT id FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  const dep = db.prepare('SELECT id FROM tasks WHERE id=? AND org_id=?').get(depends_on, req.user.org_id)
  if (!t || !dep) return res.status(404).json({ error: 'Not found' })
  if (t.id === dep.id) return res.status(400).json({ error: 'cannot depend on itself' })
  db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?,?)').run(t.id, dep.id)
  res.json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)))
})

// DELETE — managers/admins may delete any task; an employee may delete only their
// own private draft (self-created, not yet submitted to the manager).
r.delete('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const isManager = req.user.role === 'manager' || req.user.role === 'admin'
  const isOwnPrivateDraft = t.assignee_id === req.user.id && t.assigned_by_id === req.user.id && !t.visible_to_manager
  if (!isManager && !isOwnPrivateDraft) {
    return res.status(403).json({ error: 'You can only delete your own tasks before submitting them.' })
  }
  db.prepare('DELETE FROM tasks WHERE id=?').run(t.id)
  audit(req.user.org_id, req.user.id, 'task.delete', 'task', t.id)
  res.json({ ok: true })
})

export default r
