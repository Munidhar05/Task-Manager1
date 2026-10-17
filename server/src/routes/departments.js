import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requireRole } from '../auth.js'
import { id, audit } from '../util.js'

// Departments as a thing of their own: the Administration page's Departments
// tab lists them with who is in each and what work sits with them, and lets a
// manager create, rename and delete. Membership is changed through the user
// routes (PATCH /users/:id department_id), which already carry the rule that
// a manager cannot touch an admin account. Every query is scoped to the
// caller's org.
const r = Router()
r.use(authRequired)

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()
const nameError = (name) => !name ? 'Department name is required.'
  : name.length > 40 ? 'Department name must be 40 characters or fewer.' : null

// Shared with the picker's POST /users/meta/departments, so a department made
// from inside a form and one made on the Departments tab obey the same rules:
// a name that already exists (any case) hands back the existing row rather
// than a twin, so "sales" typed into a box lands on Sales.
export function createDepartment(orgId, actorId, rawName) {
  const name = clean(rawName)
  const error = nameError(name)
  if (error) return { status: 400, error }
  const existing = db.prepare('SELECT * FROM departments WHERE org_id=? AND name=? COLLATE NOCASE').get(orgId, name)
  if (existing) return { status: 200, body: { ...existing, existed: true } }
  const did = id('dep')
  db.prepare('INSERT INTO departments (id, org_id, name) VALUES (?,?,?)').run(did, orgId, name)
  audit(orgId, actorId, 'department.create', 'department', did, name)
  return { status: 201, body: { id: did, org_id: orgId, name } }
}

// "A department's tasks" are the ones tagged with it plus the ones assigned to
// its people: tasks are tagged only when created by someone in a department,
// so most of what a department actually works on is only findable through its
// members. The same visibility rule as the task list applies — a personal task
// is nobody else's business, manager or not.
const TASK_SCOPE = `t.org_id=? AND (t.department_id=? OR a.department_id=?) AND (t.visible_to_manager=1 OR t.assignee_id=?)`

r.get('/', (req, res) => {
  const { org_id: org, id: me } = req.user
  const depts = db.prepare('SELECT id, name FROM departments WHERE org_id=? ORDER BY name COLLATE NOCASE').all(org)
  const members = db.prepare('SELECT count(*) AS n FROM users WHERE department_id=? AND org_id=?')
  const tasks = db.prepare(`SELECT count(*) AS n, sum(CASE WHEN t.status!='Done' THEN 1 ELSE 0 END) AS open
    FROM tasks t LEFT JOIN users a ON a.id=t.assignee_id WHERE ${TASK_SCOPE}`)
  res.json(depts.map((d) => {
    const tk = tasks.get(org, d.id, d.id, me)
    return { id: d.id, name: d.name, members: members.get(d.id, org).n, tasks: tk.n, open_tasks: tk.open || 0 }
  }))
})

r.post('/', requireRole('manager', 'admin'), (req, res) => {
  const out = createDepartment(req.user.org_id, req.user.id, req.body?.name)
  if (out.error) return res.status(out.status).json({ error: out.error })
  res.status(out.status).json(out.body)
})

const find = (req, res) => {
  const d = db.prepare('SELECT * FROM departments WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!d) res.status(404).json({ error: 'Department not found' })
  return d
}

r.patch('/:id', requireRole('manager', 'admin'), (req, res) => {
  const d = find(req, res); if (!d) return
  const name = clean(req.body?.name)
  const error = nameError(name)
  if (error) return res.status(400).json({ error })
  const clash = db.prepare('SELECT id FROM departments WHERE org_id=? AND name=? COLLATE NOCASE AND id!=?').get(req.user.org_id, name, d.id)
  if (clash) return res.status(409).json({ error: `A department called ${name} already exists.` })
  db.prepare('UPDATE departments SET name=? WHERE id=?').run(name, d.id)
  audit(req.user.org_id, req.user.id, 'department.rename', 'department', d.id, `${d.name} → ${name}`)
  res.json({ ...d, name })
})

// Deleting a department keeps its people, tasks, projects and pending invites;
// they are simply left without one. Nothing a department points at is work.
r.delete('/:id', requireRole('manager', 'admin'), (req, res) => {
  const d = find(req, res); if (!d) return
  const org = req.user.org_id
  const unassigned = {}
  db.transaction(() => {
    for (const table of ['users', 'tasks', 'projects', 'invites']) {
      unassigned[table] = db.prepare(`UPDATE ${table} SET department_id=NULL WHERE department_id=? AND org_id=?`).run(d.id, org).changes
    }
    db.prepare('DELETE FROM departments WHERE id=?').run(d.id)
  })()
  audit(org, req.user.id, 'department.delete', 'department', d.id,
    `${d.name}: ${unassigned.users} people, ${unassigned.tasks} tasks, ${unassigned.projects} projects left without a department`)
  res.json({ removed: true, unassigned })
})

r.get('/:id/members', (req, res) => {
  const d = find(req, res); if (!d) return
  res.json(db.prepare('SELECT id, name, email, role, phone, avatar_color, avatar_file FROM users WHERE department_id=? AND org_id=? ORDER BY name').all(d.id, req.user.org_id))
})

r.get('/:id/tasks', (req, res) => {
  const d = find(req, res); if (!d) return
  const rows = db.prepare(`SELECT t.id, t.title, t.status, t.priority, t.due_date, t.assignee_id,
      a.name AS assignee_name, a.avatar_color AS assignee_color,
      CASE WHEN t.department_id=? THEN 'tagged' ELSE 'member' END AS via
    FROM tasks t LEFT JOIN users a ON a.id=t.assignee_id
    WHERE ${TASK_SCOPE}
    ORDER BY CASE WHEN t.status='Done' THEN 1 ELSE 0 END, t.due_date IS NULL, t.due_date, t.created_at DESC`)
    .all(d.id, req.user.org_id, d.id, d.id, req.user.id)
  res.json(rows)
})

export default r
