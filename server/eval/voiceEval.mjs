// Voice-router regression eval — run BEFORE shipping any prompt or model change.
//
//   cd server && npm run eval:voice
//
// Replays the utterances in eval/cases.json through the real agent loop
// (ai/voiceAgent.js → live OpenRouter) against the current database and scores
// whether each one routed to the expected tool with the expected arguments.
// Reads only — the agent's lookups are SELECTs and nothing here executes actions —
// but point DB_PATH at a copy anyway if you want complete isolation.
//
// Grading per case:
//   tool      — exact tool name ("tool"), or any of a set ("tool_any")
//   args      — case-insensitive equality on listed arg values
//   args_re   — case-insensitive regex test on listed arg values
//   task_like — a task whose title contains this substring must exist AND be the
//               task_id the agent chose. Grounded in real data, so a case whose
//               anchor task no longer exists is SKIPPED, not failed — refresh
//               cases.json as the dataset evolves.
//   min_steps — for plans: at least this many steps
//
// LLM routing is not perfectly deterministic, so the gate is a pass-RATE
// (EVAL_THRESHOLD, default 0.85), not perfection. A drop below the threshold
// after a change means the change regressed real commands: don't ship it.
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { db } from '../src/db.js'
import { agentCommand } from '../src/ai/voiceAgent.js'

const CASES = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'))
const THRESHOLD = Number(process.env.EVAL_THRESHOLD) || 0.85

// Same scoping the real route applies (routes/assistant.js commandScopedTasks).
function scopedTasks(user) {
  const rows = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.due_date, t.assignee_id,
           u.name AS assignee_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.org_id = ? AND t.parent_task_id IS NULL
    ORDER BY t.updated_at DESC
  `).all(user.org_id)
  return user.role === 'employee' ? rows.filter((t) => t.assignee_id === user.id) : rows
}

const userFor = (role) => db.prepare('SELECT * FROM users WHERE role=? ORDER BY created_at LIMIT 1').get(role)

let pass = 0, fail = 0, skip = 0
const failures = []

for (const c of CASES) {
  const user = userFor(c.as)
  if (!user) { skip++; console.log(`SKIP  (no ${c.as} in DB)  "${c.say}"`); continue }
  const tasks = scopedTasks(user)
  const people = db.prepare("SELECT id, name, role, aliases FROM users WHERE org_id=? AND role != 'admin'").all(user.org_id)

  const t0 = Date.now()
  let call
  try {
    call = await agentCommand(c.say, { user, tasks, users: people, history: [] })
  } catch (err) {
    fail++; failures.push(c.say)
    console.log(`FAIL  [threw: ${err.message}]  "${c.say}"`)
    continue
  }
  const ms = Date.now() - t0
  const e = c.expect
  const problems = []

  if (e.tool && call.tool !== e.tool) problems.push(`tool=${call.tool} wanted ${e.tool}`)
  if (e.tool_any && !e.tool_any.includes(call.tool)) problems.push(`tool=${call.tool} wanted one of ${e.tool_any.join('/')}`)
  for (const [k, v] of Object.entries(e.args || {})) {
    if (String(call.args?.[k] ?? '').toLowerCase() !== String(v).toLowerCase()) problems.push(`${k}="${call.args?.[k]}" wanted "${v}"`)
  }
  for (const [k, v] of Object.entries(e.args_re || {})) {
    if (!new RegExp(v, 'i').test(String(call.args?.[k] ?? ''))) problems.push(`${k}="${call.args?.[k]}" !~ /${v}/i`)
  }
  if (e.task_like) {
    const anchor = tasks.find((t) => t.title.toLowerCase().includes(e.task_like.toLowerCase()))
    if (!anchor) { skip++; console.log(`SKIP  (no task like "${e.task_like}")  "${c.say}"`); continue }
    if (call.args?.task_id !== anchor.id) problems.push(`task_id=${call.args?.task_id} wanted ${anchor.id} ("${anchor.title.slice(0, 30)}…")`)
  }
  if (e.min_steps && !(Array.isArray(call.args?.steps) && call.args.steps.length >= e.min_steps)) {
    problems.push(`steps=${call.args?.steps?.length ?? 0} wanted >=${e.min_steps}`)
  }

  if (problems.length) {
    fail++; failures.push(c.say)
    console.log(`FAIL  [${problems.join('; ')}]  (${ms}ms)  "${c.say}"`)
  } else {
    pass++
    console.log(`pass  ${String(call.tool).padEnd(22)} (${ms}ms)  "${c.say}"`)
  }
}

const graded = pass + fail
const rate = graded ? pass / graded : 0
console.log(`\n${pass}/${graded} passed (${(rate * 100).toFixed(0)}%), ${skip} skipped — threshold ${(THRESHOLD * 100).toFixed(0)}%`)
if (failures.length) console.log('failed:', failures.map((s) => `"${s}"`).join(', '))
process.exit(rate >= THRESHOLD ? 0 : 1)
