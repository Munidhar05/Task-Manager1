import { Router } from 'express'
import multer from 'multer'
import { db } from '../db.js'
import { authRequired, requireRole } from '../auth.js'
import { id, now, audit, notify } from '../util.js'
import { analyzeMeetingTranscript, resolveUser, resolveUserAmong } from '../ai/extractor.js'
import { transcribeAudio } from '../ai/transcribe.js'
import { indexMeeting, indexTask, removeMeetingEmbeddings } from '../ai/ragIndex.js'

const r = Router()
r.use(authRequired)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })

// Attendees (with role + department) the AI may assign work to. When no
// participants were selected, fall back to everyone in the org.
function attendeesFor(orgId, participantIds) {
  const base = `SELECT u.id, u.name, u.role, d.name AS department
    FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.org_id=?`
  if (participantIds && participantIds.length) {
    const ph = participantIds.map(() => '?').join(',')
    return db.prepare(`${base} AND u.id IN (${ph}) ORDER BY u.name`).all(orgId, ...participantIds)
  }
  return db.prepare(`${base} ORDER BY u.name`).all(orgId)
}

// Turn an approved suggestion into a real, assigned task and (optionally) notify
// the assignee. Marks the suggestion approved and links the created task.
function createTaskFromSuggestion(s, { orgId, actorId, notifyAssignee = true }) {
  const tid = id('task')
  db.prepare(`INSERT INTO tasks
    (id, org_id, title, description, assignee_id, assignee_name_raw, assigned_by_id, assigned_by_name_raw,
     due_date, due_date_raw, priority, status, meeting_id, ownership_confidence, progress, approval_status, source_quote,
     assigned_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    tid, orgId, s.title, s.description || s.title, s.suggested_assignee_id || null, s.suggested_assignee_raw || null,
    actorId, null, s.due_date || null, s.due_date_raw || null,
    s.priority || 'Medium', 'To Do', s.meeting_id, s.suggested_assignee_id ? 'high' : 'needs_confirmation', 0, 'none',
    s.source_quote || null, s.suggested_assignee_id ? now() : null, now(), now())
  db.prepare("UPDATE suggested_tasks SET status='approved', created_task_id=?, updated_at=? WHERE id=?").run(tid, now(), s.id)
  if (notifyAssignee && s.suggested_assignee_id) {
    notify(orgId, s.suggested_assignee_id, 'task_assigned', `You were assigned "${s.title}"`, tid)
  }
  indexTask(tid) // index the newly created task for RAG
  return tid
}

// Persist a meeting + participants + segments, and queue the AI's tasks as
// PENDING SUGGESTIONS for manager review (they are not assigned yet).
// opts.autoApprove (used by the seed) immediately assigns them so demo
// dashboards stay populated.
function persistMeeting({ orgId, userId, title, description, meetingDate, transcript, sourceType, audioFilename, participantIds = [] }, analysis, opts = {}) {
  const mid = id('mtg')
  db.prepare(`INSERT INTO meetings
    (id, org_id, title, description, meeting_date, uploaded_by, source_type, audio_filename, raw_transcript, detected_languages, status, summary_json, engine, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    mid, orgId, title, description || '', meetingDate, userId, sourceType || 'transcript', audioFilename || null,
    transcript, JSON.stringify(analysis.detected_languages || []), 'processed',
    JSON.stringify(analysis.summary || {}), analysis.engine || 'rule-based', now())

  // Attendees — only these users can be suggested as task owners.
  const attendeeIds = []
  for (const uid of participantIds) {
    if (!uid || attendeeIds.includes(uid)) continue
    const u = db.prepare('SELECT id FROM users WHERE id=? AND org_id=?').get(uid, orgId)
    if (!u) continue
    attendeeIds.push(uid)
    db.prepare('INSERT OR IGNORE INTO meeting_participants (meeting_id, user_id) VALUES (?,?)').run(mid, uid)
  }

  ;(analysis.segments || []).forEach((s) => {
    db.prepare('INSERT INTO transcript_segments (id, meeting_id, seq, speaker, text, language) VALUES (?,?,?,?,?,?)')
      .run(id('seg'), mid, s.seq, s.speaker || null, s.text, s.language || null)
  })

  // AI Review Queue — de-duped by normalized title + assignee (prevent duplicates).
  const seen = new Set()
  let suggestionCount = 0
  for (const t of analysis.tasks || []) {
    const assignee = resolveUserAmong(orgId, t.assignee_name_raw, attendeeIds)
    const key = (t.title || '').toLowerCase().trim() + '|' + (assignee?.id || '')
    if (seen.has(key)) continue
    seen.add(key)
    const conf = Number.isFinite(t.confidence) ? Math.max(0, Math.min(100, Math.round(t.confidence))) : (assignee ? 80 : 30)
    db.prepare(`INSERT INTO suggested_tasks
      (id, meeting_id, org_id, title, description, suggested_assignee_id, suggested_assignee_raw, assignee_reasoning,
       confidence, priority, due_date, due_date_raw, source_quote, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id('sug'), mid, orgId, t.title, t.description || t.title, assignee?.id || null, t.assignee_name_raw || null,
      t.assignee_reasoning || null, conf, t.priority || 'Medium', t.due_date || null, t.due_date_raw || null,
      t.source_quote || null, 'pending', now(), now())
    suggestionCount++
  }

  // Demo/seed: approve everything that has a resolved owner into live tasks.
  let assignedCount = 0
  if (opts.autoApprove) {
    const rows = db.prepare("SELECT * FROM suggested_tasks WHERE meeting_id=? AND status='pending'").all(mid)
    for (const s of rows) {
      if (!s.suggested_assignee_id) continue
      createTaskFromSuggestion(s, { orgId, actorId: userId, notifyAssignee: false })
      assignedCount++
    }
  }

  audit(orgId, userId, 'meeting.process', 'meeting', mid, `${suggestionCount} suggestion(s), engine=${analysis.engine}`)
  indexMeeting(mid) // index the meeting summary + transcript segments for RAG
  return { mid, suggestionCount, assignedCount }
}

// LIST
r.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.meeting_id=m.id) AS task_count,
      (SELECT COUNT(*) FROM suggested_tasks s WHERE s.meeting_id=m.id AND s.status='pending') AS pending_count
    FROM meetings m WHERE m.org_id=? ORDER BY m.meeting_date DESC, m.created_at DESC
  `).all(req.user.org_id)
  res.json(rows.map((m) => ({ ...m, detected_languages: JSON.parse(m.detected_languages || '[]'), summary: JSON.parse(m.summary_json || '{}') })))
})

// DETAIL
r.get('/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  const segments = db.prepare('SELECT * FROM transcript_segments WHERE meeting_id=? ORDER BY seq').all(m.id)
  const tasks = db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.meeting_id=? ORDER BY t.created_at`).all(m.id)
  const participants = db.prepare(`SELECT u.id, u.name, u.avatar_color, u.role, u.department_id
    FROM meeting_participants p JOIN users u ON u.id=p.user_id WHERE p.meeting_id=? ORDER BY u.name`).all(m.id)
  const suggestions = db.prepare(`SELECT s.*, u.name AS suggested_assignee_name, u.avatar_color AS suggested_assignee_color
    FROM suggested_tasks s LEFT JOIN users u ON u.id=s.suggested_assignee_id WHERE s.meeting_id=? ORDER BY s.created_at`).all(m.id)
  res.json({
    ...m,
    detected_languages: JSON.parse(m.detected_languages || '[]'),
    summary: JSON.parse(m.summary_json || '{}'),
    segments, tasks, participants, suggestions,
  })
})

// EDIT meeting metadata (title / date). Managers & admins only.
r.patch('/:id', requireRole('manager', 'admin'), (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  const b = req.body || {}
  const sets = [], args = []
  if ('title' in b) { sets.push('title=?'); args.push((b.title || '').trim() || 'Untitled Meeting') }
  if ('meeting_date' in b) { sets.push('meeting_date=?'); args.push((b.meeting_date || '').slice(0, 10)) }
  if (!sets.length) return res.json({ ok: true })
  args.push(m.id)
  db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id=?`).run(...args)
  audit(req.user.org_id, req.user.id, 'meeting.update', 'meeting', m.id, b)
  indexMeeting(m.id) // title change → re-index
  res.json({ ok: true })
})

// DELETE a meeting and everything derived from it (segments + extracted tasks). Managers & admins only.
r.delete('/:id', requireRole('manager', 'admin'), (req, res) => {
  const m = db.prepare('SELECT id FROM meetings WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  removeMeetingEmbeddings(m.id) // drop RAG vectors before the source rows vanish
  const wipe = db.transaction(() => {
    db.prepare('DELETE FROM tasks WHERE meeting_id=?').run(m.id)            // cascades subtasks/comments/deps
    db.prepare('DELETE FROM transcript_segments WHERE meeting_id=?').run(m.id)
    db.prepare('DELETE FROM meetings WHERE id=?').run(m.id)
  })
  wipe()
  audit(req.user.org_id, req.user.id, 'meeting.delete', 'meeting', m.id)
  res.json({ ok: true })
})

// CREATE from transcript text + process (managers/admins upload meetings)
r.post('/', requireRole('manager', 'admin'), async (req, res) => {
  const { title, description, meeting_date, transcript, summary_language, participant_ids } = req.body || {}
  if (!transcript || !transcript.trim()) return res.status(400).json({ error: 'transcript text required' })
  const meetingDate = (meeting_date || now()).slice(0, 10)
  const participantIds = Array.isArray(participant_ids) ? participant_ids.filter(Boolean) : []
  const attendees = attendeesFor(req.user.org_id, participantIds)
  try {
    const analysis = await analyzeMeetingTranscript(transcript, {
      meetingDate, knownNames: attendees.map((a) => a.name), attendees, summaryLanguage: summary_language || 'en',
    })
    const { mid, suggestionCount } = persistMeeting(
      { orgId: req.user.org_id, userId: req.user.id, title: title || 'Untitled Meeting', description, meetingDate, transcript, sourceType: 'transcript', participantIds },
      analysis)
    res.status(201).json({ id: mid, suggestion_count: suggestionCount, engine: analysis.engine, fallback_reason: analysis.fallback_reason || null })
  } catch (err) {
    console.error('[meetings] process error', err)
    res.status(500).json({ error: 'Processing failed: ' + err.message })
  }
})

// TRANSCRIBE a single audio chunk -> text (auto language detection).
// The live recorder streams short segments here; the client assembles the transcript.
r.post('/transcribe', requireRole('manager', 'admin'), upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required (field "audio")' })
  try {
    const { text, language } = await transcribeAudio(req.file.buffer, req.file.originalname || 'chunk.webm', req.file.mimetype || 'audio/webm', { prompt: req.body.prompt })
    res.json({ text, language })
  } catch (err) {
    console.error('[transcribe]', err.message)
    res.status(err.code === 'NO_PROVIDER' ? 400 : 502).json({ error: err.message, code: err.code || null })
  }
})

// Full AUDIO file upload -> transcription -> analysis -> tasks (one-shot, e.g. for an uploaded recording).
r.post('/audio', requireRole('manager', 'admin'), upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required (field "audio")' })
  try {
    // Long uploaded files go to OpenAI Whisper (no duration cap) when a key is
    // present — Sarvam's instant endpoint rejects audio over 30s. Live recording
    // still uses the configured provider (Sarvam streaming).
    const uploadProvider = process.env.OPENAI_API_KEY ? 'openai' : undefined
    const { text } = await transcribeAudio(req.file.buffer, req.file.originalname || 'meeting.webm', req.file.mimetype || 'audio/webm', { provider: uploadProvider })
    if (!text.trim()) return res.status(422).json({ error: 'Transcription returned no text.' })
    const meetingDate = (req.body.meeting_date || now()).slice(0, 10)
    const participantIds = (() => {
      try { const p = JSON.parse(req.body.participant_ids || '[]'); return Array.isArray(p) ? p.filter(Boolean) : [] }
      catch { return [] }
    })()
    const attendees = attendeesFor(req.user.org_id, participantIds)
    const analysis = await analyzeMeetingTranscript(text, {
      meetingDate, knownNames: attendees.map((a) => a.name), attendees, summaryLanguage: req.body.summary_language || 'en',
    })
    const { mid, suggestionCount } = persistMeeting(
      { orgId: req.user.org_id, userId: req.user.id, title: req.body.title || 'Recorded Meeting', description: req.body.description, meetingDate, transcript: text, sourceType: 'audio', audioFilename: req.file.originalname, participantIds },
      analysis)
    res.status(201).json({ id: mid, suggestion_count: suggestionCount, engine: analysis.engine })
  } catch (err) {
    console.error('[audio]', err.message)
    res.status(err.code === 'NO_PROVIDER' ? 400 : 502).json({ error: err.message, code: err.code || null })
  }
})

// ---- AI Review Queue: manager review & assignment ---------------------------

// Fetch a suggestion scoped to the manager's org (via its meeting).
function getSuggestion(sid, orgId) {
  return db.prepare(`SELECT s.* FROM suggested_tasks s JOIN meetings m ON m.id=s.meeting_id
    WHERE s.id=? AND m.org_id=?`).get(sid, orgId)
}

// EDIT a suggestion before assigning (assignee, title, priority, due, etc.).
r.patch('/suggestions/:sid', requireRole('manager', 'admin'), (req, res) => {
  const s = getSuggestion(req.params.sid, req.user.org_id)
  if (!s) return res.status(404).json({ error: 'Not found' })
  const b = req.body || {}
  const sets = [], args = []
  for (const f of ['title', 'description', 'priority', 'due_date', 'due_date_raw', 'assignee_reasoning']) {
    if (f in b) { sets.push(`${f}=?`); args.push(b[f]) }
  }
  if ('confidence' in b) { sets.push('confidence=?'); args.push(Math.max(0, Math.min(100, Math.round(Number(b.confidence) || 0)))) }
  if ('suggested_assignee_id' in b) {
    const uid = b.suggested_assignee_id || null
    if (uid && !db.prepare('SELECT id FROM users WHERE id=? AND org_id=?').get(uid, req.user.org_id)) {
      return res.status(400).json({ error: 'invalid assignee' })
    }
    sets.push('suggested_assignee_id=?'); args.push(uid)
  }
  if (!sets.length) return res.json(s)
  sets.push('updated_at=?'); args.push(now())
  args.push(s.id)
  db.prepare(`UPDATE suggested_tasks SET ${sets.join(', ')} WHERE id=?`).run(...args)
  res.json(db.prepare('SELECT * FROM suggested_tasks WHERE id=?').get(s.id))
})

// REJECT a suggestion (won't be assigned).
r.post('/suggestions/:sid/reject', requireRole('manager', 'admin'), (req, res) => {
  const s = getSuggestion(req.params.sid, req.user.org_id)
  if (!s) return res.status(404).json({ error: 'Not found' })
  db.prepare("UPDATE suggested_tasks SET status='rejected', updated_at=? WHERE id=?").run(now(), s.id)
  res.json({ ok: true })
})

// MERGE a duplicate suggestion into another (the duplicate is dropped).
r.post('/suggestions/:sid/merge', requireRole('manager', 'admin'), (req, res) => {
  const s = getSuggestion(req.params.sid, req.user.org_id)
  const target = getSuggestion(req.body?.into, req.user.org_id)
  if (!s || !target) return res.status(404).json({ error: 'Not found' })
  if (s.id === target.id) return res.status(400).json({ error: 'cannot merge into itself' })
  db.prepare("UPDATE suggested_tasks SET status='merged', merged_into=?, updated_at=? WHERE id=?").run(target.id, now(), s.id)
  res.json({ ok: true })
})

// ASSIGN — final step. Create real tasks from the chosen (or all pending)
// suggestions, notify the assignees, and mark the suggestions approved.
r.post('/:id/assign', requireRole('manager', 'admin'), (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null
  let rows = db.prepare("SELECT * FROM suggested_tasks WHERE meeting_id=? AND status='pending'").all(m.id)
  if (ids) rows = rows.filter((s) => ids.includes(s.id))
  let assigned = 0, skipped = 0
  const tx = db.transaction(() => {
    for (const s of rows) {
      if (!s.suggested_assignee_id) { skipped++; continue } // no owner — can't assign
      createTaskFromSuggestion(s, { orgId: m.org_id, actorId: req.user.id, notifyAssignee: true })
      assigned++
    }
  })
  tx()
  audit(req.user.org_id, req.user.id, 'meeting.assign', 'meeting', m.id, `assigned=${assigned}, skipped=${skipped}`)
  res.json({ assigned, skipped })
})

export default r
export { persistMeeting }
