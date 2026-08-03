// The application's tool table — everything the agent is able to do, as data.
//
// This is the only place a capability is defined. The model is shown these names,
// the Action Engine validates against them, and the UI surfaces execute them. Adding
// "generate a report" means adding one entry here and one surface on the report page;
// no part of the engine, the conversation loop or the prompt builder changes.
//
// The important rule, and the reason this file exists at all: a tool is a *workflow*,
// not an API call. `create_task` does not POST /tasks — it opens the screen a person
// would open, fills the fields a person would fill, and presses the button a person
// would press. The user watches their own UI do the work, which is the entire product
// claim. The write still happens through the same endpoint the form always used, so
// permissions, notifications, category detection and audit logging are unchanged.
import { registerTools, type ToolDef, type ToolResult } from './actionEngine'
import { invoke, awaitSurface } from './uiRegistry'
import { pause } from './uiController'
import { api } from '../api'

const ok = (say?: string, data?: any): ToolResult => ({ ok: true, say, data })
const fail = (say: string, suggest?: ToolResult['suggest']): ToolResult => ({ ok: false, say, suggest })

// Route the agent takes for a given "show me X" request. Kept here rather than in the
// prompt so the model only has to name a target, not know the app's URL scheme.
const VIEW_URLS: Record<string, string> = {
  dashboard: '/',
  tasks: '/tasks',
  my_tasks: '/tasks?mine=1',
  overdue: '/tasks?view=overdue',
  completed: '/tasks?view=completed',
  active: '/tasks?view=active',
  meetings: '/meetings',
  chats: '/chats',
  leaderboard: '/leaderboard',
  admin: '/admin',
}

export const TOOLS: ToolDef[] = [
  {
    name: 'navigate',
    label: ({ target }) => `Opening ${String(target || 'that').replace(/_/g, ' ')}…`,
    requires: ['target'],
    prompts: { target: 'Which screen would you like me to open?' },
    run: async ({ target }, ctx) => {
      const url = VIEW_URLS[String(target)]
      if (!url) return fail(`I don't know a screen called "${target}".`)
      ctx.navigate(url)
      await pause(500)                    // let the route mount before the next step
      return ok()
    },
  },

  {
    name: 'create_task',
    label: ({ title }) => (title ? `Creating "${title}"…` : 'Creating the task…'),
    // Deliberately NOT requiring priority or due date: the form defaults both, and
    // interrogating the user for fields the app can decide is what makes assistants
    // tedious. Title and assignee are the two a wrong guess would get wrong.
    requires: ['title'],
    prompts: {
      title: 'What should the task be called?',
      assignee_name: 'Who should I assign it to?',
    },
    summarize: ({ title, assignee_name }) =>
      `Create "${title}"${assignee_name ? ` for ${assignee_name}` : ''}`,
    run: async ({ title, description, assignee_id, assignee_name, priority, due_date }, ctx) => {
      // 1. Get to the Tasks screen and open the form the human would use.
      ctx.navigate('/tasks')
      await awaitSurface('tasks')
      await invoke('tasks', 'openNew')
      const form = await awaitSurface('tasks.new')

      // 2. Resolve the person BEFORE typing anything. A name that matches nobody has
      // to become a question, and it is far less jarring to ask up front than to ask
      // after the user has watched half a form fill in.
      //
      // `assignee_id` arrives already resolved when the server's own name matching
      // succeeded (it has the alias table and the full org, which the client does
      // not). Only fall back to matching the spoken name here when it didn't.
      let assigneeId: string | null = assignee_id || null
      let assigneeName: string | null = assignee_id ? assignee_name || null : null
      if (!assigneeId && assignee_name) {
        const { match, candidates } = await form.resolveAssignee({ name: assignee_name })
        if (!match) {
          const alt = candidates[0]
          await invoke('tasks.new', 'cancel')
          return fail(
            `I couldn't find anyone called ${assignee_name}.`,
            alt
              ? { question: `I couldn't find ${assignee_name}. I found ${alt.name} — should I use them?`, patch: { assignee_name: alt.name } }
              : undefined,
          )
        }
        assigneeId = match.id
        assigneeName = match.name
      }

      // 3. Fill the form in the order a person reads it.
      await form.setTitle({ value: title })
      if (description) await form.setDescription({ value: description })
      if (priority) await form.setPriority({ value: priority })
      if (assigneeId) await form.setAssignee({ id: assigneeId })
      if (due_date) await form.setDueDate({ value: due_date })

      // The server resolves the person to an id but does not send the name back, so
      // read it off the form we just filled. Without this the agent reports "I've
      // created X" for an assignment it did make — technically true, but it drops
      // the one fact the user most needs to hear to know it picked the right person.
      if (assigneeId && !assigneeName) assigneeName = (await form.read())?.assignee_name || null

      // 4. Press Create, then point at the row that appeared.
      const created = await form.submit()
      if (!created?.id) return fail("The task didn't save — please check the form.")
      await invoke('tasks', 'highlightTask', { id: created.id }).catch(() => {})

      return ok(
        assigneeName
          ? `Done — I've assigned "${title}" to ${assigneeName}.`
          : `Done — I've created "${title}".`,
        { type: 'task', id: created.id },
      )
    },
  },

  {
    name: 'filter_tasks',
    label: ({ priority, status }) => `Filtering by ${[priority, status].filter(Boolean).join(' + ') || 'your criteria'}…`,
    run: async ({ priority, status, assignee }, ctx) => {
      ctx.navigate('/tasks')
      await invoke('tasks', 'filter', { priority, status, assignee })
      return ok()
    },
  },

  {
    name: 'open_task',
    label: () => 'Opening the task…',
    requires: ['task_id'],
    prompts: { task_id: 'Which task did you mean?' },
    run: async ({ task_id }, ctx) => {
      ctx.navigate('/tasks')
      await invoke('tasks', 'openTask', { id: task_id })
      return ok()
    },
  },

  // ---- bridge tools --------------------------------------------------------
  // The server's voice router already resolves a spoken command into a concrete
  // action: it matched the name against the org's alias table, checked the role,
  // found the task id, parsed "by Friday" into a date. Throwing that away to
  // re-derive it on the client would be a downgrade, so these two tools carry a
  // server-resolved action into the engine and get the trace, the confirmation
  // policy and the recovery flow applied to it uniformly.

  {
    name: 'navigate_url',
    label: ({ label }) => `Opening ${label || 'that'}…`,
    requires: ['url'],
    run: async ({ url }, ctx) => {
      ctx.navigate(url)
      await pause(420)
      return ok()
    },
  },

  {
    name: 'api_action',
    label: ({ action }) => {
      const s = action?.summary
      return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}…` : 'Applying that…'
    },
    requires: ['action'],
    // Only the actions you cannot walk back. A status change or a comment is
    // visible, reversible, and the user just asked for it out loud — making those
    // a two-turn "shall I?" is the thing that makes assistants tiring to use.
    // Deleting, removing a teammate and sending a message to a human are all
    // one-way doors, so those still stop and ask.
    destructive: ({ action }) => ['delete_task', 'remove_user', 'send_message'].includes(action?.kind),
    summarize: ({ action }) => {
      const s = action?.summary || 'apply that change'
      return s.charAt(0).toUpperCase() + s.slice(1)
    },
    confirmMeta: ({ action }) => ({ needsPassword: action?.kind === 'remove_user' }),
    run: async ({ action, password }, ctx) => {
      await runAction(action, password)
      // Refresh whatever the change touched and land the user where the result is.
      // Mirrors what the old direct-execution path did, so the lists behind the
      // assistant never show stale data after a voice edit.
      if (action.kind === 'remove_user') {
        window.dispatchEvent(new CustomEvent('users-changed'))
        ctx.navigate('/admin')
      } else if (action.kind === 'send_message') {
        window.dispatchEvent(new Event('chat-unread-changed'))
        ctx.navigate('/chats')
      } else {
        window.dispatchEvent(new CustomEvent('tasks-changed'))
        ctx.navigate('/tasks')
        if (action.task_id) await invoke('tasks', 'highlightTask', { id: action.task_id }).catch(() => {})
      }
      return ok()
    },
  },
]

// Execute one server-resolved action against the endpoints the UI itself uses, so
// permissions, notifications, category detection and audit logging are identical to
// a change made by hand.
async function runAction(action: any, password?: string): Promise<void> {
  switch (action.kind) {
    case 'create_task': await api.post('/tasks', action.body); break
    case 'set_status': await api.post(`/tasks/${action.task_id}/status`, action.body); break
    case 'add_comment': await api.post(`/tasks/${action.task_id}/comments`, action.body); break
    case 'delete_task': await api.del(`/tasks/${action.task_id}`); break
    case 'send_message': {
      const conv: any = await api.post('/chat/conversations', { type: 'direct', userId: action.to_user_id })
      await api.post(`/chat/conversations/${conv.id}/messages`, { body: action.text })
      break
    }
    case 'remove_user': {
      // Re-auth first: a spoken command must never be sufficient on its own to
      // delete a colleague's account.
      await api.post('/auth/verify-password', { password })
      await api.del(`/users/${action.to_user_id}`)
      break
    }
    // update_task / assign_task and friends all PATCH the task's fields.
    default: await api.patch(`/tasks/${action.task_id}`, action.body)
  }
}

registerTools(TOOLS)
