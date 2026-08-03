// The visible half of "the AI operates the app": the small motion primitives that
// make an agent-driven change look like someone doing it, rather than the screen
// teleporting to its final state.
//
// Surfaces own *what* changes (React state). This module owns *how it looks* while
// it changes — scrolling the field into view, ringing it, typing the value in one
// character at a time, flashing a button as it is pressed.
//
// WHY bother, given the data would be correct either way: the whole product claim is
// that the user can watch and trust what the assistant did. A form that fills
// instantly is indistinguishable from a page reload — there is nothing to follow and
// nothing to interrupt. Pacing is the feature.
//
// Every primitive degrades to an instant, correct result: `prefers-reduced-motion`,
// a detached element, or VA_PACE=0 all skip straight to the end state. Nothing here
// may ever be load-bearing for correctness.
import { log } from './agentBus'

// Global pace multiplier. 1 = designed speed; 0 = instant (used by tests and by
// users who turn "show me what you're doing" off). Live-tunable from the console
// via localStorage so a demo can be slowed down without a rebuild.
const paceFactor = (): number => {
  try {
    const raw = localStorage.getItem('va_pace')
    if (raw !== null) return Math.max(0, Number(raw) || 0)
  } catch { /* storage disabled */ }
  return 1
}

const reducedMotion = (): boolean => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

// Effective delay for a designed duration, after pace + accessibility settings.
const scaled = (ms: number): number => (reducedMotion() ? 0 : Math.round(ms * paceFactor()))

export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const d = scaled(ms)
    if (d <= 0) return resolve()
    setTimeout(resolve, d)
  })

const isAttached = (el: Element | null | undefined): el is HTMLElement =>
  !!el && el instanceof HTMLElement && el.isConnected

// Wait for React to actually commit the state a previous step set.
//
// This is REAL time, deliberately not `pause()`: pause is scaled by the pace
// setting and collapses to zero under prefers-reduced-motion, so a step that typed
// a value and then submitted would read stale state for exactly the users who
// turned the animation off. Two frames — one for React to commit, one to paint.
export const settle = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

// ---- attention -------------------------------------------------------------

// Bring an element into view and mark it as the agent's current focus. Returns a
// cleanup that removes the ring, so a caller can hold focus across a multi-part step.
export async function focusEl(el: HTMLElement | null | undefined, opts: { select?: boolean } = {}): Promise<() => void> {
  if (!isAttached(el)) return () => {}
  try {
    el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' })
  } catch { /* jsdom / old WebView */ }
  el.classList.add('va-acting')
  await pause(180)
  try {
    // preventScroll: we already positioned it; letting focus scroll again fights
    // the smooth scroll above and lands the field half off-screen on Android.
    el.focus({ preventScroll: true })
    if (opts.select && 'select' in el) (el as HTMLInputElement).select()
  } catch { /* not focusable */ }
  return () => el.classList.remove('va-acting')
}

// Pulse an element to say "this is the thing I just made/changed".
export async function highlight(el: HTMLElement | null | undefined, ms = 2200): Promise<void> {
  if (!isAttached(el)) return
  try { el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' }) } catch {}
  el.classList.add('va-highlight')
  await pause(ms)
  el.classList.remove('va-highlight')
}

// Show a button being pressed. The *effect* is performed by the caller (a real React
// handler); this only renders the press, so a failed action still looks honest.
export async function flashPress(el: HTMLElement | null | undefined): Promise<void> {
  if (!isAttached(el)) return
  await focusEl(el)
  el.classList.add('va-press')
  await pause(220)
  el.classList.remove('va-press')
  el.classList.remove('va-acting')
}

// ---- typing ----------------------------------------------------------------

// Type `text` into a controlled field by calling `setValue` with growing prefixes.
//
// This drives React state, not the DOM node, which is why it works on any input,
// textarea or custom editor the surface chooses to back it with. The element is only
// used for the visible focus ring and caret.
//
// Long values are typed in chunks: 200 characters at ~18ms each is 3.6 seconds of
// nobody learning anything, so speed scales with length.
export async function typeInto(
  el: HTMLElement | null | undefined,
  text: string,
  setValue: (v: string) => void,
): Promise<void> {
  const value = String(text ?? '')
  const release = await focusEl(el, { select: true })
  setValue('')

  if (scaled(1) === 0 || !value) {
    setValue(value)
    release()
    return
  }

  // Keep the whole field under ~1.6s regardless of length.
  const budgetMs = 1600
  const perChar = 22
  const chunk = Math.max(1, Math.ceil((value.length * perChar) / budgetMs))

  for (let i = chunk; i < value.length; i += chunk) {
    setValue(value.slice(0, i))
    await pause(perChar * chunk)
  }
  setValue(value)
  await pause(120)
  release()
}

// Set a discrete value (dropdown, date, radio) with a beat either side so the change
// is legible. Discrete controls have nothing to animate — the pause *is* the signal.
export async function pickValue(
  el: HTMLElement | null | undefined,
  value: string,
  setValue: (v: string) => void,
): Promise<void> {
  const release = await focusEl(el)
  await pause(140)
  setValue(value)
  await pause(320)
  release()
}

// ---- element lookup (escape hatch) -----------------------------------------

// Find an element a surface exposed by name: <button data-va="tasks.submit">.
//
// This exists for the parts of a screen a surface legitimately cannot hand over as a
// ref — mostly rows rendered in a list, where the agent needs to point at "the task
// it just created". It is deliberately NOT the general interaction mechanism: nothing
// here clicks or types via the DOM, it only locates something to ring.
export function findVaEl(key: string, root: ParentNode = document): HTMLElement | null {
  const el = root.querySelector<HTMLElement>(`[data-va="${CSS.escape(key)}"]`)
  if (!el) log('ui', `no element for data-va="${key}"`)
  return el
}

// Poll for a `data-va` element that appears after a render (a freshly created row).
//
// Queries directly rather than via findVaEl: a miss on each 100ms tick is the normal
// state while waiting, and logging every one buries the single line that matters.
// A genuine miss is reported once, on timeout — which is a real outcome, not an
// error: a new task can legitimately fall outside the list's current filter.
export async function waitForVaEl(key: string, timeoutMs = 4000): Promise<HTMLElement | null> {
  const sel = `[data-va="${CSS.escape(key)}"]`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const el = document.querySelector<HTMLElement>(sel)
    if (el) return el
    await new Promise((r) => setTimeout(r, 100))   // real time, not paced
  }
  log('ui', `no element for data-va="${key}" after ${timeoutMs}ms`)
  return null
}
