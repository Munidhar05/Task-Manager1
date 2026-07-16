import { Router } from 'express'
import { authRequired } from '../auth.js'
import { answerQuery } from '../ai/assistant.js'
import { chatAnswer, hasLLM } from '../ai/assistantChat.js'
import { routeCommand, STATUSES, PRIORITIES } from '../ai/voiceTools.js'
import { dateRange, overview, workload, groupTasks } from '../ai/voiceAnalytics.js'
import { listMeetings, resolveMeeting, meetingSummary, askWhichMeeting } from '../ai/voiceMeetings.js'
// The voice router works with ANY configured provider (OpenRouter/Claude/OpenAI),
// unlike assistantChat's hasLLM which only knows about Claude/OpenAI.
import { hasLLM as hasVoiceLLM } from '../ai/voiceTask.js'
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

// Map a navigate target to a URL, or signal a denial.
function navUrl(a, user) {
  switch (a.target) {
    case 'overdue': return { url: '/tasks?view=overdue' }
    case 'completed': return { url: '/tasks?view=completed' }
    case 'active': return { url: '/tasks?view=active' }
    case 'all': case 'my_tasks': return { url: '/tasks' }
    case 'dashboard': return { url: '/' }
    case 'meetings': return user.role === 'employee' ? { deny: 'Only managers can open meetings.' } : { url: '/meetings' }
    case 'chats': return { url: '/chats' }
    case 'status': return a.status ? { url: `/tasks?status=${encodeURIComponent(a.status)}` } : null
    case 'priority': return a.priority ? { url: `/tasks?priority=${encodeURIComponent(a.priority)}&view=active` } : null
    case 'person': {
      if (user.role === 'employee') return { deny: 'You can only see your own tasks.' }
      const u = a.person ? resolveUser(user.org_id, a.person) : null
      return u ? { url: `/tasks?assignee=${u.id}` } : null
    }
    default: return null
  }
}

const clarify = (say) => ({ mode: 'clarify', say: say || "Sorry, I didn't catch that — could you say it again?" })
const answer = (say, extra = {}) => ({ mode: 'answer', say, ...extra })
const confirm = (say, action) => ({ mode: 'confirm', say, action })

// Express 4 does not catch rejections from async handlers, so an unexpected throw
// here would take the whole process down. Wrap the dispatcher and degrade to a
// spoken apology instead.
r.post('/command', (req, res) => {
  handleCommand(req, res).catch((err) => {
    console.error('[assistant] voice command crashed:', err)
    if (!res.headersSent) res.json(clarify('Something went wrong on my side — please try again.'))
  })
})

async function handleCommand(req, res) {
  const transcript = String(req.body?.transcript || '').trim()
  const history = Array.isArray(req.body?.history) ? req.body.history : []
  if (!transcript) return res.status(400).json({ error: 'transcript required' })
  if (!hasVoiceLLM()) return res.json(answer('Voice control needs an AI engine configured on the server.'))

  const user = req.user
  const tasks = commandScopedTasks(user)
  const users = db.prepare("SELECT id, name, role, aliases FROM users WHERE org_id=? AND role != 'admin'").all(user.org_id)

  let call
  try {
    call = await routeCommand(transcript, {
      user, tasks, users, history,
      onUsage: (u) => recordUsage({ orgId: user.org_id, userId: user.id, feature: 'voice_command', ...u }),
    })
  } catch (err) {
    console.warn('[assistant] voice route failed:', err.message)
    return res.json(clarify("I couldn't process that just now — please try again."))
  }

  const a = call.args || {}
  const findTask = (id) => tasks.find((t) => t.id === id) || null
  const t0 = new Date().toISOString().slice(0, 10)
  const dueFrom = (raw) => (raw ? parseDueDate(raw, t0).date || null : null)
  // A mutation the LLM aimed at a task we can't see -> ask instead of failing.
  const needTask = (verb) => {
    const t = findTask(a.task_id)
    return t || clarify(call.say || `Which task should I ${verb}?`)
  }

  switch (call.tool) {
    case 'denied':
      return res.json(answer(call.say))

    case 'create_task': {
      if (!a.title) return res.json(clarify('What should the task be?'))
      const match = a.assignee_name ? resolveUser(user.org_id, a.assignee_name) : null
      const priority = PRIORITIES.includes(a.priority) ? a.priority : 'Medium'
      const due = dueFrom(a.due_date_raw)
      const who = match ? ` for ${match.name}` : (a.assignee_name ? ` for ${a.assignee_name} (not found — leaving it unassigned)` : '')
      return res.json(confirm(
        `Create a ${priority.toLowerCase()} priority task "${a.title}"${who}${due ? ` due ${due}` : ''}. Shall I create it?`,
        { kind: 'create_task', summary: `Create "${a.title}"`, body: { title: a.title, description: a.description || '', assignee_id: match?.id || null, priority, due_date: due } },
      ))
    }

    case 'update_task': {
      const t = needTask('edit'); if (t.mode) return res.json(t)
      const body = {}, bits = []
      if (a.title) { body.title = String(a.title).trim(); bits.push(`rename to "${body.title}"`) }
      if (a.description) { body.description = String(a.description).trim(); bits.push('update the description') }
      if (PRIORITIES.includes(a.priority)) { body.priority = a.priority; bits.push(`set priority ${a.priority}`) }
      if (a.progress != null && !Number.isNaN(Number(a.progress))) {
        body.progress = Math.max(0, Math.min(100, Math.round(Number(a.progress)))); bits.push(`set progress ${body.progress}%`)
      }
      if (a.due_date_raw) {
        const due = dueFrom(a.due_date_raw)
        if (!due) return res.json(clarify(`When should "${t.title}" be due?`))
        body.due_date = due; body.due_date_raw = null; bits.push(`due ${due}`)
      }
      if (!bits.length) return res.json(clarify(`What should I change about "${t.title}"?`))
      return res.json(confirm(`For "${t.title}": ${bits.join(', ')}. Confirm?`,
        { kind: 'update_task', task_id: t.id, summary: `"${t.title}" — ${bits.join(', ')}`, body }))
    }

    case 'set_status': {
      const t = needTask('update'); if (t.mode) return res.json(t)
      if (!STATUSES.includes(a.status)) return res.json(clarify(`What status should "${t.title}" be?`))
      return res.json(confirm(`Mark "${t.title}" as ${a.status}. Confirm?`,
        { kind: 'set_status', task_id: t.id, summary: `"${t.title}" → ${a.status}`, body: { status: a.status } }))
    }

    case 'assign_task': {
      const t = needTask('reassign'); if (t.mode) return res.json(t)
      const match = a.assignee_name ? resolveUser(user.org_id, a.assignee_name) : null
      if (!match) return res.json(clarify(a.assignee_name ? `I couldn't find "${a.assignee_name}" — who should I assign it to?` : 'Who should I assign it to?'))
      return res.json(confirm(`Assign "${t.title}" to ${match.name}. Confirm?`,
        { kind: 'assign_task', task_id: t.id, summary: `"${t.title}" → ${match.name}`, body: { assignee_id: match.id } }))
    }

    case 'add_comment': {
      const t = needTask('comment on'); if (t.mode) return res.json(t)
      const body = String(a.body || '').trim()
      if (!body) return res.json(clarify(`What should the comment on "${t.title}" say?`))
      return res.json(confirm(`Comment on "${t.title}": "${body}". Post it?`,
        { kind: 'add_comment', task_id: t.id, summary: `Comment on "${t.title}"`, body: { body } }))
    }

    case 'delete_task': {
      const t = needTask('delete'); if (t.mode) return res.json(t)
      return res.json(confirm(`Delete "${t.title}" permanently. Are you sure?`,
        { kind: 'delete_task', task_id: t.id, summary: `Delete "${t.title}"`, body: {} }))
    }

    case 'navigate': {
      const nav = navUrl(a, user)
      if (nav?.deny) return res.json(answer(nav.deny))
      if (!nav?.url) return res.json(clarify(call.say || 'Where would you like to go?'))
      return res.json({ mode: 'navigate', say: call.say || 'Opening that now.', navigate: { url: nav.url } })
    }

    // ---- read tools: the numbers come from SQL, not the model ---------------
    // Each returns a typed `data` block so the client can render the figures as a
    // card instead of only speaking them.
    case 'get_overview': {
      const range = dateRange(a.period, a.from, a.to)
      const { say, stats } = overview(user, range)
      return res.json(answer(say, { data: { type: 'overview', label: range.label, range, stats } }))
    }

    case 'get_workload': {
      const who = a.assignee_name ? resolveUser(user.org_id, a.assignee_name) : null
      if (a.assignee_name && !who) return res.json(clarify(`I couldn't find "${a.assignee_name}".`))
      const { say, rows } = workload(user, who?.id || null)
      return res.json(answer(say, { data: { type: 'workload', rows } }))
    }

    case 'group_tasks': {
      const who = a.person ? resolveUser(user.org_id, a.person) : null
      const opts = {
        group_by: ['assignee', 'status', 'priority'].includes(a.group_by) ? a.group_by : 'assignee',
        overdue: a.overdue === true || a.overdue === 'true',
        status: STATUSES.includes(a.status) ? a.status : null,
        priority: PRIORITIES.includes(a.priority) ? a.priority : null,
        assignee_id: who?.id || null,
      }
      const { say, rows, total } = groupTasks(user, opts)
      // Also open the matching list so they can see what was counted.
      const url = opts.overdue ? '/tasks?view=overdue'
        : opts.status ? `/tasks?status=${encodeURIComponent(opts.status)}`
        : opts.priority ? `/tasks?priority=${encodeURIComponent(opts.priority)}`
        : who ? `/tasks?assignee=${who.id}` : '/tasks'
      const what = opts.overdue ? 'Overdue tasks' : opts.status ? `${opts.status} tasks`
        : opts.priority ? `${opts.priority} priority tasks` : 'Tasks'
      return res.json(answer(say, { navigate: { url }, data: { type: 'group', title: `${what} by ${opts.group_by}`, rows, total } }))
    }

    // ---- meetings -----------------------------------------------------------
    case 'start_meeting':
      // The Meetings page opens its live recorder when it sees ?live=1.
      return res.json({ mode: 'navigate', say: call.say || 'Starting a new meeting recording.', navigate: { url: '/meetings?live=1' } })

    case 'list_meetings':
      return res.json(answer(listMeetings(user).say, { navigate: { url: '/meetings' } }))

    case 'open_meeting': {
      const m = resolveMeeting(user, { title: a.title, date: a.date, latest: a.latest === true || a.latest === 'true' })
      if (m.none) return res.json(clarify("I couldn't find that meeting."))
      if (m.candidates) return res.json(clarify(askWhichMeeting(m.candidates)))
      return res.json({ mode: 'navigate', say: `Opening "${m.meeting.title}" from ${m.meeting.meeting_date}.`, navigate: { url: `/meetings/${m.meeting.id}` } })
    }

    case 'summarize_meeting': {
      const m = resolveMeeting(user, { title: a.title, date: a.date, latest: a.latest === true || a.latest === 'true' })
      if (m.none) return res.json(clarify("I couldn't find that meeting."))
      if (m.candidates) return res.json(clarify(askWhichMeeting(m.candidates)))
      return res.json(answer(meetingSummary(m.meeting).say, { navigate: { url: `/meetings/${m.meeting.id}` } }))
    }

    case 'ask': {
      const question = String(a.question || transcript).trim()
      try {
        const result = await chatAnswer(question, user, history.map((m) => ({ role: m.role, text: m.text })),
          (u) => recordUsage({ orgId: user.org_id, userId: user.id, feature: 'voice_ask', ...u }))
        return res.json(answer(result.answer, { tasks: hydrate(result.tasks) }))
      } catch (err) {
        console.warn('[assistant] voice ask (RAG) failed, falling back to rules:', err.message)
        const result = answerQuery(question, user)
        return res.json(answer(result.answer, { tasks: hydrate(result.tasks) }))
      }
    }

    case 'clarify':
    default:
      return res.json(clarify(a.question || call.say))
  }
}

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
