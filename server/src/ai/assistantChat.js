// Conversational AI assistant, strictly scoped to this Task Manager's data.
// Uses Claude (ANTHROPIC_API_KEY) first, then OpenAI (OPENAI_API_KEY).
// When no key is configured (or the call fails) the caller falls back to the
// rule-based answerQuery in ./assistant.js so the chat always works offline.
import { db } from '../db.js'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

const OPEN_STATUSES = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Reopened']
const today = () => new Date().toISOString().slice(0, 10)
const isOverdue = (t) => t.due_date && t.due_date < today() && t.status !== 'Done'

export const hasLLM = () => !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)

// Tasks the requesting user is allowed to see (employees: only their own).
function scopedTasks(user) {
  const rows = db.prepare(`
    SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date,
           t.progress, t.assignee_id, t.created_at, t.updated_at, t.completed_at,
           u.name AS assignee_name, b.name AS assigned_by_name,
           p.name AS project_name, d.name AS department_name,
           m.title AS meeting_title, m.meeting_date AS meeting_date
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN users b ON b.id = t.assigned_by_id
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN meetings m ON m.id = t.meeting_id
    WHERE t.org_id = ? AND t.parent_task_id IS NULL
    ORDER BY t.updated_at DESC
  `).all(user.org_id)
  return user.role === 'employee' ? rows.filter((t) => t.assignee_id === user.id) : rows
}

// Per-person open-task counts — only exposed to managers/admins.
function workloadRows(orgId) {
  return db.prepare(`
    SELECT u.name, u.role, d.name AS dept,
      (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id
         AND t.status IN ('To Do','In Progress','Blocked','In Review','Reopened')
         AND t.parent_task_id IS NULL) AS open_count
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.org_id = ? AND u.role != 'admin'
    ORDER BY open_count DESC
  `).all(orgId)
}

const MAX_TASKS_IN_CONTEXT = 200

// Build a compact, factual snapshot of everything the model is allowed to use.
function buildContext(user) {
  const tasks = scopedTasks(user)
  const t0 = today()
  const stats = {
    total: tasks.length,
    open: tasks.filter((t) => OPEN_STATUSES.includes(t.status)).length,
    done: tasks.filter((t) => t.status === 'Done').length,
    overdue: tasks.filter(isOverdue).length,
    due_today: tasks.filter((t) => t.due_date === t0 && t.status !== 'Done').length,
    blocked: tasks.filter((t) => t.status === 'Blocked').length,
  }

  const shown = tasks.slice(0, MAX_TASKS_IN_CONTEXT)
  const taskLines = shown.map((t) => {
    const bits = [
      `id=${t.id}`,
      `"${t.title}"`,
      `owner=${t.assignee_name || 'Unassigned'}`,
      `status=${t.status}`,
      `priority=${t.priority}`,
    ]
    if (t.due_date) bits.push(`due=${t.due_date}${isOverdue(t) ? ' OVERDUE' : ''}`)
    if (t.project_name) bits.push(`project=${t.project_name}`)
    if (t.department_name) bits.push(`dept=${t.department_name}`)
    if (typeof t.progress === 'number' && t.progress > 0) bits.push(`progress=${t.progress}%`)
    if (t.meeting_title) bits.push(`from_meeting="${t.meeting_title}"`)
    return '- ' + bits.join(' | ')
  })
  const truncated = tasks.length > shown.length
    ? `\n(...${tasks.length - shown.length} more tasks not listed; ask to narrow down.)` : ''

  let context = `STATS: ${JSON.stringify(stats)}\n\nTASKS (${shown.length} of ${tasks.length}):\n${taskLines.join('\n') || '(none)'}${truncated}`

  if (user.role !== 'employee') {
    const wl = workloadRows(user.org_id)
    if (wl.length) {
      context += `\n\nTEAM WORKLOAD (open tasks per person):\n` +
        wl.map((w) => `- ${w.name} (${w.role}${w.dept ? ', ' + w.dept : ''}): ${w.open_count} open`).join('\n')
    }
  }
  return { context, tasks }
}

function systemPrompt(user) {
  const scopeNote = user.role === 'employee'
    ? 'This user is an employee — the snapshot contains ONLY their own tasks. Never imply you can see other people\'s tasks.'
    : `This user is a ${user.role} — the snapshot covers the whole organization, including team workload.`
  return `You are "TaskBot", the built-in AI assistant inside SmartTask, a team task-management platform. You help managers and team members quickly understand and act on their tasks, deadlines, workload, meetings, and team status.

STRICT SCOPE — you ONLY discuss this Task Manager and the data snapshot provided in the user message:
- tasks (status, priority, owner, due dates, overdue items, progress, projects, departments)
- people's workload and assignments inside this organization
- meetings and the action items / status they produced
- summaries, status reports, prioritization, and productivity insights derived from this data

If the user asks ANYTHING outside this scope (general knowledge, coding help, world facts, math puzzles, personal advice, weather, news, writing unrelated content, etc.), do NOT answer it even if you know the answer. Politely decline in one short sentence and steer them back to their tasks. Example: "I can only help with your tasks, deadlines, and team workload here — try asking about overdue work or your team's status."

GROUNDING RULES:
- Answer ONLY from the DATA SNAPSHOT. Never invent tasks, people, dates, numbers, or statuses.
- If the snapshot doesn't contain the answer, say so plainly (e.g. "I don't see any task matching that.").
- ${scopeNote}
- Today's date is ${today()}. The user is ${user.name}.
- Be concise and conversational — short sentences or compact bullet points suited to a chat bubble. No markdown headers or tables.
- When specific tasks are relevant to your answer, put their ids in "task_ids" (max 12) so the UI can show them as clickable cards. Use [] when none apply.

Respond with ONLY a JSON object, no markdown fences:
{"answer": "your reply text", "task_ids": ["id1","id2"]}`
}

// Trim client-supplied history into clean alternating turns for the API.
function normalizeHistory(history) {
  if (!Array.isArray(history)) return []
  return history
    .filter((m) => m && typeof m.text === 'string' && m.text.trim() && (m.role === 'user' || m.role === 'ai'))
    .slice(-8)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text.trim() }))
}

function parseModelJson(text) {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    return {
      answer: typeof obj.answer === 'string' ? obj.answer : '',
      task_ids: Array.isArray(obj.task_ids) ? obj.task_ids.map(String) : [],
    }
  } catch { return null }
}

async function callClaude(system, messages) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
      max_tokens: 1024,
      system,
      messages,
    }),
  })
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return (data.content || []).map((c) => c.text || '').join('')
}

async function callOpenAI(system, messages) {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'system', content: system }, ...messages],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 1024,
    }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

// Display shape for a hydrated task card (matches what the rule-based path returns).
const toCard = (t) => ({
  id: t.id, title: t.title, status: t.status, priority: t.priority,
  due_date: t.due_date, assignee_name: t.assignee_name, project_name: t.project_name,
})

// Main entry: returns { answer, tasks, engine }. Throws if no LLM is configured
// or the provider call/parse fails — the route catches and falls back to rules.
export async function chatAnswer(query, user, history = []) {
  const hasClaude = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI = !!process.env.OPENAI_API_KEY
  if (!hasClaude && !hasOpenAI) throw new Error('No LLM configured')

  const { context, tasks } = buildContext(user)
  const system = systemPrompt(user)
  const messages = [
    ...normalizeHistory(history),
    { role: 'user', content: `DATA SNAPSHOT:\n${context}\n\nQUESTION: ${query}` },
  ]

  // Provider chain mirrors the meeting extractor: Claude first, then OpenAI.
  // If Claude fails (e.g. no credit) and OpenAI is configured, fall through.
  let raw, engine
  if (hasClaude) {
    try { raw = await callClaude(system, messages); engine = 'claude' }
    catch (err) {
      if (!hasOpenAI) throw err
      console.warn('[assistant] Claude failed, trying OpenAI:', err.message)
    }
  }
  if (raw === undefined && hasOpenAI) {
    raw = await callOpenAI(system, messages); engine = 'openai'
  }

  const parsed = parseModelJson(raw)
  if (!parsed || !parsed.answer) throw new Error('Empty model response')

  // Hydrate only ids the user is actually allowed to see — never trust the model
  // to reveal a task outside scope.
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const cards = parsed.task_ids.map((id) => byId.get(id)).filter(Boolean).map(toCard)

  return { answer: parsed.answer, tasks: cards, engine }
}
