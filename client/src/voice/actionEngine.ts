// The Action Engine: the layer between the language model and the application.
//
//   LLM  ──▶  structured plan (JSON)  ──▶  [Action Engine]  ──▶  UI surfaces ──▶ APIs
//
// The model's only job is to choose tools and fill their arguments. It never decides
// what to click, never sees the DOM, and cannot invent a capability — an unknown tool
// name is rejected here rather than half-executed. Everything the agent is actually
// able to do is the tool table in tools.ts, which is data, so adding a capability
// never touches this file.
//
// The engine owns the four things a plan runner has to get right:
//
//  1. SLOT FILLING. A step whose required arguments are incomplete suspends the plan
//     and returns the question to ask. The conversation loop asks it, patches the
//     answer in, and resumes at the same step — so "assign a task to Reddeppa" can
//     become a three-turn dialogue without the model having to re-derive the whole
//     plan from a transcript that keeps growing.
//  2. CONFIRMATION. Destructive steps suspend before running, never after. The check
//     is a property of the tool, not a phrase the model produced, so a model that
//     forgets to ask still cannot delete anything silently.
//  3. RECOVERY. A tool that fails with a concrete alternative ("no Reddeppa; there is
//     a Reddeppa Nakka") suspends with that as a yes/no rather than aborting.
//  4. NARRATION. Every step opens a trace entry before it runs and settles it after,
//     so the panel shows the plan progressing and a failure is attributed to the step
//     that failed rather than to the whole request.
//
// Suspension is modelled as a return value (`Suspended`) rather than an await on some
// promise the loop resolves. That keeps the engine free of conversation state: it can
// be resumed on a later turn, after a reload, or from a button press, and the caller
// decides how the answer was obtained (spoken, tapped, or defaulted).
import { step, log, emit } from './agentBus'

export interface PlanStep {
  tool: string
  args?: Record<string, any>
}

export interface ActionPlan {
  intent?: string
  say?: string
  steps: PlanStep[]
}

// What a tool hands back. `say` is spoken; `data` is rendered as a card.
export type ToolResult = {
  ok: boolean
  say?: string
  data?: any
  // A failed tool can offer one concrete fix instead of just an error. The engine
  // turns it into a yes/no and, on "yes", retries the same step with `patch` applied.
  suggest?: { question: string; patch: Record<string, any> }
  // Stand the assistant down after this step instead of re-opening the mic for
  // another command. Set by the tools that hand the microphone to something else
  // — starting or resuming a meeting recording — where staying live would have the
  // two listeners compete for the same speech. The engine only carries the flag;
  // the conversation loop decides what ending a session means.
  endSession?: boolean
}

export interface ToolContext {
  // Everything a tool needs from the app, injected rather than imported, so tools
  // stay testable and the engine has no React dependency.
  navigate: (url: string) => void
  say: (text: string) => Promise<void>
  user: { id: string; name: string; role: string } | null
}

export interface ToolDef {
  name: string
  // Trace label, present tense: "Selecting Reddeppa…". Gets the resolved args.
  label: (args: Record<string, any>) => string
  // Arguments that must be present (and non-empty) before the step may run.
  requires?: string[]
  // The question to ask for each required argument that is missing.
  prompts?: Record<string, string>
  // Ask before running. Use for anything the user cannot undo from the UI.
  //
  // A predicate, not just a flag, because one tool can carry actions of very
  // different weight: the generic `api_action` runs both "set this task to Done"
  // (trivially reversible, and the user is watching) and "delete this task"
  // (gone). Deciding from the args keeps the confirmation on the second without
  // making the first a two-turn conversation.
  destructive?: boolean | ((args: Record<string, any>) => boolean)
  // One sentence describing the pending action, for the confirmation card.
  summarize?: (args: Record<string, any>) => string
  // Extra facts the confirmation UI needs. Today that is `needsPassword`, for
  // removing a teammate: the answer to "shall I?" is not enough on its own, and a
  // password must be TYPED — asking for one by voice would have the user read their
  // credentials aloud and put them through speech-to-text.
  confirmMeta?: (args: Record<string, any>) => Record<string, any>
  run: (args: Record<string, any>, ctx: ToolContext) => Promise<ToolResult>
}

// ---- tool table ------------------------------------------------------------

const tools = new Map<string, ToolDef>()

export function registerTool(def: ToolDef): void {
  if (tools.has(def.name)) log('engine', `tool "${def.name}" redefined`)
  tools.set(def.name, def)
}

export const registerTools = (defs: ToolDef[]) => defs.forEach(registerTool)
export const getTool = (name: string) => tools.get(name) || null
export const describeTools = () => [...tools.keys()]

// ---- suspension ------------------------------------------------------------

// Where to pick the plan back up. `index` is the step that has NOT yet run.
export interface Resume {
  plan: ActionPlan
  index: number
  // Args accumulated for the suspended step: the model's originals plus whatever
  // slot-filling and recovery have added since.
  patch: Record<string, any>
  collected: ToolResult[]
}

export type Outcome =
  | { status: 'done'; results: ToolResult[]; say: string; data?: any }
  // The engine needs something before it can continue. `kind` tells the caller how
  // to interpret the user's next utterance: free text vs. yes/no.
  | { status: 'suspended'; kind: 'slot' | 'confirm' | 'recover'; question: string; slot?: string; summary?: string; meta?: Record<string, any>; resume: Resume }
  | { status: 'failed'; say: string; results: ToolResult[] }

const isBlank = (v: any) => v === undefined || v === null || (typeof v === 'string' && !v.trim())

// ---- execution -------------------------------------------------------------

export async function runPlan(plan: ActionPlan, ctx: ToolContext): Promise<Outcome> {
  return resumePlan({ plan, index: 0, patch: {}, collected: [] }, ctx)
}

// Continue (or start) a plan. Called again after every suspension.
export async function resumePlan(resume: Resume, ctx: ToolContext): Promise<Outcome> {
  const { plan } = resume
  const results = [...resume.collected]
  let patch = { ...resume.patch }

  for (let i = resume.index; i < plan.steps.length; i++) {
    const planned = plan.steps[i]
    const def = tools.get(planned.tool)

    // An unknown tool is a model error, not a user error. Fail the plan rather than
    // guessing at what was meant — a wrong guess here mutates real data.
    if (!def) {
      log('engine', `unknown tool "${planned.tool}" — plan aborted`)
      return { status: 'failed', say: "I'm not able to do that yet.", results }
    }

    // Args for THIS step are the model's, overlaid with anything collected since we
    // suspended on it. The patch belongs to one step only, so clear it once used.
    const args = { ...(planned.args || {}), ...patch }
    const suspendHere = (rest: Omit<Extract<Outcome, { status: 'suspended' }>, 'status' | 'resume'>): Outcome => ({
      status: 'suspended',
      ...rest,
      resume: { plan, index: i, patch: args, collected: results },
    })

    // 1. Slot filling — ask for the first missing required argument.
    const missing = (def.requires || []).find((k) => isBlank(args[k]))
    if (missing) {
      const question = def.prompts?.[missing] || `What ${missing.replace(/_/g, ' ')} should I use?`
      log('engine', `step ${i} (${def.name}) missing "${missing}" — asking`)
      return suspendHere({ kind: 'slot', question, slot: missing })
    }

    // 2. Confirmation — before, never after.
    const needsConfirm = typeof def.destructive === 'function' ? def.destructive(args) : !!def.destructive
    if (needsConfirm && !args.__confirmed) {
      const summary = def.summarize?.(args) || def.label(args)
      log('engine', `step ${i} (${def.name}) needs confirmation`)
      return suspendHere({ kind: 'confirm', question: `${summary}. Shall I go ahead?`, summary, meta: def.confirmMeta?.(args) })
    }

    // 3. Run it.
    const s = step(def.label(args))
    let result: ToolResult
    try {
      result = await def.run(args, ctx)
    } catch (err: any) {
      const detail = err?.message || 'something went wrong'
      s.fail(detail)
      return { status: 'failed', say: `I couldn't ${def.label(args).replace(/…$/, '').toLowerCase()} — ${detail}.`, results }
    }

    if (!result.ok) {
      // 4. Recovery — a failure that came with a concrete alternative becomes a
      // question rather than a dead end.
      if (result.suggest) {
        s.skip(result.say || 'needs a decision')
        log('engine', `step ${i} (${def.name}) offering recovery`)
        return {
          status: 'suspended',
          kind: 'recover',
          question: result.suggest.question,
          resume: { plan, index: i, patch: { ...args, ...result.suggest.patch }, collected: results },
        }
      }
      s.fail(result.say)
      return { status: 'failed', say: result.say || "That didn't work.", results }
    }

    s.done()
    results.push(result)
    patch = {}                       // consumed; the next step starts from the model's args
  }

  // The plan's own `say` describes the whole intent; a single-step plan prefers the
  // tool's own sentence, which is more specific ("3 overdue tasks" beats "Done").
  const last = results[results.length - 1]
  const say = (results.length === 1 && last?.say) || plan.say || last?.say || 'Done.'
  emit('phase', { phase: 'completed' })
  return { status: 'done', results, say, data: results.find((r) => r.data)?.data }
}

// Apply a spoken answer to a suspended plan and continue.
//
// `answer` is the raw transcript for a slot, or the resolved boolean for a yes/no.
// A declined confirmation ends the plan rather than skipping the step — "no, don't
// delete it" means stop, not "carry on with the rest of the batch".
export async function answerAndResume(
  suspended: Extract<Outcome, { status: 'suspended' }>,
  answer: string | boolean,
  ctx: ToolContext,
  // Anything the confirmation UI collected alongside the yes — currently a typed
  // password. Merged into the step's args, so the tool reads it like any other.
  extra?: Record<string, any>,
): Promise<Outcome> {
  const { kind, slot, resume } = suspended

  if (kind === 'slot') {
    if (typeof answer !== 'string' || !answer.trim()) {
      return { status: 'failed', say: "I still need that before I can continue.", results: resume.collected }
    }
    return resumePlan({ ...resume, patch: { ...resume.patch, [slot!]: answer.trim() } }, ctx)
  }

  // confirm / recover are both yes/no.
  if (answer !== true) {
    log('engine', `user declined at step ${resume.index}`)
    return { status: 'done', results: resume.collected, say: 'Okay, cancelled.' }
  }
  // `__confirmed` rides along in the patch so the same step does not re-ask when the
  // engine reaches it again.
  return resumePlan({ ...resume, patch: { ...resume.patch, ...extra, __confirmed: true } }, ctx)
}
