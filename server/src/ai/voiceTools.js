// Voice assistant TOOL REGISTRY — the thing the router LLM chooses from.
//
// Each tool declares who may call it, what it needs, and how it behaves:
//   kind 'mutate'   -> changes data; the client confirms before executing
//   kind 'navigate' -> moves the UI; runs immediately
//   kind 'read'     -> answers/report; runs immediately (numbers come from SQL)
//
// Adding a capability = one entry here + one case in the route's dispatcher. The
// old design hard-coded 8 intents in a prompt, so "edit this task", "yesterday's
// overview" and "start a meeting" simply had nowhere to land and got declined.
import { callOpenRouter, callClaude, callOpenAI, parseJson } from './voiceTask.js'

const STATUSES = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened']
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']
const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'custom']

const ALL = ['manager', 'admin', 'employee']
const MGR = ['manager', 'admin']

export const TOOLS = [
  // ---- tasks: create & edit ------------------------------------------------
  { name: 'create_task', kind: 'mutate', roles: ALL,
    desc: 'Create a new task.',
    args: 'title (short, English), description, assignee_name|null, priority (' + PRIORITIES.join('|') + '), due_date_raw (deadline exactly as spoken, or null)' },

  { name: 'update_task', kind: 'mutate', roles: ALL,
    desc: "Edit an EXISTING task's details: rename it, change its description, due date, priority, or progress. Use this for 'edit', 'rename', 'change the due date', 'set progress to 50%'.",
    args: 'task_id, and any of: title, description, due_date_raw, priority, progress (0-100)' },

  { name: 'set_status', kind: 'mutate', roles: ALL,
    desc: "Change a task's status. 'mark done'/'complete' => Done.",
    args: 'task_id, status (' + STATUSES.join('|') + ')' },

  { name: 'assign_task', kind: 'mutate', roles: ALL,
    desc: 'Assign or reassign an existing task to a person.',
    args: 'task_id, assignee_name' },

  { name: 'add_comment', kind: 'mutate', roles: ALL,
    desc: 'Add a comment/note to a task.',
    args: 'task_id, body' },

  { name: 'delete_task', kind: 'mutate', roles: MGR,
    desc: 'Delete a task permanently.',
    args: 'task_id' },

  // ---- chats (the Chats section — real 1:1 messages, NOT task comments) -----
  { name: 'send_message', kind: 'mutate', roles: ALL,
    desc: "Send a DIRECT CHAT MESSAGE to a teammate in the Chats section — this is real person-to-person messaging, NOT a task comment. Use whenever the user says 'message X', 'tell X in chat', 'send X a message', 'ping X', 'message him/her personally'. If they mention a task, weave it into the message text.",
    args: 'recipient_name, body (the message to send, phrased naturally in English)' },

  // ---- views ---------------------------------------------------------------
  { name: 'navigate', kind: 'navigate', roles: ALL,
    desc: 'Open a screen or a filtered task list. Use for "show/open/go to".',
    args: 'target (overdue|completed|active|all|my_tasks|dashboard|meetings|chats|person|status|priority), person, status, priority' },

  // ---- analytics (numbers computed in SQL, never by you) --------------------
  { name: 'get_overview', kind: 'read', roles: ALL,
    desc: "Metrics for a period: how many tasks were created/assigned/completed, and how many are overdue/blocked now. Use for 'yesterday's overview', 'how did we do this week', 'summary of today'.",
    args: 'period (' + PERIODS.join('|') + '), from/to (YYYY-MM-DD, only when period=custom)' },

  { name: 'get_workload', kind: 'read', roles: MGR,
    desc: "Open task counts per person. Use for 'who is overloaded', 'what is Sameer working on'.",
    args: 'assignee_name|null (null = whole team)' },

  { name: 'group_tasks', kind: 'read', roles: ALL,
    desc: "Group/bucket tasks and report the counts. Use for 'group the overdue tasks', 'break down tasks by priority'. Also opens the matching filtered list.",
    args: 'group_by (assignee|status|priority), overdue (true/false), status, priority, person' },

  // ---- meetings (manager/admin only) ---------------------------------------
  { name: 'start_meeting', kind: 'navigate', roles: MGR,
    desc: "Begin recording a new live meeting. Use for 'start a meeting', 'record a meeting', 'begin the standup'.",
    args: '(none)' },

  { name: 'open_meeting', kind: 'navigate', roles: MGR,
    desc: "Open a specific meeting's page. Use for 'open the marketing meeting', 'show me the last meeting'.",
    args: 'title, date (YYYY-MM-DD), latest (true for the most recent)' },

  { name: 'summarize_meeting', kind: 'read', roles: MGR,
    desc: "Recap what a meeting covered/decided. Use for 'summarize the last meeting', 'what happened in the marketing meeting'.",
    args: 'title, date (YYYY-MM-DD), latest (true for the most recent)' },

  { name: 'list_meetings', kind: 'read', roles: MGR,
    desc: "How many meetings there are and which is most recent. Use for 'what meetings do we have'.",
    args: '(none)' },

  // ---- knowledge -----------------------------------------------------------
  { name: 'ask', kind: 'read', roles: ALL,
    desc: 'Answer an open question about tasks, meetings, decisions, or chat history by searching the workspace. Use this when the user asks something that is not a direct command and no other tool fits.',
    args: 'question (the user\'s question, rephrased in full)' },

  { name: 'clarify', kind: 'read', roles: ALL,
    desc: 'You need more information (which task? who?). Ask one short question.',
    args: 'question' },
]

export const toolByName = (n) => TOOLS.find((t) => t.name === n) || null
export const toolsFor = (role) => TOOLS.filter((t) => t.roles.includes(role))

// A specific, spoken reason for a role-restricted tool.
const DENIAL = {
  start_meeting: 'Only managers can start a meeting.',
  open_meeting: 'Only managers can open meetings.',
  summarize_meeting: 'Only managers can see meeting summaries.',
  list_meetings: 'Only managers can see the meeting list.',
  get_workload: "Only managers can see the team's workload — I can show you your own tasks.",
  delete_task: 'Only managers can delete tasks.',
}
const denialFor = (name) => DENIAL[name] || "You don't have access to that."

const today = () => new Date().toISOString().slice(0, 10)

function systemPrompt(user) {
  const allowed = toolsFor(user.role)
  const denied = TOOLS.filter((t) => !t.roles.includes(user.role))
  const lines = allowed.map((t) => `- ${t.name}(${t.args})\n    ${t.desc}`).join('\n')
  // Name the forbidden tools explicitly so the model reports a precise reason
  // ("Only managers can start meetings") instead of a vague deflection.
  const deniedNote = denied.length
    ? `\nRESTRICTED — this user's role may NOT use these: ${denied.map((t) => t.name).join(', ')}.
If they ask for one, reply with {"tool":"denied","args":{"wanted":"<that tool name>"},"say":""} and nothing else.`
    : ''
  const scope = user.role === 'employee'
    ? 'This user is an EMPLOYEE: the snapshot lists ONLY their own tasks. Never reference other people\'s tasks.'
    : `This user is a ${user.role} and may act on any task or person in the organization.`

  return `You are "BTM", the voice controller inside SmartTask, a team task manager. Convert the user's latest utterance into EXACTLY ONE tool call.

The user may speak English, Hindi, Telugu, or a code-mixed blend. Always write task titles, descriptions and your "say" reply in clear ENGLISH.

${scope}
Today is ${today()}. The user is ${user.name} (${user.role}).

AVAILABLE TOOLS:
${lines}${deniedNote}

RULES:
- Pick the single best tool. Never invent a tool name.
- CHATS vs COMMENTS: "message / tell / ping / text someone (in chat / personally)" means a real chat message → use send_message. Only use add_comment when they explicitly say "comment on the task" or "add a note to the task".
- When a tool targets an existing task, copy its exact id from the snapshot into task_id. If several tasks plausibly match, use "clarify" and name the top options. If none match, use "clarify".
- NEVER compute or guess numbers/metrics yourself — call get_overview / get_workload / group_tasks and let the system count.
- If the request is a question rather than a command, use "ask".
- "say" is one short, natural spoken sentence. For mutate tools it should read like you are about to do it (the app adds a yes/no step). For read tools, leave "say" empty — the system supplies the real answer.

Respond with ONLY a JSON object, no markdown fences:
{"tool":"<name>","args":{...},"say":"..."}`
}

// Beyond this many tasks the prompt is ranked down to the ones that could
// plausibly be referenced — a big org would otherwise pay for (and be slowed by)
// hundreds of irrelevant rows in every single utterance.
const MAX_SNAPSHOT_TASKS = 40

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'my', 'me', 'is', 'it', 'that', 'this', 'task', 'tasks', 'please'])
const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)) || []

// Rank by how well a task's title matches what was said, then by recency
// (`tasks` arrives newest-first), keeping overdue work visible.
function rankTasks(tasks, transcript) {
  if (tasks.length <= MAX_SNAPSHOT_TASKS) return tasks
  const q = new Set(words(transcript))
  const t0 = today()
  const scored = tasks.map((t, i) => {
    const overlap = words(t.title).filter((w) => q.has(w)).length
    const recency = 1 - i / tasks.length              // 0..1, newest highest
    const overdue = t.due_date && t.due_date < t0 && t.status !== 'Done' ? 0.5 : 0
    return { t, score: overlap * 5 + recency + overdue }
  })
  scored.sort((a, b) => b.score - a.score)
  const kept = scored.slice(0, MAX_SNAPSHOT_TASKS).map((s) => s.t)
  console.log(`[voiceTools] snapshot trimmed ${tasks.length} -> ${kept.length} tasks by relevance`)
  return kept
}

function snapshot(tasks, users, user, transcript) {
  const t0 = today()
  const shown = rankTasks(tasks, transcript)
  const taskLines = shown.map((t) => {
    const bits = [`id=${t.id}`, `"${t.title}"`, `owner=${t.assignee_name || 'Unassigned'}`, `status=${t.status}`, `priority=${t.priority}`]
    if (t.due_date) bits.push(`due=${t.due_date}${t.due_date < t0 && t.status !== 'Done' ? ' OVERDUE' : ''}`)
    return '- ' + bits.join(' | ')
  })
  const omitted = tasks.length > shown.length
    ? `\n(${tasks.length - shown.length} less-relevant tasks not listed — ask the user to name one if unsure.)` : ''
  const people = user.role === 'employee' ? ''
    : '\n\nTEAM:\n' + users.map((u) => `- ${u.name}${u.role ? ` (${u.role})` : ''}`).join('\n')
  return `TASKS (${taskLines.length} of ${tasks.length}):\n${taskLines.join('\n') || '(none)'}${omitted}${people}`
}

function historyBlock(history) {
  if (!Array.isArray(history) || !history.length) return ''
  const turns = history
    .filter((m) => m && typeof m.text === 'string' && m.text.trim() && (m.role === 'user' || m.role === 'ai'))
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'BTM'}: ${m.text.trim()}`)
  return turns.length ? `\n\nCONVERSATION SO FAR:\n${turns.join('\n')}` : ''
}

// Route one utterance to a tool. Returns { tool, args, say }. Falls back to a
// clarify tool if the model picks something unknown or forbidden.
export async function routeCommand(transcript, { user, tasks = [], users = [], history = [], onUsage } = {}) {
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY
  const hasClaude = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI = !!process.env.OPENAI_API_KEY
  if (!hasOpenRouter && !hasClaude && !hasOpenAI) throw new Error('No LLM configured')

  const system = systemPrompt(user)
  const userMsg = `${snapshot(tasks, users, user, transcript)}${historyBlock(history)}\n\nUSER JUST SAID: ${transcript}`

  const providers = [
    hasOpenRouter && { name: 'OpenRouter', call: callOpenRouter },
    hasClaude && { name: 'Claude', call: callClaude },
    hasOpenAI && { name: 'OpenAI', call: callOpenAI },
  ].filter(Boolean)
  let raw, lastErr
  for (const p of providers) {
    try { raw = await p.call(system, userMsg, onUsage); if (raw) break }
    catch (err) { lastErr = err; console.warn(`[voiceTools] ${p.name} failed, trying next:`, err.message) }
  }
  if (raw === undefined) throw lastErr || new Error('All providers failed')

  const obj = parseJson(raw) || {}

  // Explicit refusal the model was told to emit for a restricted tool.
  if (obj.tool === 'denied') return { tool: 'denied', args: {}, say: denialFor(obj.args?.wanted) }

  const spec = toolByName(obj.tool)
  // Unknown tool, or one this role may not use -> degrade gracefully.
  if (!spec) return { tool: 'clarify', args: { question: obj.say || '' }, say: obj.say || '' }
  // Belt and braces: never execute a tool the role can't use, even if asked to.
  if (!spec.roles.includes(user.role)) return { tool: 'denied', args: {}, say: denialFor(spec.name) }
  return { tool: spec.name, kind: spec.kind, args: obj.args || {}, say: typeof obj.say === 'string' ? obj.say.trim() : '' }
}

export { STATUSES, PRIORITIES, PERIODS }
