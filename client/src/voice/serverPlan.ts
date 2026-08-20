// Adapter: the server's voice response → an Action Engine plan.
//
// WHY an adapter instead of teaching the server the new tool names: the server side
// of this already does the work that genuinely belongs on a server. It matches a
// spoken name against the org's alias table, enforces the caller's role, resolves
// task ids out of a ranked snapshot, parses "by Friday evening" into a date, and
// computes analytics in SQL rather than letting a model do arithmetic. None of that
// should move to the client, and rewriting the prompt to emit a different JSON shape
// would risk all of it for no gain.
//
// So the contract stays as it is, and this file re-expresses the result as a plan.
// The engine then applies the things that DO belong on the client — visible
// execution, the trace, slot-filling, the confirmation policy — uniformly, whether
// the action came back as one step or ten.
//
// The one place the mapping is not mechanical is `create_task`. Everything else is
// handed to `api_action`, which posts to the same endpoint the form posts to.
// A create is instead re-routed through the real New Task screen, because that is
// the workflow where watching it happen is worth something: the user sees which
// person was picked and which date was chosen, and can stop it, before the task
// exists. `api_action` remains the fallback if that screen is not reachable.
import type { ActionPlan } from './actionEngine'

export interface ServerResponse {
  // 'do' is the undo-first tier: a reversible mutation that runs immediately —
  // no yes/no — carrying its inverse in `undo` so a spoken "undo" can put it back.
  mode?: 'do' | 'confirm' | 'navigate' | 'answer' | 'clarify'
  say?: string
  action?: any
  // The inverse of `action`, computed server-side from the row's pre-change state.
  undo?: any
  navigate?: { url?: string }
  data?: any
  // Live-recording control. Present only for start_meeting / control_meeting.
  meeting?: { action: 'start' | 'pause' | 'resume' | 'stop' | 'finish'; title?: string | null }
}

export interface Bridged {
  // null when there is nothing to execute — an answer or a clarifying question,
  // which the conversation loop simply speaks.
  plan: ActionPlan | null
  say: string
  data?: any
  // A view change that accompanies an answer ("here are the overdue ones" while
  // opening the filtered list). Not a plan step: it is scenery for the reply.
  navigateUrl?: string
  // Present on mode:'do' — kept by the conversation loop until the next mutation,
  // so "undo" reverses the LAST thing done, not an arbitrary earlier one.
  undo?: any
}

// A single server action → one plan step.
//
// The kinds listed here have a tool that performs the workflow on screen. Anything
// not listed falls through to `api_action`, which posts to the same endpoint the UI
// would. That fallthrough is deliberate: a server tool can be added, or an existing
// one extended, without this file changing — it keeps working, just invisibly, and
// gets a visible tool later if it earns one.
const stepFor = (action: any) => {
  const b = action?.body || {}
  switch (action?.kind) {
    case 'create_task':
      return {
        tool: 'create_task',
        args: {
          title: b.title,
          description: b.description,
          assignee_id: b.assignee_id || null,
          priority: b.priority,
          due_date: b.due_date,
        },
      }
    case 'set_status':
      return { tool: 'set_status', args: { task_id: action.task_id, status: b.status, task_title: titleFrom(action.summary) } }
    case 'assign_task':
      return { tool: 'assign_task', args: { task_id: action.task_id, assignee_id: b.assignee_id, assignee_name: nameFrom(action.summary) } }
    case 'add_comment':
      return { tool: 'add_comment', args: { task_id: action.task_id, body: b.body } }
    case 'send_message':
      return { tool: 'send_message', args: { to_user_id: action.to_user_id, to_name: action.to_name, text: action.text } }
    default:
      return { tool: 'api_action', args: { action } }
  }
}

// The server's summary is the only place the human-readable task title and person
// name survive — the action body carries ids. Both are used for the spoken line and
// the trace label ONLY, so a miss degrades to a vaguer sentence, never a wrong edit.
const titleFrom = (summary?: string) => summary?.match(/"([^"]+)"/)?.[1] || null
const nameFrom = (summary?: string) => summary?.match(/\bto ([^"]+)$/)?.[1]?.trim() || null

// Turn a stored inverse action into a runnable plan. Deliberately routed through
// `api_action` rather than the on-screen workflow tools: an undo is "put it back,
// fast" — the user just watched the original happen and named it themselves, so
// replaying the drawer choreography would be theatre. (It also has to be
// api_action: an undo can restore "Unassigned", which the drawer tool's required
// assignee_id slot would refuse.)
export function undoPlan(undo: any): ActionPlan {
  // Undo summaries are phrased server-side to follow "I've …" ("put X back to
  // To Do"), so the spoken line reads as a sentence, not a log entry.
  const summary = String(undo?.summary || 'reversed that').trim()
  return {
    intent: 'undo',
    say: `Okay — I've ${summary}.`,
    steps: [{ tool: 'api_action', args: { action: undo } }],
  }
}

export function planFromServer(resp: ServerResponse | null | undefined): Bridged {
  const say = String(resp?.say || '').trim()
  const url = resp?.navigate?.url

  switch (resp?.mode) {
    // 'do' and 'confirm' build the same plan — the difference is trust tier, and
    // that is enforced where it always was: the tool table's `destructive`
    // predicates. 'do' additionally carries the inverse action for spoken undo.
    case 'do':
    case 'confirm': {
      const action = resp.action
      if (!action) return { plan: null, say, data: resp.data }

      // A batch arrives as one action of kind 'plan'. Flatten it into real steps so
      // each one gets its own trace line and its own confirmation if it needs one —
      // the old path confirmed the whole batch once and then ran ten mutations with
      // no further stopping point.
      const steps = action.kind === 'plan' && Array.isArray(action.steps)
        ? action.steps.map(stepFor)
        : [stepFor(action)]

      return {
        plan: { intent: action.kind, say, steps },
        say,
        data: resp.data,
        undo: resp.mode === 'do' ? resp.undo || null : null,
      }
    }

    case 'navigate': {
      // Meeting control is its own thing: `start` opens the recorder AND presses
      // Record (opening it alone left the assistant claiming to have started a
      // meeting while nothing captured), and pause/resume/stop/finish carry no url
      // at all, because navigating would unmount the recorder mid-session.
      const meeting = (resp as any).meeting
      if (meeting?.action === 'start') {
        return { plan: { intent: 'meeting', say, steps: [{ tool: 'start_meeting', args: { title: meeting.title || null } }] }, say, data: resp.data }
      }
      if (meeting?.action) {
        return { plan: { intent: 'meeting', say, steps: [{ tool: 'control_meeting', args: { action: meeting.action } }] }, say, data: resp.data }
      }

      const steps: { tool: string; args: Record<string, any> }[] = [{ tool: 'navigate_url', args: { url, label: say } }]
      // Administration opens on Overview. Every voice request that routes here is
      // about people ("add an employee", "remove someone"), so carry on to the
      // User Management tab rather than stopping one click short.
      if (url === '/admin') steps.push({ tool: 'admin_tab', args: { tab: 'users' } })
      return { plan: { intent: 'navigate', say, steps }, say, data: resp.data }
    }

    // 'answer' and 'clarify' carry no action — the figures were computed server-side
    // and the reply IS the result.
    default:
      return { plan: null, say, data: resp?.data, navigateUrl: url }
  }
}
