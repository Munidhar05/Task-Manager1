// The agent's nervous system: one event bus every voice component publishes to,
// and the running execution trace the panel renders.
//
// WHY a bus rather than prop-drilling or context: the pieces that need to talk are
// mounted in unrelated parts of the tree. `useVoiceAssistant` lives in App's Layout,
// the UI surfaces live inside Tasks/Meetings/Admin pages, and the trace is rendered
// by the assistant panel. Threading callbacks between them would couple every page
// to the assistant. A module-level emitter keeps the dependency one-way: pages
// register capabilities and never import the assistant.
//
// It is also the "observable execution log" the assistant needs to be debuggable —
// every step the agent takes lands here, in order, with timing, whether or not the
// UI is showing. `window.__va.trace()` dumps it from the console.

export type AgentPhase =
  | 'idle'
  | 'wake'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'planning'
  | 'executing'
  | 'awaiting-input'
  | 'confirming'
  | 'speaking'
  | 'completed'
  | 'error'

// One line in the visible "what I'm doing" list. `status` drives the icon: a step
// is created 'running' and settles to 'done' / 'failed' / 'skipped'.
export interface TraceStep {
  id: string
  label: string                 // user-facing, present tense: "Selecting Reddeppa…"
  status: 'running' | 'done' | 'failed' | 'skipped'
  detail?: string               // failure reason / extra context, shown small
  startedAt: number
  endedAt?: number
}

export interface AgentEvents {
  phase: { phase: AgentPhase }
  // A trace step was created or changed. Consumers re-read `getTrace()`.
  trace: { steps: TraceStep[] }
  // Free-form diagnostics — never rendered, only logged.
  log: { scope: string; message: string; data?: unknown }
}

type Handler<K extends keyof AgentEvents> = (payload: AgentEvents[K]) => void

// Erased to `any` inside the map: the per-event types are enforced at the `on` /
// `emit` boundary, and TypeScript can't prove a keyed lookup stays in step with a
// generic K without a cast at every use site.
const handlers = new Map<keyof AgentEvents, Set<(payload: any) => void>>()

export function on<K extends keyof AgentEvents>(event: K, fn: Handler<K>): () => void {
  let set = handlers.get(event)
  if (!set) { set = new Set(); handlers.set(event, set) }
  set.add(fn as (p: any) => void)
  return () => { set!.delete(fn as (p: any) => void) }
}

export function emit<K extends keyof AgentEvents>(event: K, payload: AgentEvents[K]): void {
  const set = handlers.get(event)
  if (!set) return
  // Copy before iterating: a handler that unsubscribes itself (the common React
  // cleanup case) would otherwise mutate the set mid-iteration.
  for (const fn of [...set]) {
    try { fn(payload) } catch (err) { console.error(`[agentBus] ${event} handler threw`, err) }
  }
}

// ---- execution trace -------------------------------------------------------

let steps: TraceStep[] = []
let seq = 0

export const getTrace = () => steps

// Clear the trace at the start of a new turn so the user sees only what is
// happening now. The console log below keeps the previous turn recoverable.
export function resetTrace(reason = 'new turn'): void {
  if (steps.length) console.info(`[agent] trace cleared (${reason})`, steps)
  steps = []
  emit('trace', { steps })
}

// Open a step. Returns a handle that settles it — callers do
//   const s = step('Opening Tasks'); …; s.done()
// so a step can never be left dangling by an early return that forgets its id.
export function step(label: string) {
  const entry: TraceStep = { id: `s${++seq}`, label, status: 'running', startedAt: Date.now() }
  steps = [...steps, entry]
  emit('trace', { steps })
  console.info(`[agent] ▶ ${label}`)

  const settle = (status: TraceStep['status'], detail?: string) => {
    if (entry.endedAt) return                 // already settled; ignore double-calls
    entry.endedAt = Date.now()
    entry.status = status
    if (detail) entry.detail = detail
    steps = [...steps]
    emit('trace', { steps })
    const ms = entry.endedAt - entry.startedAt
    const mark = status === 'done' ? '✓' : status === 'failed' ? '✗' : '–'
    console.info(`[agent] ${mark} ${label} (${ms}ms)${detail ? ` — ${detail}` : ''}`)
  }

  return {
    id: entry.id,
    done: (detail?: string) => settle('done', detail),
    fail: (detail?: string) => settle('failed', detail),
    skip: (detail?: string) => settle('skipped', detail),
    // Retitle a running step — used when a step learns what it is actually doing
    // ("Selecting assignee…" → "Selecting Reddeppa Nakka…").
    relabel: (next: string) => { entry.label = next; steps = [...steps]; emit('trace', { steps }) },
  }
}

export type Step = ReturnType<typeof step>

export const log = (scope: string, message: string, data?: unknown) => {
  emit('log', { scope, message, data })
  console.info(`[agent:${scope}] ${message}`, data ?? '')
}

// Console handle for debugging a live session without React DevTools.
if (typeof window !== 'undefined') {
  ;(window as any).__va = { trace: getTrace, on, emit }
}
