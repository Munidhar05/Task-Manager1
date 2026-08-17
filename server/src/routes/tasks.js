import { Router } from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../db.js'
import { authRequired, verifyToken } from '../auth.js'
import { id, now, audit, notify, notifyManagers, dueDateForPriority } from '../util.js'
import { resolveUser } from '../ai/extractor.js'
import { indexTask, removeEmbedding } from '../ai/ragIndex.js'
import { parseSpokenTask, hasLLM } from '../ai/voiceTask.js'
import { interpretVoiceSearch } from '../ai/voiceSearch.js'
import { resolveCategory, normalizeCategory } from '../categories.js'
import { recordUsage } from '../ai/usage.js'

// The configured speech-to-text provider, for usage attribution.
const STT_PROVIDER = (process.env.TRANSCRIPTION_PROVIDER || 'sarvam').toLowerCase()
import { parseDueDate } from '../ai/dates.js'
import { transcribeAudio } from '../ai/transcribe.js'

const r = Router()

// --- Task attachments (reference images / PDFs / videos) ---------------------
// Files live on disk in data/task_uploads; the DB row carries the metadata. We
// follow the chat-file model: an authenticated streaming route (below) serves
// them, so nothing under data/ is ever exposed via static middleware.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ATTACH_DIR = path.join(__dirname, '..', '..', 'data', 'task_uploads')
fs.mkdirSync(ATTACH_DIR, { recursive: true })
const ATTACH_MAX = Number(process.env.TASK_ATTACH_MAX_MB || 50) * 1024 * 1024
// Only reference material makes sense here: images, PDFs, and videos.
const ATTACH_OK = (mime) => /^(image\/|video\/)/.test(mime) || mime === 'application/pdf'
const attachUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ATTACH_DIR),
    filename: (req, file, cb) => cb(null, id('att') + path.extname(file.originalname || '').slice(0, 12)),
  }),
  limits: { fileSize: ATTACH_MAX },
  fileFilter: (req, file, cb) => cb(null, ATTACH_OK(file.mimetype || '')),
})

// SERVE / DOWNLOAD an attachment. Declared BEFORE authRequired so <img>/<video>
// tags (which can't send an Authorization header) can authenticate via ?token=.
// Enforces that the viewer is in the SAME org as the task the file belongs to.
r.get('/attachments/:attId/file', (req, res) => {
  const user = (req.headers.authorization || '').startsWith('Bearer ')
    ? verifyToken(req.headers.authorization.slice(7))
    : verifyToken(req.query.token)
  if (!user) return res.status(401).json({ error: 'Authentication required' })
  const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.attId)
  if (!a || !a.stored_name) return res.status(404).json({ error: 'Not found' })
  // Org check (org_id was backfilled onto newer rows; fall back to the task's org).
  const taskOrg = a.org_id || db.prepare('SELECT org_id FROM tasks WHERE id=?').get(a.task_id)?.org_id
  if (taskOrg && taskOrg !== user.org_id) return res.status(403).json({ error: 'Out of organization' })
  const abs = path.join(ATTACH_DIR, a.stored_name)
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File missing' })
  if (a.file_type) res.type(a.file_type)
  const dl = req.query.download === '1' ? 'attachment' : 'inline'
  res.setHeader('Content-Disposition', `${dl}; filename="${encodeURIComponent(a.filename || 'file')}"`)
  res.setHeader('Cache-Control', 'private, max-age=300')
  fs.createReadStream(abs).pipe(res)
})

r.use(authRequired)

// Voice dictation for the "Speak" button records ONE short audio clip (≤ ~30s)
// per task, so a 10 MB cap is plenty and keeps abuse small.
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

const VALID_STATUS = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened']

const userBrief = (uid) => (uid ? db.prepare('SELECT id,name,avatar_color FROM users WHERE id=?').get(uid) : null)

// How this task came to its current owner, so the UI can label it:
//   split       — it is one part of a task somebody divided up
//   reassigned  — it was moved off a previous owner
//   assigned    — somebody else handed it over directly
//   self        — the owner created it for themselves (no hand-off to show)
function taskOrigin(t) {
  if (t.parent_task_id) return 'split'
  if (t.reassigned_at) return 'reassigned'
  if (t.assigned_by_id && t.assignee_id && t.assigned_by_id !== t.assignee_id) return 'assigned'
  return 'self'
}

// A task the user raised for themselves: they own both ends of it, so finishing
// or binning it is their call alone — no manager sign-off. Deliberately stricter
// than taskOrigin()'s 'self', which also covers unassigned tasks and would hand
// an employee rights over work nobody owns yet. Split parts and tasks reassigned
// onto someone come out of another person's plan, so they keep the approval flow
// even when the ids happen to line up.
function isOwnSelfCreated(t, userId) {
  return !!userId && !t.parent_task_id && !t.reassigned_at &&
    !!t.assignee_id && t.assignee_id === userId && t.assigned_by_id === userId
}

function hydrate(t) {
  if (!t) return t
  const assignee = t.assignee_id ? db.prepare('SELECT id,name,avatar_color,role FROM users WHERE id=?').get(t.assignee_id) : null
  const assignedBy = userBrief(t.assigned_by_id)
  const reassignedBy = userBrief(t.reassigned_by_id)
  const previousAssignee = userBrief(t.previous_assignee_id)
  const project = t.project_id ? db.prepare('SELECT id,name FROM projects WHERE id=?').get(t.project_id) : null
  const subtasks = db.prepare('SELECT * FROM tasks WHERE parent_task_id=? ORDER BY created_at').all(t.id)
  // A split part needs to name its parent — it's shown out of context in lists
  // and dashboards now, where "part of X" is the only thing that makes it read.
  const parent = t.parent_task_id
    ? db.prepare('SELECT id,title,assignee_id FROM tasks WHERE id=?').get(t.parent_task_id)
    : null
  const comments = db.prepare(`SELECT c.*, u.name AS user_name, u.avatar_color FROM task_comments c JOIN users u ON u.id=c.user_id WHERE c.task_id=? ORDER BY c.created_at`).all(t.id)
  const deps = db.prepare(`SELECT d.depends_on_task_id AS id, t2.title, t2.status FROM task_dependencies d JOIN tasks t2 ON t2.id=d.depends_on_task_id WHERE d.task_id=?`).all(t.id)
  const attachments = db.prepare('SELECT * FROM attachments WHERE task_id=?').all(t.id)
  return {
    ...t, assignee, assignedBy, reassignedBy, previousAssignee, parent, project,
    subtasks, comments, dependencies: deps, attachments,
    origin: taskOrigin(t),
    is_split_parent: subtasks.length > 0,
  }
}

// Roll a split parent's status up from its children: once every shared part is
// Done the parent auto-completes; if a part is later reopened, the parent reopens
// too — so the owner stays accountable and the roll-up stays honest.
function syncParentStatus(parentId) {
  if (!parentId) return
  const parent = db.prepare('SELECT * FROM tasks WHERE id=?').get(parentId)
  if (!parent) return
  const kids = db.prepare('SELECT status FROM tasks WHERE parent_task_id=?').all(parentId)
  if (!kids.length) return
  const allDone = kids.every((k) => k.status === 'Done')
  if (allDone && parent.status !== 'Done') {
    db.prepare('UPDATE tasks SET status=?, progress=100, completed_at=?, updated_at=? WHERE id=?')
      .run('Done', now(), now(), parentId)
    notify(parent.org_id, parent.assignee_id, 'task_approved', `All parts of "${parent.title}" are done — task completed`, parentId)
    indexTask(parentId)
  } else if (!allDone && parent.status === 'Done') {
    db.prepare('UPDATE tasks SET status=?, progress=?, completed_at=NULL, updated_at=? WHERE id=?')
      .run('Reopened', Math.min(parent.progress ?? 0, 80), now(), parentId)
    indexTask(parentId)
  }
}

// LIST with filters: ?status=&priority=&assignee=&project=&meeting=&mine=1&q=
r.get('/', (req, res) => {
  const { status, priority, assignee, project, meeting, mine, q, confidence, assigned_by_me } = req.query
  // NOTE: split parts (rows with a parent_task_id) used to be excluded here. That
  // made them unreachable — the assignee got a notification for a task that
  // appeared in no list, and couldn't open the parent either since it wasn't
  // theirs. Parts are ordinary tasks to the person doing them, so they're listed
  // like any other and carry a "Part of X" badge for context.
  let sql = `SELECT t.* FROM tasks t WHERE t.org_id=?`
  const args = [req.user.org_id]
  if (assigned_by_me) {
    // Work I handed to someone else — lets the dashboard's "Assigned by me"
    // section link through to the full list. This REPLACES the usual visibility
    // clause rather than adding to it: an employee's is `assignee_id = me`, which
    // can never also be `!= me`. Safe, because being the assigner (or the person
    // who moved it) is itself the grounds for seeing it.
    sql += ' AND t.assignee_id IS NOT NULL AND t.assignee_id != ? AND (t.assigned_by_id=? OR t.reassigned_by_id=?)'
    args.push(req.user.id, req.user.id, req.user.id)
  } else if (req.user.role === 'employee') {
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
  // Match the query against the title, description, OR the assignee's name — so
  // searching (or saying) a person's name surfaces all of their tasks.
  if (q) {
    sql += ' AND (t.title LIKE ? OR t.description LIKE ? OR t.assignee_id IN (SELECT id FROM users WHERE org_id=? AND name LIKE ?))'
    args.push(`%${q}%`, `%${q}%`, req.user.org_id, `%${q}%`)
  }
  sql += " ORDER BY CASE t.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, t.due_date IS NULL, t.due_date"
  const rows = db.prepare(sql).all(...args)
  res.json(rows.map(hydrate))
})

r.get('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  res.json(hydrate(t))
})

// TRANSCRIBE a single dictated audio clip -> text. Powers the "Speak" button on
// the New Task modal for EVERYONE (employees included) — unlike the meetings
// transcriber, which is manager/admin only. Uses the same Sarvam/Whisper pipeline,
// which is far more reliable on Android and for Telugu/Hindi/English code-mixing
// than the browser's SpeechRecognition.
r.post('/transcribe', audioUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required (field "audio")' })
  try {
    const { text, language } = await transcribeAudio(
      req.file.buffer,
      req.file.originalname || 'task.webm',
      req.file.mimetype || 'audio/webm',
    )
    recordUsage({ orgId: req.user.org_id, userId: req.user.id, provider: STT_PROVIDER, feature: 'transcription' })
    res.json({ text: text || '', language: language || null })
  } catch (err) {
    console.error('[tasks] transcribe failed:', err.message)
    res.status(err.code === 'NO_PROVIDER' ? 400 : 502).json({ error: err.message, code: err.code || null })
  }
})

// VOICE SEARCH: transcribe a spoken query (any language), translate it to English,
// and split it into structured filters the list endpoint understands. Saying a
// person's name returns ALL of that employee's tasks; topic words search title/desc.
r.post('/voice-search', audioUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required (field "audio")' })
  try {
    const { text } = await transcribeAudio(
      req.file.buffer,
      req.file.originalname || 'search.webm',
      req.file.mimetype || 'audio/webm',
    )
    recordUsage({ orgId: req.user.org_id, userId: req.user.id, provider: STT_PROVIDER, feature: 'transcription' })
    const transcript = String(text || '').trim()
    // Default (no LLM / interpret failed): fall back to the raw transcript as the query.
    let interp = { query: transcript, person: null, status: null, priority: null }
    if (transcript && hasLLM()) {
      try {
        const users = db.prepare("SELECT id, name, role, aliases FROM users WHERE org_id=? AND role != 'admin'").all(req.user.org_id)
        interp = await interpretVoiceSearch(transcript, {
          users,
          onUsage: (u) => recordUsage({ orgId: req.user.org_id, userId: req.user.id, feature: 'voice_search', ...u }),
        })
      } catch (e) { console.warn('[tasks] voice-search interpret failed, using transcript:', e.message) }
    }
    // Resolve a named person to an assignee id (handles aliases / first-name-only).
    let assignee_id = null, assignee_name = null
    if (interp.person) {
      const u = resolveUser(req.user.org_id, interp.person)
      if (u) { assignee_id = u.id; assignee_name = u.name }
    }
    res.json({
      transcript,
      // When we matched a person but found no topic words, leave query empty so the
      // assignee filter alone returns every task for that employee.
      query: interp.query || (assignee_id ? '' : transcript),
      assignee_id,
      assignee_name,
      status: interp.status || null,
      priority: interp.priority || null,
    })
  } catch (err) {
    console.error('[tasks] voice-search failed:', err.message)
    res.status(err.code === 'NO_PROVIDER' ? 400 : 502).json({ error: err.message, code: err.code || null })
  }
})

// PARSE a dictated sentence into draft task fields (title/description/assignee/
// priority). Used by the "Speak" button on the New Task modal. Falls back to
// using the raw transcript as the title when no LLM is configured or the call
// fails, so voice always produces *something*.
r.post('/parse-voice', async (req, res) => {
  const transcript = String(req.body?.transcript || '').trim()
  if (!transcript) return res.status(400).json({ error: 'transcript required' })

  const fallback = () => res.json({
    title: transcript, description: '', assignee_id: null, assignee_name: null,
    priority: 'Medium', due_date_raw: null, engine: 'none',
  })

  if (!hasLLM()) return fallback()
  try {
    const users = db.prepare("SELECT id, name, role, aliases FROM users WHERE org_id=? AND role != 'admin'").all(req.user.org_id)
    const parsed = await parseSpokenTask(transcript, {
      users,
      onUsage: (u) => recordUsage({ orgId: req.user.org_id, userId: req.user.id, feature: 'voice_task', ...u }),
    })
    // Resolve the spoken name to a real org user (null if no confident match).
    const match = parsed.assignee_name ? resolveUser(req.user.org_id, parsed.assignee_name) : null
    // Resolve a spoken deadline ("by Friday", "tomorrow", "repu", "kal") to an
    // absolute YYYY-MM-DD, anchored to today. Try the AI's extracted phrase first,
    // then fall back to scanning the whole transcript.
    const today = new Date().toISOString().slice(0, 10)
    const due = parseDueDate(parsed.due_date_raw || '', today).date || parseDueDate(transcript, today).date
    res.json({
      title: parsed.title,
      description: parsed.description,
      assignee_id: match?.id || null,
      assignee_name: match?.name || parsed.assignee_name || null,
      priority: parsed.priority,
      due_date: due || null,
      due_date_raw: parsed.due_date_raw,
      engine: 'llm',
    })
  } catch (err) {
    console.warn('[tasks] voice parse failed, using raw transcript:', err.message)
    fallback()
  }
})

// CREATE
r.post('/', (req, res) => {
  const b = req.body || {}
  if (!b.title) return res.status(400).json({ error: 'title required' })
  // A personal task (b.personal — a private to-do / My Tasks) is owned by the
  // creator and hidden from everyone else. Otherwise ANYONE may assign the task
  // to ANYONE in the org (employee→employee, employee→manager, …) or leave it
  // unassigned.
  const personal = !!b.personal
  const assignee = personal
    ? { id: req.user.id }
    : (b.assignee_id ? db.prepare('SELECT id FROM users WHERE id=? AND org_id=?').get(b.assignee_id, req.user.org_id) : null)
  const visible = personal ? 0 : 1
  const confidence = personal ? 'high' : (b.ownership_confidence || (assignee ? 'high' : 'needs_confirmation'))
  const priority = b.priority || 'Medium'
  // Auto-fill the due date from priority when the caller didn't supply one.
  const dueDate = b.due_date || dueDateForPriority(priority)
  // Category: an explicit choice wins, else auto-detect from the task's text.
  const category = resolveCategory({ text: `${b.title} ${b.description || ''} ${b.source_quote || ''}`, explicit: b.category })
  const tid = id('task')
  db.prepare(`INSERT INTO tasks
    (id, org_id, title, description, assignee_id, assigned_by_id, due_date, due_date_raw, priority, status,
     project_id, department_id, meeting_id, ownership_confidence, parent_task_id, progress, approval_status, source_quote,
     category, assigned_at, visible_to_manager, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    tid, req.user.org_id, b.title, b.description || '', assignee?.id || null, req.user.id,
    dueDate, b.due_date_raw || null, priority, b.status || 'To Do',
    b.project_id || null, b.department_id || req.user.department_id || null, b.meeting_id || null,
    confidence, b.parent_task_id || null,
    0, 'none', b.source_quote || null, category, assignee ? now() : null, visible, now(), now())
  audit(req.user.org_id, req.user.id, 'task.create', 'task', tid, b.title)
  // Notify the assignee when someone assigns them a task (not their own).
  if (assignee && assignee.id !== req.user.id) {
    notify(req.user.org_id, assignee.id, 'task_assigned', `${req.user.name} assigned you "${b.title}"`, tid)
  }
  indexTask(tid) // fire-and-forget RAG indexing
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
  // Category override: normalise to a known label, or null to clear (Uncategorized).
  if ('category' in b) { sets.push('category=?'); args.push(normalizeCategory(b.category)) }
  let newlyAssigned = null
  let takenFrom = null
  if ('assignee_id' in b) {
    sets.push('assignee_id=?'); args.push(b.assignee_id || null)
    sets.push('ownership_confidence=?'); args.push(b.assignee_id ? 'high' : 'needs_confirmation')
    if (b.assignee_id && b.assignee_id !== t.assignee_id) {
      newlyAssigned = b.assignee_id
      sets.push('assigned_at=?'); args.push(now())
      // Moving a task OFF someone is a reassignment, not a fresh assignment.
      // Record it: the row is overwritten in place, so this is the only trace
      // that the task ever belonged to anyone else.
      if (t.assignee_id) {
        takenFrom = t.assignee_id
        sets.push('reassigned_at=?'); args.push(now())
        sets.push('reassigned_by_id=?'); args.push(req.user.id)
        sets.push('previous_assignee_id=?'); args.push(t.assignee_id)
      }
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
  // Reassignment gets its own audit action so it can be told apart from an
  // ordinary field edit — 'task.update' is excluded from the activity feed.
  audit(req.user.org_id, req.user.id, takenFrom ? 'task.reassign' : 'task.update', 'task', t.id, b)
  if (newlyAssigned) notify(t.org_id, newlyAssigned, 'task_assigned', `${req.user.name} assigned you "${t.title}"`, t.id)
  // Tell whoever lost the task. Without this it simply disappears from their
  // dashboard with no explanation.
  if (takenFrom && takenFrom !== req.user.id) {
    notify(t.org_id, takenFrom, 'task_reassigned', `${req.user.name} reassigned "${t.title}" to someone else`, t.id)
  }
  if (t.parent_task_id && 'status' in b) syncParentStatus(t.parent_task_id)
  indexTask(t.id) // re-index on edit (title/desc/assignee/status may have changed)
  res.json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)))
})

// STATUS transitions with workflow semantics
r.post('/:id/status', (req, res) => {
  let { status } = req.body || {} // may be rewritten below for own self-created work
  if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'invalid status' })
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  let approval = t.approval_status
  let progress = t.progress
  let submittedAt = t.submitted_at
  let completedAt = t.completed_at
  let visible = t.visible_to_manager
  // Your own self-created task has no approver, so it never enters the approval
  // flow: completing it is final, and a stray "submit for review" just marks it
  // done rather than parking it in a queue nobody is watching.
  const ownWork = isOwnSelfCreated(t, req.user.id)
  if (ownWork && status === 'In Review') status = 'Done'
  if (status === 'In Review') { approval = 'pending'; submittedAt = now(); visible = 1 } // surface private drafts on submit
  if (status === 'Done') { progress = 100; completedAt = now(); if (ownWork) approval = 'none' }
  if (status === 'Reopened') { approval = 'none'; progress = Math.min(progress, 80); completedAt = null }
  db.prepare('UPDATE tasks SET status=?, approval_status=?, progress=?, submitted_at=?, completed_at=?, visible_to_manager=?, updated_at=? WHERE id=?')
    .run(status, approval, progress, submittedAt, completedAt, visible, now(), t.id)
  audit(req.user.org_id, req.user.id, 'task.status', 'task', t.id, status)
  // Employee submitted work for approval → ping the managers, and the assigner
  // (who can now approve it too — e.g. the colleague who split this part off).
  // Managers were all covered by the first call, so only an EMPLOYEE assigner
  // needs the extra ping; anyone else would be notified twice.
  if (status === 'In Review') {
    notifyManagers(t.org_id, 'task_submitted', `${req.user.name} submitted "${t.title}" for approval`, t.id, req.user.id)
    if (t.assigned_by_id && t.assigned_by_id !== req.user.id) {
      const assigner = db.prepare('SELECT role FROM users WHERE id=?').get(t.assigned_by_id)
      if (assigner?.role === 'employee') {
        notify(t.org_id, t.assigned_by_id, 'task_submitted', `${req.user.name} submitted "${t.title}" for your approval`, t.id)
      }
    }
  }
  if (t.parent_task_id) syncParentStatus(t.parent_task_id) // a shared part changed → re-roll the parent
  indexTask(t.id) // status change updates the embedded metadata
  res.json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)))
})

// SPLIT — the task owner (or a manager) distributes parts of a task to peers as
// child tasks. Each part becomes a visible subtask assigned to a colleague, who
// is notified. The split always surfaces the parent to managers (visibility).
r.post('/:id/split', (req, res) => {
  const parent = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!parent) return res.status(404).json({ error: 'Not found' })
  const isManager = req.user.role === 'manager' || req.user.role === 'admin'
  if (!isManager && parent.assignee_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the task owner can split this task.' })
  }
  if (parent.parent_task_id) return res.status(400).json({ error: 'A shared part cannot be split again.' })

  const parts = (Array.isArray(req.body?.parts) ? req.body.parts : [])
    .map((p) => ({ title: String(p?.title || '').trim(), assignee_id: p?.assignee_id || null }))
    .filter((p) => p.title && p.assignee_id)
  if (!parts.length) return res.status(400).json({ error: 'Add at least one part with a title and a person.' })

  for (const p of parts) {
    const assignee = db.prepare('SELECT id, name FROM users WHERE id=? AND org_id=?').get(p.assignee_id, req.user.org_id)
    if (!assignee) continue
    const cid = id('task')
    // Inherit the parent's category unless the part's own title points elsewhere.
    const childCategory = resolveCategory({ text: p.title, aiSuggested: parent.category })
    db.prepare(`INSERT INTO tasks
      (id, org_id, title, description, assignee_id, assigned_by_id, due_date, due_date_raw, priority, status,
       project_id, department_id, meeting_id, ownership_confidence, parent_task_id, progress, approval_status, source_quote,
       category, assigned_at, visible_to_manager, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      cid, parent.org_id, p.title, '', assignee.id, req.user.id,
      parent.due_date, parent.due_date_raw, parent.priority, 'To Do',
      parent.project_id, parent.department_id, parent.meeting_id,
      'high', parent.id, 0, 'none', null, childCategory, now(), 1, now(), now())
    audit(parent.org_id, req.user.id, 'task.split', 'task', cid, p.title)
    indexTask(cid)
    if (assignee.id !== req.user.id) {
      notify(parent.org_id, assignee.id, 'task_assigned', `${req.user.name} shared a part of "${parent.title}" with you: ${p.title}`, cid)
    }
  }
  // Splitting makes the parent (and its parts) visible to managers for oversight.
  if (!parent.visible_to_manager) {
    db.prepare('UPDATE tasks SET visible_to_manager=1, updated_at=? WHERE id=?').run(now(), parent.id)
    indexTask(parent.id)
  }
  res.status(201).json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(parent.id)))
})

// APPROVAL workflow — managers/admins, or the task's own assigner. The assigner
// check is per-task, not a role grant: an employee who assigned (or split a part
// to) a colleague decides only that work, nothing else. Assigner==assignee is
// excluded — self-created work never enters the approval flow anyway (see
// isOwnSelfCreated), so that combination reaching here means someone else
// submitted it and a real reviewer is required.
r.post('/:id/approve', (req, res) => {
  const { decision } = req.body || {} // approved | rejected
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const isManager = req.user.role === 'manager' || req.user.role === 'admin'
  const isAssigner = !!t.assigned_by_id && t.assigned_by_id === req.user.id && t.assignee_id !== req.user.id
  if (!isManager && !isAssigner) {
    return res.status(403).json({ error: 'Only a manager or the person who assigned this task can approve it.' })
  }
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
  // Approving a shared part is how a split normally completes now, so the parent
  // must re-roll here just like on a direct status change — without this the
  // last part's approval left the parent container open forever.
  if (t.parent_task_id) syncParentStatus(t.parent_task_id)
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

// ATTACHMENTS — upload a reference image / PDF / video onto a task. One file per
// request (the client loops for multiple). Anyone in the task's org may attach.
const runAttachUpload = (req, res, next) => attachUpload.single('file')(req, res, (err) => {
  if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
    .json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${Math.round(ATTACH_MAX / 1024 / 1024)} MB)` : 'Upload failed' })
  next()
})
r.post('/:id/attachments', runAttachUpload, (req, res) => {
  const cleanup = () => { if (req.file) try { fs.unlinkSync(req.file.path) } catch {} }
  if (!req.file) return res.status(400).json({ error: 'Only images, PDFs, and videos are allowed' })
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) { cleanup(); return res.status(404).json({ error: 'Not found' }) }
  const aid = id('att')
  db.prepare(`INSERT INTO attachments (id, task_id, org_id, filename, stored_name, file_type, file_size, uploaded_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    aid, t.id, t.org_id, req.file.originalname || 'file', req.file.filename, req.file.mimetype || null, req.file.size || 0, req.user.id, now())
  audit(req.user.org_id, req.user.id, 'task.attach', 'task', t.id, req.file.originalname || '')
  db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(now(), t.id)
  res.status(201).json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)))
})

// Remove an attachment (uploader, or any manager/admin). Deletes the file too.
r.delete('/attachments/:attId', (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.attId)
  if (!a) return res.status(404).json({ error: 'Not found' })
  const taskOrg = a.org_id || db.prepare('SELECT org_id FROM tasks WHERE id=?').get(a.task_id)?.org_id
  if (taskOrg !== req.user.org_id) return res.status(403).json({ error: 'Out of organization' })
  const isManager = req.user.role === 'manager' || req.user.role === 'admin'
  if (!isManager && a.uploaded_by !== req.user.id) return res.status(403).json({ error: 'Only the uploader or a manager can remove this.' })
  if (a.stored_name) try { fs.unlinkSync(path.join(ATTACH_DIR, a.stored_name)) } catch {}
  db.prepare('DELETE FROM attachments WHERE id=?').run(a.id)
  res.json({ ok: true })
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
  // Own self-created work can be binned whether or not managers can see it —
  // it was never their task to sign off. Anything handed to you by someone else
  // still needs a manager.
  if (!isManager && !isOwnSelfCreated(t, req.user.id) && !isOwnPrivateDraft) {
    return res.status(403).json({ error: 'You can only delete tasks you created for yourself.' })
  }
  // Unlink attachment files for this task AND its subtasks before the row cascade
  // removes their DB rows (the DB cascade doesn't touch the files on disk).
  const subIds = db.prepare('SELECT id FROM tasks WHERE parent_task_id=?').all(t.id).map((s) => s.id)
  const ph = [t.id, ...subIds].map(() => '?').join(',')
  for (const a of db.prepare(`SELECT stored_name FROM attachments WHERE task_id IN (${ph})`).all(t.id, ...subIds)) {
    if (a.stored_name) try { fs.unlinkSync(path.join(ATTACH_DIR, a.stored_name)) } catch {}
  }
  db.prepare('DELETE FROM tasks WHERE id=?').run(t.id)
  audit(req.user.org_id, req.user.id, 'task.delete', 'task', t.id)
  removeEmbedding('task', t.id)
  res.json({ ok: true })
})

export default r
