// A remote MCP server, so Claude (claude.ai, Desktop, Cowork, mobile) can be
// pointed at this VoTask instance as a Custom Connector.
//
// WHY this exists on top of the REST API: an API key is enough for anything that
// can set a header — curl, a script, Claude Code. It is NOT enough for claude.ai,
// which connects from Anthropic's cloud and whose connector form takes a URL and
// (optionally) OAuth credentials. There is nowhere to paste a key. So the URL has
// to carry the credential, and the endpoint has to speak MCP rather than REST.
//
// TRANSPORT: Streamable HTTP (the 2025-03-26 replacement for HTTP+SSE). The spec
// permits a single JSON response instead of an SSE stream for each POST, which is
// what this does — every tool here answers in milliseconds, so there is no partial
// progress worth streaming and no reason to hold a connection open.
//
// AUTH — and its honest cost: the key sits in the connector URL. That is the same
// shape refused for the WebSocket endpoints in auth.js, and for the same reason it
// is worse than a header: URLs reach access logs, proxy logs and the connector's
// own stored config. It is accepted here only because the alternative is not a
// header — the connector has no header field — it is implementing OAuth 2.1 with
// dynamic client registration, which is the right long-term answer and a much
// bigger piece of work. Mitigation: mint a SEPARATE key for the connector and
// revoke it independently. Nothing else should ever use that key.
import { Router } from 'express'
import { db } from '../db.js'
import { isApiKey, userForApiKey, signToken } from '../auth.js'

const r = Router()

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'votask', title: 'VoTask', version: '1.0.0' }
// Mirrors the CHECK constraint on tasks.priority in db.js.
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']
const STATUSES = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened']

// MCP tool annotations. These are hints, not enforcement — the client uses them
// to decide what to confirm with the user before running. Marking the reads is
// what stops a client prompting for every list_tasks; marking delete_task
// destructive is what makes it prompt for the one that matters.
const ANNOTATIONS = {
  list_tasks: { readOnlyHint: true, openWorldHint: false },
  get_task: { readOnlyHint: true, openWorldHint: false },
  list_people: { readOnlyHint: true, openWorldHint: false },
  list_meetings: { readOnlyHint: true, openWorldHint: false },
  get_meeting: { readOnlyHint: true, openWorldHint: false },
  list_notifications: { readOnlyHint: true, openWorldHint: false },
  ask_votask: { readOnlyHint: true, openWorldHint: false },
  whoami: { readOnlyHint: true, openWorldHint: false },
  create_task: { destructiveHint: false, idempotentHint: false },
  update_task: { destructiveHint: false, idempotentHint: true },
  set_task_status: { destructiveHint: false, idempotentHint: true },
  add_comment: { destructiveHint: false, idempotentHint: false },
  mark_notifications_read: { destructiveHint: false, idempotentHint: true },
  // The two that cannot be walked back from a chat window.
  delete_task: { destructiveHint: true, idempotentHint: true },
  assign_meeting_tasks: { destructiveHint: true, idempotentHint: false },
}

// ---- JSON-RPC plumbing -----------------------------------------------------

const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
// A tool failure is a RESULT, not a protocol error: the model is meant to read it
// and adapt (ask for a name it can resolve, try a different filter). A JSON-RPC
// error would instead surface as a broken connector.
const toolText = (text, isError = false) => ({ content: [{ type: 'text', text }], isError })
const toolJson = (value) => toolText(JSON.stringify(value, null, 2))

// ---- the tools -------------------------------------------------------------
//
// Each one is answered by calling this server's OWN REST API over loopback with
// the caller's key, rather than by querying the database here.
//
// That looks indirect, and it is deliberate. The task visibility rules are not
// trivial — an employee sees their own work including private drafts, a manager
// sees the org, "assigned by me" replaces the clause rather than extending it —
// and they live in the route handlers. Re-implementing them here would create a
// second, invisible code path that a future change to the first would silently
// leave behind, which is exactly the failure this codebase avoids elsewhere by
// driving the real UI instead of calling the API twice. A loopback request costs
// under a millisecond and cannot drift.
const TOOLS = [
  {
    name: 'list_tasks',
    title: 'List tasks',
    description: 'List tasks in VoTask. Filter by status, priority, assignee or free text. Returns whatever the calling user is allowed to see.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: STATUSES },
        priority: { type: 'string', enum: PRIORITIES },
        assignee: { type: 'string', description: "A user id. Use list_people first if you only have a name." },
        q: { type: 'string', description: 'Free-text search over titles' },
        mine: { type: 'boolean', description: "Only the caller's own tasks" },
        limit: { type: 'number', description: 'Max rows to return (default 50)' },
      },
    },
    run: async (call, args) => {
      const qs = new URLSearchParams()
      for (const k of ['status', 'priority', 'assignee', 'q']) if (args[k]) qs.set(k, String(args[k]))
      if (args.mine) qs.set('mine', '1')
      const rows = await call(`/api/tasks?${qs}`)
      const limit = Math.min(Number(args.limit) || 50, 200)
      const list = (Array.isArray(rows) ? rows : rows.tasks || []).slice(0, limit)
      return toolJson(list.map((t) => ({
        id: t.id, title: t.title, status: t.status, priority: t.priority,
        due_date: t.due_date, assignee: t.assignee_name || t.assignee?.name || null,
        progress: t.progress,
      })))
    },
  },
  {
    name: 'list_people',
    title: 'List teammates',
    description: 'Everyone in the organization, with their ids and roles. Use this to turn a spoken name into the id that create_task and list_tasks need.',
    inputSchema: { type: 'object', properties: {} },
    run: async (call) => {
      const users = await call('/api/users')
      return toolJson((users || []).map((u) => ({ id: u.id, name: u.name, role: u.role })))
    },
  },
  {
    name: 'create_task',
    title: 'Create a task',
    description: "Create a task and assign it. ASK THE USER for the priority and the deadline before calling — do not guess them, and do not fall back to defaults on their behalf. This tool refuses the call if either is missing. Resolve the person with list_people first: a wrong assignee is not a recoverable mistake. If the user says they do not mind what the priority or deadline is, call again with use_defaults true.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        assignee_id: { type: 'string', description: 'From list_people. Omit to leave unassigned.' },
        priority: { type: 'string', enum: PRIORITIES, description: 'Ask the user; do not assume.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD. Ask the user; do not assume.' },
        use_defaults: { type: 'boolean', description: "Only after the user has said they don't mind. Medium priority, deadline derived from it." },
      },
      required: ['title'],
    },
    // Priority and deadline are enforced HERE, not just asked for in the
    // description above.
    //
    // A model reads "optional with a default" as permission to proceed, so the
    // task silently became Medium with a date nobody chose — and the first time
    // anyone noticed was when it turned up on someone's board with the wrong
    // urgency. A description alone does not fix that; it is advice the model may
    // reasonably skip when it thinks it is being efficient. Refusing the call is
    // what makes asking the only way through. `use_defaults` keeps that from
    // becoming a dead end when the user genuinely does not care.
    run: async (call, args) => {
      if (args.priority && !PRIORITIES.includes(args.priority)) {
        return toolText(`"${args.priority}" is not a priority. Use one of: ${PRIORITIES.join(', ')}.`, true)
      }
      const missing = []
      if (!args.priority) missing.push('the priority (Critical, High, Medium or Low)')
      if (!args.due_date) missing.push('the deadline (a date)')
      if (missing.length && !args.use_defaults) {
        // Presented as a numbered choice rather than an open question. "What
        // priority?" makes the user compose an answer; a list makes them pick one,
        // which is the nearest thing to a dropdown that a chat window offers.
        const ask = []
        if (!args.priority) ask.push('Priority — 1) Critical  2) High  3) Medium  4) Low')
        if (!args.due_date) ask.push('Deadline — a date (YYYY-MM-DD), or say "no deadline" and one will be derived')
        return toolText(
          'Nothing has been created yet. Ask the user to choose, showing these options verbatim:\n\n'
          + ask.map((l) => `  ${l}`).join('\n')
          + '\n\nThen call create_task again with their answer. If they say they do not mind, call again with use_defaults true.',
          true,
        )
      }

      const created = await call('/api/tasks', 'POST', {
        title: args.title, description: args.description || '',
        assignee_id: args.assignee_id || null,
        priority: args.priority || 'Medium',
        ...(args.due_date ? { due_date: args.due_date } : {}),
      })
      // Report what was actually stored, not what was asked for: the deadline may
      // have been derived from the priority, and the user should hear the real one.
      return toolJson({
        created: true,
        task: {
          id: created.id, title: created.title, priority: created.priority,
          due_date: created.due_date, status: created.status,
          assignee: created.assignee?.name || created.assignee_name || null,
        },
      })
    },
  },
  {
    name: 'set_task_status',
    title: 'Change a task status',
    description: 'Move a task to a new status. Get the id from list_tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string', enum: STATUSES },
      },
      required: ['task_id', 'status'],
    },
    run: async (call, args) => {
      await call(`/api/tasks/${encodeURIComponent(args.task_id)}/status`, 'POST', { status: args.status })
      return toolText(`Set ${args.task_id} to ${args.status}.`)
    },
  },
  {
    name: 'update_task',
    title: 'Edit a task',
    description: "Change an existing task's priority, owner, deadline, title, description or progress. Use this to re-prioritise (e.g. Critical to High) — creating a task is the only other place priority can be set. Status is NOT here: use set_task_status, so there is one way to move a task through its workflow.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'From list_tasks.' },
        priority: { type: 'string', enum: PRIORITIES },
        assignee_id: { type: 'string', description: 'From list_people. Empty string unassigns. The new owner is notified, and so is the previous one.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        title: { type: 'string' },
        description: { type: 'string' },
        progress: { type: 'number', description: '0-100' },
      },
      required: ['task_id'],
    },
    run: async (call, args) => {
      // Priority is CHECK-constrained in SQLite, so a typo would surface as a 500
      // rather than something the model can act on. Catch it here and say what is
      // allowed — the model can then retry without a round trip through an error.
      if (args.priority && !PRIORITIES.includes(args.priority)) {
        return toolText(`"${args.priority}" is not a priority. Use one of: ${PRIORITIES.join(', ')}.`, true)
      }
      const body = {}
      for (const f of ['priority', 'due_date', 'title', 'description']) if (args[f] != null && args[f] !== '') body[f] = args[f]
      // Deliberately separate: '' is a real instruction here (unassign), where for
      // the fields above it just means the caller left it blank.
      if (args.assignee_id != null) body.assignee_id = args.assignee_id || null
      if (args.progress != null) body.progress = Math.max(0, Math.min(100, Math.round(Number(args.progress))))
      if (!Object.keys(body).length) return toolText('Nothing to change — name at least one field.', true)

      const t = await call(`/api/tasks/${encodeURIComponent(args.task_id)}`, 'PATCH', body)
      return toolJson({
        updated: Object.keys(body),
        task: {
          id: t.id, title: t.title, status: t.status, priority: t.priority,
          due_date: t.due_date, assignee: t.assignee?.name || t.assignee_name || null, progress: t.progress,
        },
      })
    },
  },
  {
    name: 'get_task',
    title: 'Read one task',
    description: "Everything about a single task: description, owner, deadline, progress, comments, subtasks and where it came from. Use it before editing something you did not create, so you are changing what you think you are.",
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    run: async (call, args) => {
      const t = await call(`/api/tasks/${encodeURIComponent(args.task_id)}`)
      return toolJson({
        id: t.id, title: t.title, description: t.description, status: t.status, priority: t.priority,
        due_date: t.due_date, progress: t.progress,
        assignee: t.assignee?.name || t.assignee_name || null,
        assigned_by: t.assignedBy?.name || null,
        from_meeting: t.meeting_id || null,
        comments: (t.comments || []).map((c) => ({ by: c.user_name || c.author_name, at: c.created_at, body: c.body })),
        subtasks: (t.subtasks || []).map((x) => ({ id: x.id, title: x.title, status: x.status })),
      })
    },
  },
  {
    name: 'add_comment',
    title: 'Comment on a task',
    description: 'Add a comment to a task. This is a note on the work itself, visible to everyone who can see the task — it is not a chat message to a person.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, body: { type: 'string' } },
      required: ['task_id', 'body'],
    },
    run: async (call, args) => {
      await call(`/api/tasks/${encodeURIComponent(args.task_id)}/comments`, 'POST', { body: args.body })
      return toolText('Comment added.')
    },
  },
  {
    name: 'delete_task',
    title: 'Delete a task',
    description: "Delete a task permanently. There is no undo and no recycle bin — the row and its comments are gone. CONFIRM WITH THE USER FIRST, quoting the task's title back to them, and never delete more than they named. Prefer set_task_status to Done for work that is finished rather than unwanted.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'From list_tasks. Read it back to the user before calling.' },
      },
      required: ['task_id'],
    },
    run: async (call, args) => {
      // Read it first so the confirmation names the real task rather than an id,
      // and so a wrong id fails before anything is destroyed rather than after.
      const t = await call(`/api/tasks/${encodeURIComponent(args.task_id)}`)
      await call(`/api/tasks/${encodeURIComponent(args.task_id)}`, 'DELETE')
      return toolText(`Deleted "${t.title}". This cannot be undone.`)
    },
  },
  {
    name: 'list_notifications',
    title: 'My notifications',
    description: "The caller's own in-app notifications — assignments, approvals, reassignments. Use for 'what did I miss?'.",
    inputSchema: { type: 'object', properties: {} },
    run: async (call) => {
      const d = await call('/api/notifications')
      const rows = Array.isArray(d) ? d : d.notifications || []
      return toolJson(rows.slice(0, 40).map((n) => ({
        type: n.type, message: n.message, read: !!n.read, at: n.created_at, task_id: n.task_id,
      })))
    },
  },
  {
    name: 'mark_notifications_read',
    title: 'Clear notifications',
    description: "Mark all of the caller's notifications as read.",
    inputSchema: { type: 'object', properties: {} },
    run: async (call) => {
      await call('/api/notifications/read-all', 'POST', {})
      return toolText('All notifications marked read.')
    },
  },
  {
    name: 'assign_meeting_tasks',
    title: 'Assign a meeting\'s suggested tasks',
    description: "Turn a meeting's pending AI suggestions into real, assigned tasks. Every assignee is NOTIFIED immediately and this cannot be undone in bulk — read get_meeting first, tell the user how many tasks and which people, and get a yes. Suggestions with no owner are skipped rather than assigned to nobody.",
    inputSchema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Specific suggestion ids. Omit to assign every pending one.' },
      },
      required: ['meeting_id'],
    },
    run: async (call, args) => {
      const body = Array.isArray(args.ids) && args.ids.length ? { ids: args.ids } : {}
      const r = await call(`/api/meetings/${encodeURIComponent(args.meeting_id)}/assign`, 'POST', body)
      return toolJson({ assigned: r.assigned, skipped_no_owner: r.skipped })
    },
  },
  {
    name: 'list_meetings',
    title: 'List meetings',
    description: 'Recent meetings, with how many AI-suggested tasks are still awaiting review on each.',
    inputSchema: { type: 'object', properties: {} },
    run: async (call) => {
      const d = await call('/api/meetings')
      const rows = Array.isArray(d) ? d : d.meetings || []
      return toolJson(rows.slice(0, 25).map((m) => ({
        id: m.id, title: m.title, date: (m.meeting_date || '').slice(0, 10), pending_review: m.pending_count,
      })))
    },
  },
  {
    name: 'get_meeting',
    title: 'Read a meeting',
    description: "One meeting's summary, decisions, action items and the tasks it produced.",
    inputSchema: { type: 'object', properties: { meeting_id: { type: 'string' } }, required: ['meeting_id'] },
    run: async (call, args) => {
      const m = await call(`/api/meetings/${encodeURIComponent(args.meeting_id)}`)
      return toolJson({
        title: m.title, date: (m.meeting_date || '').slice(0, 10),
        summary: m.summary?.executive_summary, key_decisions: m.summary?.key_decisions,
        action_items: m.summary?.action_items, risks: m.summary?.risks, blockers: m.summary?.blockers,
        tasks: (m.tasks || []).map((t) => ({ title: t.title, assignee: t.assignee_name, status: t.status })),
        awaiting_review: (m.suggestions || []).filter((s) => s.status === 'pending').length,
      })
    },
  },
  {
    name: 'ask_votask',
    title: 'Ask VoTask a question',
    description: "Ask about the team's work in plain language — 'who is overloaded', 'what slipped this week', 'how is the B2B site going'. Answered by VoTask's own assistant against the live data, so prefer it over assembling an answer from list_tasks when the question is analytical.",
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    run: async (call, args) => {
      const d = await call('/api/assistant/query', 'POST', { query: args.question })
      return toolJson({ answer: d.answer, tasks: (d.tasks || []).map((t) => ({ title: t.title, assignee: t.assignee_name, status: t.status, due_date: t.due_date })) })
    },
  },
  {
    name: 'whoami',
    title: 'Who am I',
    description: 'The account this connector is acting as, and its role. Worth calling once if a permission error is confusing.',
    inputSchema: { type: 'object', properties: {} },
    run: async (call) => toolJson(await call('/api/auth/me')),
  },
]

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

// Call this server's own REST API as the key's owner. See the note above TOOLS.
//
// The loopback request carries a SESSION token for that user, not the connector
// key — a connector key is deliberately refused by the REST API (auth.js), which
// is the whole point of scoping it, and that refusal applies to us too.
//
// A session token also satisfies requireSession, i.e. it could in principle reach
// /api/keys and mint credentials. Nothing here can: the model picks a tool name,
// never a URL, and every path is a literal inside the tool that owns it. The
// allowlist makes that structural rather than incidental, so a future tool taking
// a caller-supplied path could not quietly become an escalation.
const LOOPBACK_ALLOWED = new RegExp('^/api/(tasks|users|meetings|notifications|assistant/query|auth/me)(/|[?]|$)')

function loopbackCaller(user) {
  const base = `http://127.0.0.1:${process.env.PORT || 4000}`
  const session = signToken(user)
  return async (path, method = 'GET', body) => {
    if (!LOOPBACK_ALLOWED.test(path)) throw new Error(`refused internal path: ${path}`)
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${session}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error || `${method} ${path} failed (${res.status})`)
    return data
  }
}

// ---- the endpoint ----------------------------------------------------------

// The key travels in the path. Everything below assumes it is a bearer secret and
// treats a miss as 401 without saying which part was wrong.
//
// Both scopes are accepted: 'mcp' is what the UI mints for a connector, and 'full'
// is allowed so an existing key still works. The asymmetry is the point — a
// connector key is refused by the REST API (auth.js), so the credential exposed in
// a URL can only ever reach these eight tools.
function keyOwner(token) {
  if (!isApiKey(token)) return null
  return userForApiKey(token, { allowScopes: ['mcp', 'full'] })?.user || null
}

// Rate limit, per key prefix + IP. Guessing a 256-bit key is not the threat this
// answers — nobody guesses those. It answers a leaked URL being hammered, and a
// bad actor using a public endpoint to make this server do work for free.
const HITS = new Map()
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 120
function rateLimited(bucket) {
  const now = Date.now()
  const hit = HITS.get(bucket)
  if (!hit || now - hit.start >= WINDOW_MS) { HITS.set(bucket, { start: now, n: 1 }); return false }
  hit.n++
  // Bound the map so a spray of distinct buckets can't grow it without limit.
  if (HITS.size > 5000) for (const [k, v] of HITS) if (now - v.start >= WINDOW_MS) HITS.delete(k)
  return hit.n > MAX_PER_WINDOW
}

async function handle(msg, user) {
  const { id, method, params } = msg || {}

  if (method === 'initialize') {
    return rpcOk(id, {
      // Echo the client's version when we can speak it, else offer ours and let
      // the client decide — the lifecycle spec's negotiation, not a hard match.
      protocolVersion: params?.protocolVersion === PROTOCOL_VERSION ? PROTOCOL_VERSION : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'VoTask is this team\'s task manager. Resolve people with list_people before assigning work, and prefer ask_votask for analytical questions about the team.',
    })
  }
  if (method === 'ping') return rpcOk(id, {})
  if (method === 'tools/list') {
    return rpcOk(id, {
      tools: TOOLS.map(({ name, title, description, inputSchema }) => ({
        name, title, description, inputSchema, ...(ANNOTATIONS[name] ? { annotations: ANNOTATIONS[name] } : {}),
      })),
    })
  }
  if (method === 'tools/call') {
    const tool = TOOL_BY_NAME.get(params?.name)
    if (!tool) return rpcOk(id, toolText(`No such tool: ${params?.name}`, true))
    try {
      return rpcOk(id, await tool.run(loopbackCaller(user), params?.arguments || {}))
    } catch (err) {
      // Surfaced as a tool result so the model can read the reason and try again.
      return rpcOk(id, toolText(`That didn't work: ${err.message}`, true))
    }
  }
  return rpcErr(id, -32601, `Method not found: ${method}`)
}

r.post('/:token', async (req, res) => {
  // The key is in the URL, so it must never cross the network in the clear.
  // Render terminates TLS and forwards the original scheme in this header.
  if (process.env.NODE_ENV === 'production') {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    if (proto && proto !== 'https') return res.status(403).json({ error: 'HTTPS required' })
  }

  // DNS-rebinding guard from the transport spec. Anthropic's cloud sends no
  // Origin; a browser page trying to reach this would send its own.
  const origin = req.headers.origin
  if (origin && !/^https:\/\/([a-z0-9-]+\.)*claude\.(ai|com)$/i.test(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' })
  }

  if (rateLimited(`${req.params.token.slice(0, 22)}|${req.ip}`)) {
    return res.status(429).json({ error: 'Too many requests' })
  }

  const user = keyOwner(req.params.token)
  if (!user) return res.status(401).json({ error: 'Invalid, expired or revoked key' })

  const body = req.body
  // A notification or response carries no id and expects no answer.
  const isNotification = (m) => m && m.id === undefined
  if (Array.isArray(body)) {
    const replies = []
    for (const m of body) if (!isNotification(m)) replies.push(await handle(m, user))
    return replies.length ? res.json(replies) : res.status(202).end()
  }
  if (isNotification(body)) return res.status(202).end()
  res.json(await handle(body, user))
})

// The spec allows a server to decline the server-initiated stream and session
// teardown. Nothing here pushes messages, and there is no session state to end.
r.get('/:token', (_req, res) => res.status(405).json({ error: 'This server does not offer an SSE stream' }))
r.delete('/:token', (_req, res) => res.status(405).json({ error: 'This server keeps no session state' }))

export default r
