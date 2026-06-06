import { Router } from 'express'
import { authRequired } from '../auth.js'
import { answerQuery } from '../ai/assistant.js'
import { db } from '../db.js'

const r = Router()
r.use(authRequired)

// AI assistant + natural-language search share the same engine.
r.post('/query', (req, res) => {
  const { query } = req.body || {}
  if (!query) return res.status(400).json({ error: 'query required' })
  const result = answerQuery(query, req.user)
  // hydrate tasks lightly for display
  const tasks = (result.tasks || []).map((t) => ({
    id: t.id, title: t.title, status: t.status, priority: t.priority,
    due_date: t.due_date, assignee_name: t.assignee_name, project_name: t.project_name,
  }))
  res.json({ ...result, tasks })
})

// Suggested prompts for the UI
r.get('/suggestions', (req, res) => {
  const base = [
    'Show overdue tasks',
    'Show high priority tasks',
    'What tasks came from yesterday\'s meeting?',
    'Daily status report',
  ]
  if (req.user.role !== 'employee') {
    base.push('Workload imbalance', 'Weekly progress report', 'Who is responsible for deployment?')
  }
  res.json({ suggestions: base })
})

export default r
