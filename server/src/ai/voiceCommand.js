// Voice COMMAND interpreter — the brain behind hands-free control ("hey btm").
// Turns one spoken utterance (+ the running conversation) into a single structured
// INTENT the app can act on: create a task, change status, (re)assign, set priority
// or due date, navigate/filter the UI, answer a question, or ask a clarifying one.
//
// It reuses the same multilingual provider chain as the meeting/voice-task flows
// (OpenRouter → Claude → OpenAI), so English/Hindi/Telugu/code-mixed all work. The
// model is given a compact, RBAC-scoped snapshot of the user's tasks and teammates
// so it can resolve references like "the logo task" to a real task id, and it may
// ONLY act within what the caller is already allowed to see.
import { callOpenRouter, callClaude, callOpenAI, parseJson } from './voiceTask.js'

const INTENTS = [
  'create_task', 'update_status', 'assign_task', 'set_priority', 'set_due_date',
  'navigate', 'answer', 'clarify',
]
const STATUSES = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened']
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']
const NAV_TARGETS = ['overdue', 'completed', 'active', 'all', 'my_tasks', 'dashboard', 'person', 'status', 'priority']

const today = () => new Date().toISOString().slice(0, 10)

function systemPrompt(user) {
  const role = user.role
  const scope = role === 'employee'
    ? 'This user is an EMPLOYEE — the snapshot lists ONLY their own tasks, and they can only view/act on their own work. Never navigate to or reference other people\'s tasks; if they ask for someone else\'s tasks, use "answer" to say you can only show their own.'
    : `This user is a ${role} — the snapshot covers the whole organization and they may act on any task or person in it.`
  return `You are "BTM", the hands-free voice controller inside SmartTask, a team task manager. A person is speaking to control the app. Convert their latest utterance (using the conversation so far for context) into ONE structured intent.

You may speak/understand English, Hindi, Telugu, or a code-mixed blend, but ALWAYS write task titles/descriptions and the "say" reply in clear ENGLISH.

${scope}
Today's date is ${today()}. The user is ${user.name} (${role}).

Choose exactly ONE intent:
- "create_task": they want to create/add a new task. Provide title (short, imperative, English), description (1 helpful English sentence), assignee_name (the person as spoken, or null), priority (${PRIORITIES.join('|')} — infer urgency, default Medium), due_date_raw (deadline phrase exactly as spoken, e.g. "by Friday", "kal", or null).
- "update_status": change an EXISTING task's status. Provide task_id (copy the exact id from the snapshot for the task they mean) and status (${STATUSES.join('|')}). "mark done"/"complete" => "Done".
- "assign_task": (re)assign an existing task. Provide task_id and assignee_name.
- "set_priority": change an existing task's priority. Provide task_id and priority.
- "set_due_date": change an existing task's due date. Provide task_id and due_date_raw.
- "navigate": they want to see/filter tasks or move around. Provide navigate:{target, person, status, priority, query}. target is one of ${NAV_TARGETS.join('|')}. Examples: "show overdue" => target "overdue"; "open Reddy's tasks" => target "person", person "Reddy"; "show blocked tasks" => target "status", status "Blocked"; "high priority work" => target "priority", priority "High"; "go to dashboard" => target "dashboard".
- "answer": they asked a question about their tasks/workload/deadlines. Answer briefly in "say" using ONLY the snapshot; never invent data. Also use this to politely decline anything outside this task manager.
- "clarify": you need more info to act (e.g. which task they mean, or who to assign to). Ask a short question in "say" and set needs of the fields you still need.

RESOLVING TASKS: when an intent targets an existing task, pick task_id from the snapshot by matching the spoken description. If several tasks plausibly match, use "clarify" and name the top options in "say". If none match, use "clarify" and say you couldn't find it.

The "say" field is ALWAYS a short, natural spoken reply (one sentence). For create/update/assign/priority/due intents, "say" should read like a confirmation you're about to do it (the app adds the final yes/no step).

Respond with ONLY a JSON object, no markdown fences:
{"intent":"...","say":"...","task_id":null,"title":null,"description":null,"assignee_name":null,"priority":null,"status":null,"due_date_raw":null,"navigate":{"target":null,"person":null,"status":null,"priority":null,"query":null}}`
}

// Compact, RBAC-scoped snapshot the model resolves references against.
function snapshot(tasks, users, user) {
  const t0 = today()
  const taskLines = tasks.slice(0, 120).map((t) => {
    const bits = [`id=${t.id}`, `"${t.title}"`, `owner=${t.assignee_name || 'Unassigned'}`, `status=${t.status}`, `priority=${t.priority}`]
    if (t.due_date) bits.push(`due=${t.due_date}${t.due_date < t0 && t.status !== 'Done' ? ' OVERDUE' : ''}`)
    return '- ' + bits.join(' | ')
  })
  const peopleLines = user.role === 'employee'
    ? '' // employees don't get the roster (they can't assign to others by name here)
    : '\n\nTEAM (assignable people):\n' + users.map((u) => `- ${u.name}${u.role ? ` (${u.role})` : ''}`).join('\n')
  return `MY TASKS (${taskLines.length}):\n${taskLines.join('\n') || '(none)'}${peopleLines}`
}

function historyBlock(history) {
  if (!Array.isArray(history) || !history.length) return ''
  const turns = history
    .filter((m) => m && typeof m.text === 'string' && m.text.trim() && (m.role === 'user' || m.role === 'ai'))
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'BTM'}: ${m.text.trim()}`)
  return turns.length ? `\n\nCONVERSATION SO FAR:\n${turns.join('\n')}` : ''
}

// Interpret one utterance into a raw intent object (unresolved — the route resolves
// names/dates and enforces scope). Throws only if no provider is configured; the
// caller decides how to degrade.
export async function interpretCommand(transcript, { user, tasks = [], users = [], history = [], onUsage } = {}) {
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY
  const hasClaude = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI = !!process.env.OPENAI_API_KEY
  if (!hasOpenRouter && !hasClaude && !hasOpenAI) throw new Error('No LLM configured')

  const system = systemPrompt(user)
  const userMsg = `${snapshot(tasks, users, user)}${historyBlock(history)}\n\nUSER JUST SAID: ${transcript}`

  const providers = [
    hasOpenRouter && { name: 'OpenRouter', call: callOpenRouter },
    hasClaude && { name: 'Claude', call: callClaude },
    hasOpenAI && { name: 'OpenAI', call: callOpenAI },
  ].filter(Boolean)
  let raw, lastErr
  for (const p of providers) {
    try { raw = await p.call(system, userMsg, onUsage); if (raw) break }
    catch (err) { lastErr = err; console.warn(`[voiceCommand] ${p.name} failed, trying next:`, err.message) }
  }
  if (raw === undefined) throw lastErr || new Error('All providers failed')

  const obj = parseJson(raw) || {}
  const intent = INTENTS.includes(obj.intent) ? obj.intent : 'clarify'
  const nav = obj.navigate || {}
  return {
    intent,
    say: typeof obj.say === 'string' ? obj.say.trim() : '',
    task_id: obj.task_id ? String(obj.task_id).trim() : null,
    title: obj.title ? String(obj.title).trim() : null,
    description: typeof obj.description === 'string' ? obj.description.trim() : '',
    assignee_name: obj.assignee_name ? String(obj.assignee_name).trim() : null,
    priority: PRIORITIES.includes(obj.priority) ? obj.priority : null,
    status: STATUSES.includes(obj.status) ? obj.status : null,
    due_date_raw: obj.due_date_raw ? String(obj.due_date_raw).trim() : null,
    navigate: {
      target: NAV_TARGETS.includes(nav.target) ? nav.target : null,
      person: nav.person ? String(nav.person).trim() : null,
      status: STATUSES.includes(nav.status) ? nav.status : null,
      priority: PRIORITIES.includes(nav.priority) ? nav.priority : null,
      query: nav.query ? String(nav.query).trim() : null,
    },
  }
}

export { STATUSES, PRIORITIES }
