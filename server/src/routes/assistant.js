import { Router } from 'express'
import { authRequired } from '../auth.js'
import { answerQuery } from '../ai/assistant.js'
import { chatAnswer, hasLLM } from '../ai/assistantChat.js'
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
      const result = await chatAnswer(query, req.user, history)
      return res.json({ ...result, tasks: hydrate(result.tasks) })
    } catch (err) {
      console.warn('[assistant] LLM failed, falling back to rules:', err.message)
    }
  }

  const result = answerQuery(query, req.user)
  res.json({ ...result, tasks: hydrate(result.tasks), engine: 'rule-based' })
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
