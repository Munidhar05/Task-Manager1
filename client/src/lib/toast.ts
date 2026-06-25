// Tiny global toast bus. Any module can call toast.success/error/info without
// threading a hook through the tree; <ToastHost/> (mounted once in App) subscribes
// and renders them. Replaces the jarring native alert()/confirm() popups.

export type ToastKind = 'success' | 'error' | 'info'
export interface ToastItem { id: number; kind: ToastKind; text: string }

type Listener = (toasts: ToastItem[]) => void

let items: ToastItem[] = []
let listeners: Listener[] = []
let nextId = 1

const emit = () => { const snap = [...items]; listeners.forEach((l) => l(snap)) }

export function subscribeToasts(l: Listener): () => void {
  listeners.push(l)
  l([...items])
  return () => { listeners = listeners.filter((x) => x !== l) }
}

export function dismissToast(id: number) { items = items.filter((t) => t.id !== id); emit() }

function add(kind: ToastKind, text: string, ms: number) {
  const id = nextId++
  items = [...items, { id, kind, text }]
  emit()
  if (ms > 0) setTimeout(() => dismissToast(id), ms)
  return id
}

export const toast = {
  success: (text: string, ms = 3200) => add('success', text, ms),
  error: (text: string, ms = 5000) => add('error', text, ms),
  info: (text: string, ms = 3500) => add('info', text, ms),
}
