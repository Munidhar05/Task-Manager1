import { Router } from 'express'
import { authRequired } from '../auth.js'
import { answerQuery } from '../ai/assistant.js'
import { chatAnswer, hasLLM } from '../ai/assistantChat.js'
import { interpretCommand } from '../ai/voiceCommand.js'
import { resolveUser } from '../ai/extractor.js'
import { parseDueDate } from '../ai/dates.js'
import { recordUsage } from '../ai/usage.js'
import { db } from '../db.js'
import { id, now } from '../util.js'

const r = Router()
r.use(authRequired)

// ---- Chat history (server-side so threads sync across devices) -------------
const rowToConvo = (row) => ({
  id: row.id,
  title: row.title,
  msgs: JSON.parse(row.messages || '[]'),
  updated: Date.parse(row.updated_at) || Date.now(),
})

// All of my conversations, newest first.
r.get('/conversations', (req, res) => {
  const rows = db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC').all(req.user.id)
  res.json({ conversations: rows.map(rowToConvo) })
})

// Create a new conversation thread.
r.post('/conversations', (req, res) => {
  const { title, msgs } = req.body || {}
  const ts = now()
  const cid = id('conv')
  db.prepare('INSERT INTO conversations (id, org_id, user_id, title, messages, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(cid, req.user.org_id, req.user.id, (title || 'New chat').slice(0, 80), JSON.stringify(msgs || []), ts, ts)
  res.json(rowToConvo(db.prepare('SELECT * FROM conversations WHERE id=?').get(cid)))
})

// Upsert a conversation's title + messages (ownership enforced).
r.put('/conversations/:id', (req, res) => {
  const { title, msgs } = req.body || {}
  const existing = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.user.id)
  const ts = now()
  if (!existing) {
    db.prepare('INSERT INTO conversations (id, org_id, user_id, title, messages, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(req.params.id, req.user.org_id, req.user.id, (title || 'New chat').slice(0, 80), JSON.stringify(msgs || []), ts, ts)
  } else {
    db.prepare('UPDATE conversations SET title=?, messages=?, updated_at=? WHERE id=? AND user_id=?')
      .run((title || existing.title).slice(0, 80), JSON.stringify(msgs || []), ts, req.params.id, req.user.id)
  }
  res.json(rowToConvo(db.prepare('SELECT * FROM conversations WHERE id=?').get(req.params.id)))
})

// Delete a conversation.
r.delete('/conversations/:id', (req, res) => {
  db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(req.params.id, req.user.id)
  res.json({ ok: true })
})

const hydrate = (tasks) => (tasks || []).map((t) => ({
  id: t.id, title: t.title, status: t.status, priority: t.priority,
  due_date: t.due_date, assignee_name: t.assignee_name, project_name: t.project_name,
}))

// Conversational AI assistant. Uses an LLM (Claude/OpenAI) when configured so the
// manager can ask anything about their tasks in plain language; falls back to the
// offline rule-based engine when no key is set or the provider call fails.
r.post('/query', async (req, res, next) => {
  const { query, history } = req.body || {}
  if (!query) return res.status(400).json({ error: 'query required' })

  if (hasLLM()) {
    try {
      const result = await chatAnswer(query, req.user, history,
        (u) => recordUsage({ orgId: req.user.org_id, userId: req.user.id, feature: 'assistant', ...u }))
      return res.json({ ...result, tasks: hydrate(result.tasks) })
    } catch (err) {
      console.warn('[assistant] LLM failed, falling back to rules:', err.message)
    }
  }

  const result = answerQuery(query, req.user)
  res.json({ ...result, tasks: hydrate(result.tasks), engine: 'rule-based' })
})

// ---------------------------------------------------------------------------
// VOICE COMMAND — the brain behind hands-free control ("hey btm").
// Takes a transcribed utterance + the running conversation, returns ONE resolved
// action the client executes against the existing task endpoints (so all the
// usual permission checks & notifications still apply), a navigation target, a
// spoken answer, or a clarifying question. Mutations come back as mode:"confirm"
// so the client can get a quick yes/no before committing.
// ---------------------------------------------------------------------------

// Tasks the caller may see/act on (employees: only their own top-level tasks).
function commandScopedTasks(user) {
  const rows = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.due_date, t.assignee_id,
           u.name AS assignee_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.org_id = ? AND t.parent_task_id IS NULL
    ORDER BY t.updated_at DESC
  `).all(user.org_id)
  return user.role === 'employee' ? rows.filter((t) => t.assignee_id === user.id) : rows
}

// Build the URL a navigate intent maps to, or null if it can't/shouldn't.
function navUrl(nav, user) {
  switch (nav.target) {
    case 'overdue': return { url: '/tasks?view=overdue' }
    case 'completed': return { url: '/tasks?view=completed' }
    case 'active': return { url: '/tasks?view=active' }
    case 'all': case 'my_tasks': return { url: '/tasks' }
    case 'dashboard': return { url: '/' }
    case 'status': return nav.status ? { url: `/tasks?status=${encodeURIComponent(nav.status)}` } : null
    case 'priority': return nav.priority ? { url: `/tasks?priority=${encodeURIComponent(nav.priority)}&view=active` } : null
    case 'person': {
      if (user.role === 'employee') return { deny: 'You can only see your own tasks.' }
      const u = nav.person ? resolveUser(user.org_id, nav.person) : null
      return u ? { url: `/tasks?assignee=${u.id}` } : null
    }
    default: return null
  }
}

const clarify = (say) => ({ mode: 'clarify', say: say || "Sorry, I didn't catch that — could you say it again?" })

r.post('/command', async (req, res) => {
  const transcript = String(req.body?.transcript || '').trim()
  const history = Array.isArray(req.body?.history) ? req.body.history : []
  if (!transcript) return res.status(400).json({ error: 'transcript required' })
  if (!hasLLM()) return res.json({ mode: 'answer', say: 'Voice control needs an AI engine configured on the server.' })

  const tasks = commandScopedTasks(req.user)
  const users = db.prepare("SELECT id, name, role, aliases FROM users WHERE org_id=? AND role != 'admin'").all(req.user.org_id)

  let intent
  try {
    intent = await interpretCommand(transcript, {
      user: req.user, tasks, users, history,
      onUsage: (u) => recordUsage({ orgId: req.user.org_id, userId: req.user.id, feature: 'voice_command', ...u }),
    })
  } catch (err) {
    console.warn('[assistant] voice command interpret failed:', err.message)
    return res.json(clarify("I couldn't process that just now — please try again."))
  }

  const findTask = (tid) => tasks.find((t) => t.id === tid) || null
  const t0 = new Date().toISOString().slice(0, 10)

  switch (intent.intent) {
    case 'create_task': {
      if (!intent.title) return res.json(clarify('What should the task be?'))
      const match = intent.assignee_name ? resolveUser(req.user.org_id, intent.assignee_name) : null
      const priority = intent.priority || 'Medium'
      const due = intent.due_date_raw ? (parseDueDate(intent.due_date_raw, t0).date || null) : null
      const who = match ? ` for ${match.name}` : (intent.assignee_name ? ` for ${intent.assignee_name} (I couldn't find them — it'll be unassigned)` : '')
      const when = due ? ` due ${due}` : ''
      return res.json({
        mode: 'confirm',
        say: `Create a ${priority.toLowerCase()} priority task "${intent.title}"${who}${when}. Shall I create it?`,
        action: {
          kind: 'create_task',
          summary: `Create "${intent.title}"`,
          body: { title: intent.title, description: intent.description || '', assignee_id: match?.id || null, priority, due_date: due },
        },
      })
    }
    case 'update_status': {
      const t = findTask(intent.task_id)
      if (!t) return res.json(clarify(intent.say || 'Which task do you mean?'))
      if (!intent.status) return res.json(clarify(`What status should "${t.title}" be?`))
      return res.json({
        mode: 'confirm',
        say: `Mark "${t.title}" as ${intent.status}. Confirm?`,
        action: { kind: 'update_status', task_id: t.id, summary: `"${t.title}" → ${intent.status}`, body: { status: intent.status } },
      })
    }
    case 'assign_task': {
      const t = findTask(intent.task_id)
      if (!t) return res.json(clarify(intent.say || 'Which task should I reassign?'))
      const match = intent.assignee_name ? resolveUser(req.user.org_id, intent.assignee_name) : null
      if (!match) return res.json(clarify(intent.assignee_name ? `I couldn't find "${intent.assignee_name}" — who should I assign it to?` : 'Who should I assign it to?'))
      return res.json({
        mode: 'confirm',
        say: `Assign "${t.title}" to ${match.name}. Confirm?`,
        action: { kind: 'assign_task', task_id: t.id, summary: `"${t.title}" → ${match.name}`, body: { assignee_id: match.id } },
      })
    }
    case 'set_priority': {
      const t = findTask(intent.task_id)
      if (!t) return res.json(clarify(intent.say || 'Which task do you mean?'))
      if (!intent.priority) return res.json(clarify(`What priority should "${t.title}" be?`))
      return res.json({
        mode: 'confirm',
        say: `Set "${t.title}" to ${intent.priority} priority. Confirm?`,
        action: { kind: 'set_priority', task_id: t.id, summary: `"${t.title}" → ${intent.priority}`, body: { priority: intent.priority } },
      })
    }
    case 'set_due_date': {
      const t = findTask(intent.task_id)
      if (!t) return res.json(clarify(intent.say || 'Which task do you mean?'))
      const due = intent.due_date_raw ? (parseDueDate(intent.due_date_raw, t0).date || null) : null
      if (!due) return res.json(clarify(`When is "${t.title}" due?`))
      return res.json({
        mode: 'confirm',
        say: `Set "${t.title}" due ${due}. Confirm?`,
        action: { kind: 'set_due_date', task_id: t.id, summary: `"${t.title}" due ${due}`, body: { due_date: due, due_date_raw: null } },
      })
    }
    case 'navigate': {
      const nav = navUrl(intent.navigate, req.user)
      if (nav?.deny) return res.json({ mode: 'answer', say: nav.deny })
      if (!nav?.url) return res.json(clarify(intent.say || 'Where would you like to go?'))
      return res.json({ mode: 'navigate', say: intent.say || 'Opening that now.', navigate: { url: nav.url } })
    }
    case 'answer':
      return res.json({ mode: 'answer', say: intent.say || "I don't have anything on that." })
    default:
      return res.json(clarify(intent.say))
  }
})

// Suggested prompts for the UI
r.get('/suggestions', (req, res) => {
  const base = [
    'What needs my attention today?',
    'Show overdue tasks',
    'Summarize my high priority work',
    'What came out of the last meeting?',
  ]
  if (req.user.role !== 'employee') {
    base.push('How is the team\'s workload looking?', 'Give me a weekly progress report', 'Who is overloaded right now?')
  }
  res.json({ suggestions: base })
})

export default r
