// Promise-based confirm dialog bus — replaces blocking window.confirm(). Call
// `await confirmDialog({ message })` anywhere; <ConfirmHost/> renders the themed
// dialog and resolves the promise with the user's choice.

export interface ConfirmOptions {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}
export interface PendingConfirm extends ConfirmOptions { id: number; resolve: (v: boolean) => void }

type Listener = (c: PendingConfirm | null) => void

let current: PendingConfirm | null = null
let listeners: Listener[] = []
let nextId = 1

const emit = () => listeners.forEach((l) => l(current))

export function subscribeConfirm(l: Listener): () => void {
  listeners.push(l)
  l(current)
  return () => { listeners = listeners.filter((x) => x !== l) }
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (current) current.resolve(false) // supersede any open dialog
    current = { id: nextId++, ...opts, resolve }
    emit()
  })
}

export function resolveConfirm(value: boolean) {
  if (current) { const c = current; current = null; emit(); c.resolve(value) }
}

// Signing out is one tap from the sidebar and one from the profile, and it drops
// unsent work (a half-typed comment, an unsaved edit) with no undo. Both entry
// points ask through here so the wording can't drift apart, and so a third one
// added later gets the confirmation for free.
export const confirmLogout = () => confirmDialog({
  title: 'Log out?',
  message: "You'll need to sign in again to get back to your tasks. Anything you're part-way through typing will be lost.",
  confirmText: 'Log out',
  cancelText: 'Stay signed in',
  danger: true,
})
