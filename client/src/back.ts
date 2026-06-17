// Android hardware "back" coordination.
//
// Pages register a handler that returns true when it "consumes" a back press
// (e.g. it closed an open modal or panel). The global listener in App.tsx walks
// the stack top-first; if nothing consumes the press it falls back to route
// navigation, and only exits the app at the home screen. This stops the Android
// back button from quitting the whole app when the user just wants to step back.

type BackHandler = () => boolean

const stack: BackHandler[] = []

// Register a handler; returns an unregister function (use as a useEffect cleanup).
export function pushBackHandler(handler: BackHandler): () => void {
  stack.push(handler)
  return () => {
    const i = stack.lastIndexOf(handler)
    if (i >= 0) stack.splice(i, 1)
  }
}

// Run handlers most-recent first; stop at the first one that consumes the press.
export function runBackHandlers(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    try { if (stack[i]()) return true } catch { /* ignore a faulty handler */ }
  }
  return false
}
