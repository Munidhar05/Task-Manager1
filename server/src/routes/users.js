import { Router } from 'express'
import multer from 'multer'
import * as XLSX from 'xlsx'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../db.js'
import { authRequired, requireRole, hashPassword, verifyPassword, verifyToken } from '../auth.js'
import { id, now, audit, orgAllowedDomains, emailDomainAllowed } from '../util.js'
import { publicUser } from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AVATAR_DIR = path.join(__dirname, '..', '..', 'data', 'avatars')
fs.mkdirSync(AVATAR_DIR, { recursive: true })

const r = Router()

// Serve a user's profile photo (token via header OR ?token= so <img> can load it).
// Declared before authRequired because <img src> can't send an Authorization header.
r.get('/:id/avatar', (req, res) => {
  const u = (req.headers.authorization || '').startsWith('Bearer ')
    ? verifyToken(req.headers.authorization.slice(7)) : verifyToken(req.query.token)
  if (!u) return res.status(401).json({ error: 'Authentication required' })
  // Tenant isolation: only serve photos of users in the requester's own org, so a
  // token from one company can't fetch another company's avatars by guessing ids.
  const target = db.prepare('SELECT avatar_file FROM users WHERE id=? AND org_id=?').get(req.params.id, u.org_id)
  if (!target?.avatar_file) return res.status(404).json({ error: 'No avatar' })
  const abs = path.join(AVATAR_DIR, target.avatar_file)
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Missing' })
  const ext = path.extname(target.avatar_file); if (ext) res.type(ext)
  res.setHeader('Cache-Control', 'private, max-age=300')
  fs.createReadStream(abs).pipe(res)
})

r.use(authRequired)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

// Upload / replace my own profile photo (images only).
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATAR_DIR),
    filename: (req, file, cb) => cb(null, id('av') + path.extname(file.originalname || '.png').slice(0, 8)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, (file.mimetype || '').startsWith('image/')),
})
r.post('/me/avatar', avatarUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'An image file is required' })
  const old = db.prepare('SELECT avatar_file FROM users WHERE id=?').get(req.user.id)?.avatar_file
  db.prepare('UPDATE users SET avatar_file=? WHERE id=?').run(req.file.filename, req.user.id)
  if (old) try { fs.unlinkSync(path.join(AVATAR_DIR, old)) } catch {}
  res.json({ ok: true, avatar_file: req.file.filename })
})

// SELF-SERVICE: any signed-in user can update their OWN profile — name, preferred
// language, and password. Changing the password requires the current one. This is
// separate from the admin-only PATCH /:id below, and must be declared before it so
// "/me" isn't captured as an :id.
r.patch('/me', (req, res) => {
  const b = req.body || {}
  const sets = [], args = []
  if ('name' in b) {
    const name = String(b.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Name cannot be empty.' })
    sets.push('name=?'); args.push(name)
  }
  if ('preferred_language' in b) { sets.push('preferred_language=?'); args.push(b.preferred_language || 'en') }
  if (b.new_password) {
    if (String(b.new_password).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' })
    const me = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id)
    if (!verifyPassword(String(b.current_password || ''), me.password_hash)) {
      return res.status(400).json({ error: 'Your current password is incorrect.' })
    }
    sets.push('password_hash=?'); args.push(hashPassword(b.new_password))
  }
  if (!sets.length) return res.json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)))
  args.push(req.user.id)
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).run(...args)
  const changed = Object.keys(b).filter((k) => k !== 'current_password' && k !== 'new_password')
  if (b.new_password) changed.push('password')
  audit(req.user.org_id, req.user.id, 'user.self_update', 'user', req.user.id, changed.join(', '))
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)))
})

// Email must be a valid format; the ALLOWED DOMAIN is now per-org (configurable),
// not hardcoded — so every organization enforces its own domains.
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const onlyDigits = (s) => String(s || '').replace(/\D/g, '')
// Returns an error string if the email's domain isn't allowed for the org, else null.
function domainError(orgId, email) {
  if (emailDomainAllowed(orgId, email)) return null
  const allowed = orgAllowedDomains(orgId)
  return `Email domain not allowed. This organization permits: ${allowed.join(', ')}`
}

// Everyone can list org users (needed for assignment dropdowns) — minimal fields.
r.get('/', (req, res) => {
  const rows = db.prepare('SELECT id, name, email, role, phone, department_id, avatar_color, avatar_file, aliases, preferred_language FROM users WHERE org_id=? ORDER BY name').all(req.user.org_id)
  res.json(rows)
})

// Create user (admins, and managers for non-admin accounts)
r.post('/', requireRole('manager', 'admin'), (req, res) => {
  const { name, email, password, role, department_id, aliases, preferred_language, phone } = req.body || {}
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'name, email, password, role required' })
  if (!['admin', 'manager', 'employee'].includes(role)) return res.status(400).json({ error: 'invalid role' })
  if (req.user.role === 'manager' && role === 'admin') return res.status(403).json({ error: 'Managers cannot create admin accounts' })
  const emailNorm = String(email).toLowerCase().trim()
  if (!VALID_EMAIL.test(emailNorm)) return res.status(400).json({ error: 'Please enter a valid email address.' })
  const domErr = domainError(req.user.org_id, emailNorm)
  if (domErr) return res.status(400).json({ error: domErr })
  const phoneDigits = onlyDigits(phone)
  if (phoneDigits.length !== 10) return res.status(400).json({ error: 'Phone must be exactly 10 digits' })
  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(emailNorm)
  if (exists) return res.status(409).json({ error: 'email already exists' })
  const uid = id('usr')
  const colors = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4']
  db.prepare(`INSERT INTO users (id, org_id, department_id, name, email, password_hash, role, phone, aliases, preferred_language, avatar_color, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    uid, req.user.org_id, department_id || null, name, emailNorm, hashPassword(password), role,
    phoneDigits, aliases || '', preferred_language || 'en', colors[Math.floor(Math.random() * colors.length)], now())
  audit(req.user.org_id, req.user.id, 'user.create', 'user', uid, email)
  res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(uid)))
})

// Update user (admins, and managers for non-admin accounts)
r.patch('/:id', requireRole('manager', 'admin'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!u) return res.status(404).json({ error: 'Not found' })
  const b = req.body || {}
  if (req.user.role === 'manager' && (u.role === 'admin' || b.role === 'admin')) {
    return res.status(403).json({ error: 'Managers cannot modify admin accounts' })
  }
  if ('email' in b && b.email) {
    const e = String(b.email).toLowerCase().trim()
    if (!VALID_EMAIL.test(e)) return res.status(400).json({ error: 'Please enter a valid email address.' })
    const domErr = domainError(req.user.org_id, e)
    if (domErr) return res.status(400).json({ error: domErr })
  }
  if ('phone' in b) {
    b.phone = onlyDigits(b.phone)
    if (b.phone.length !== 10) return res.status(400).json({ error: 'Phone must be exactly 10 digits' })
  }
  const fields = ['name', 'role', 'department_id', 'aliases', 'preferred_language', 'phone']
  const sets = [], args = []
  for (const f of fields) if (f in b) { sets.push(`${f}=?`); args.push(b[f]) }
  if ('email' in b && b.email) {
    const email = b.email.toLowerCase().trim()
    const clash = db.prepare('SELECT id FROM users WHERE email=? AND id!=?').get(email, u.id)
    if (clash) return res.status(409).json({ error: 'email already in use' })
    sets.push('email=?'); args.push(email)
  }
  if (b.password) { sets.push('password_hash=?'); args.push(hashPassword(b.password)) }
  if (!sets.length) return res.json(publicUser(u))
  args.push(u.id)
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).run(...args)
  audit(req.user.org_id, req.user.id, 'user.update', 'user', u.id, b)
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)))
})

// DELETE a user (managers/admins). Detaches references so the row can be removed
// cleanly, then deletes. A manager cannot delete their own account or an admin.
r.delete('/:id', requireRole('manager', 'admin'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!u) return res.status(404).json({ error: 'Not found' })
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account' })
  if (req.user.role === 'manager' && u.role === 'admin') return res.status(403).json({ error: 'Managers cannot remove admin accounts' })
  const remove = db.transaction(() => {
    db.prepare('UPDATE tasks SET assignee_id=NULL WHERE assignee_id=?').run(u.id)   // unassign their tasks
    db.prepare('UPDATE suggested_tasks SET suggested_assignee_id=NULL WHERE suggested_assignee_id=?').run(u.id) // detach from AI review queue
    db.prepare('DELETE FROM task_comments WHERE user_id=?').run(u.id)               // their comments
    db.prepare('DELETE FROM users WHERE id=?').run(u.id)                            // notifications cascade
  })
  remove()
  audit(req.user.org_id, req.user.id, 'user.delete', 'user', u.id, u.email)
  res.json({ ok: true })
})

// BULK IMPORT users from an Excel/CSV file (admin). Upserts by email.
// Expected columns (case-insensitive): name, email, role, department, aliases, language, password
r.post('/import', requireRole('manager', 'admin'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required (field "file")' })
  let rows
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  } catch (e) {
    return res.status(400).json({ error: 'Could not parse file: ' + e.message })
  }

  const org = req.user.org_id
  const depts = db.prepare('SELECT id, name FROM departments WHERE org_id=?').all(org)
  const deptByName = (nm) => depts.find((d) => d.name.toLowerCase() === String(nm || '').toLowerCase())?.id || null
  const colors = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4']
  // case-insensitive field getter
  const pick = (row, ...keys) => {
    for (const k of Object.keys(row)) if (keys.includes(k.toLowerCase().trim())) return row[k]
    return ''
  }

  let created = 0, updated = 0
  const errors = []
  const apply = db.transaction(() => {
    rows.forEach((row, i) => {
      const name = String(pick(row, 'name', 'full name') || '').trim()
      const email = String(pick(row, 'email', 'email id', 'mail', 'mail id') || '').toLowerCase().trim()
      if (!name || !email) { errors.push(`Row ${i + 2}: missing name or email`); return }
      if (!VALID_EMAIL.test(email)) { errors.push(`Row ${i + 2}: invalid email ${email}`); return }
      if (!emailDomainAllowed(req.user.org_id, email)) { errors.push(`Row ${i + 2}: domain not allowed for ${email}`); return }
      let role = String(pick(row, 'role') || 'employee').toLowerCase().trim()
      if (!['admin', 'manager', 'employee'].includes(role)) role = 'employee'
      if (req.user.role === 'manager' && role === 'admin') role = 'employee' // managers can't grant admin
      const aliases = String(pick(row, 'aliases', 'alias') || '').trim()
      const lang = String(pick(row, 'language', 'preferred_language', 'lang') || 'en').trim() || 'en'
      const phone = String(pick(row, 'phone', 'phone number', 'mobile', 'contact') || '').trim()
      const deptId = deptByName(pick(row, 'department', 'dept'))
      const password = String(pick(row, 'password') || '').trim()

      const existing = db.prepare('SELECT id, role FROM users WHERE email=?').get(email)
      if (existing && req.user.role === 'manager' && existing.role === 'admin') {
        errors.push(`Row ${i + 2}: skipped admin account ${email}`); return // managers can't edit admins
      }
      if (existing) {
        const sets = ['name=?', 'role=?', 'aliases=?', 'preferred_language=?', 'department_id=?', 'phone=?']
        const args = [name, role, aliases, lang, deptId, phone]
        if (password) { sets.push('password_hash=?'); args.push(hashPassword(password)) }
        args.push(existing.id)
        db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).run(...args)
        updated++
      } else {
        db.prepare(`INSERT INTO users (id, org_id, department_id, name, email, password_hash, role, phone, aliases, preferred_language, avatar_color, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id('usr'), org, deptId, name, email, hashPassword(password || 'password123'), role, phone, aliases, lang,
          colors[Math.floor(Math.random() * colors.length)], now())
        created++
      }
    })
  })
  try { apply() } catch (e) { return res.status(500).json({ error: e.message }) }
  audit(org, req.user.id, 'user.import', 'user', null, `created=${created}, updated=${updated}`)
  res.json({ created, updated, errors, rows: rows.length })
})

// Departments & projects (read for dropdowns)
r.get('/meta/departments', (req, res) => {
  res.json(db.prepare('SELECT * FROM departments WHERE org_id=? ORDER BY name').all(req.user.org_id))
})
r.get('/meta/projects', (req, res) => {
  res.json(db.prepare('SELECT * FROM projects WHERE org_id=? ORDER BY name').all(req.user.org_id))
})

// Org settings — allowed email domains. GET for anyone in the org; PATCH for admins.
r.get('/meta/org', (req, res) => {
  const org = db.prepare('SELECT id, name, is_personal FROM organizations WHERE id=?').get(req.user.org_id)
  res.json({ ...org, allowed_domains: orgAllowedDomains(req.user.org_id) })
})
r.patch('/meta/org', requireRole('manager', 'admin'), (req, res) => {
  const list = Array.isArray(req.body?.allowed_domains) ? req.body.allowed_domains : []
  // Keep valid, unique, lowercase domains (e.g. befach.com). Empty list = no restriction.
  const clean = [...new Set(list.map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))]
  db.prepare('UPDATE organizations SET allowed_domains=? WHERE id=?').run(clean.join(',') || null, req.user.org_id)
  audit(req.user.org_id, req.user.id, 'org.domains_update', 'organization', req.user.org_id, clean.join(', '))
  res.json({ allowed_domains: clean })
})

export default r
