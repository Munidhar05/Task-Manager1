// The UI surface registry — the contract between the agent and the application's
// screens.
//
// A "surface" is a named bundle of imperative capabilities that a mounted React
// component publishes about itself: the new-task modal publishes `open`, `setField`,
// `submit`; the task list publishes `filter`, `highlight`. The Action Engine calls
// those capabilities. It never queries the DOM for a button to click.
//
// WHY not drive the DOM directly, which is the obvious reading of "the AI clicks
// buttons like a human": this app's forms are controlled React inputs. Setting
// `input.value` does not update React state — you have to reach through the native
// value setter and dispatch a synthetic `input` event, and that breaks the moment a
// field switches to a custom component (the priority control here is already a
// bespoke popup, not a <select>). DOM-driving would make every UI refactor silently
// break the assistant, with no type-checking and no build-time signal.
//
// Surfaces give the same *visible* result — real state updates, real re-renders, the
// user watching fields fill in — while the compiler tells us when a capability is
// gone. The visible theatre (focus rings, character-by-character typing, button
// flashes) is layered on top by uiController.ts, which the surface calls into.
//
// Extensibility: adding a capability is `registerSurface(...)` in the component plus
// one tool entry. Nothing in the agent core changes.
import { useEffect, useRef } from 'react'
import { log } from './agentBus'

// Capabilities are async by nature — most of them animate, and the engine must not
// race ahead to the next step while a field is still typing itself in.
export type Capability = (args?: any) => Promise<any> | any
export type Surface = Record<string, Capability>

const surfaces = new Map<string, Surface>()
// Resolvers parked by `awaitSurface` for a surface that has not mounted yet.
const waiters = new Map<string, Set<(s: Surface) => void>>()

export function registerSurface(name: string, surface: Surface): () => void {
  surfaces.set(name, surface)
  log('registry', `surface up: ${name} [${Object.keys(surface).join(', ')}]`)
  const parked = waiters.get(name)
  if (parked) {
    waiters.delete(name)
    for (const resolve of parked) resolve(surface)
  }
  return () => {
    // Only remove if we are still the current occupant. A remount can register the
    // replacement before the old instance's cleanup runs, and blindly deleting
    // would drop the live surface.
    if (surfaces.get(name) === surface) {
      surfaces.delete(name)
      log('registry', `surface down: ${name}`)
    }
  }
}

export const getSurface = (name: string): Surface | null => surfaces.get(name) || null

export const listSurfaces = (): { name: string; capabilities: string[] }[] =>
  [...surfaces.entries()].map(([name, s]) => ({ name, capabilities: Object.keys(s) }))

// Wait for a surface to mount. Navigation is asynchronous — the route changes, then
// React mounts the page, then the modal opens — so every step that targets a screen
// the agent has just opened has to wait for it rather than assume it is there.
export function awaitSurface(name: string, timeoutMs = 8000): Promise<Surface> {
  const existing = surfaces.get(name)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const set = waiters.get(name) || new Set()
    waiters.set(name, set)
    const onReady = (s: Surface) => { clearTimeout(timer); resolve(s) }
    set.add(onReady)
    const timer = setTimeout(() => {
      set.delete(onReady)
      reject(new Error(`the ${name.replace(/\./g, ' ')} screen didn't open in time`))
    }, timeoutMs)
  })
}

// Call one capability, with a clear error when the screen or capability is missing —
// these messages are spoken to the user, so they read as sentences, not stack traces.
export async function invoke(surfaceName: string, capability: string, args?: any): Promise<any> {
  const surface = await awaitSurface(surfaceName)
  const fn = surface[capability]
  if (typeof fn !== 'function') {
    throw new Error(`I can't do "${capability}" on this screen`)
  }
  return await fn(args)
}

// Register a surface for as long as the component is mounted.
//
// `surface` is captured in a ref rather than a dependency, so a component can pass a
// fresh object literal every render (the natural way to write it, closing over
// current state) without re-registering on every keystroke.
export function useSurface(name: string, surface: Surface, enabled = true): void {
  const ref = useRef(surface)
  ref.current = surface
  useEffect(() => {
    if (!enabled) return
    // The stable proxy always dispatches to the latest render's closures.
    const proxy = new Proxy({} as Surface, {
      get: (_t, key: string) => ref.current[key],
      has: (_t, key: string) => key in ref.current,
      ownKeys: () => Reflect.ownKeys(ref.current),
      getOwnPropertyDescriptor: (_t, key: string) =>
        Reflect.getOwnPropertyDescriptor(ref.current, key) || { configurable: true, enumerable: true },
    })
    return registerSurface(name, proxy)
  }, [name, enabled])
}
