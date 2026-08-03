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
  mode?: 'confirm' | 'navigate' | 'answer' | 'clarify'
  say?: string
  action?: any
  navigate?: { url?: string }
  data?: any
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
}

// A single server action → one plan step.
const stepFor = (action: any) =>
  action?.kind === 'create_task'
    ? {
        tool: 'create_task',
        args: {
          title: action.body?.title,
          description: action.body?.description,
          assignee_id: action.body?.assignee_id || null,
          priority: action.body?.priority,
          due_date: action.body?.due_date,
        },
      }
    : { tool: 'api_action', args: { action } }

export function planFromServer(resp: ServerResponse | null | undefined): Bridged {
  const say = String(resp?.say || '').trim()
  const url = resp?.navigate?.url

  switch (resp?.mode) {
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
      }
    }

    case 'navigate':
      return {
        plan: { intent: 'navigate', say, steps: [{ tool: 'navigate_url', args: { url, label: say } }] },
        say,
        data: resp.data,
      }

    // 'answer' and 'clarify' carry no action — the figures were computed server-side
    // and the reply IS the result.
    default:
      return { plan: null, say, data: resp?.data, navigateUrl: url }
  }
}
