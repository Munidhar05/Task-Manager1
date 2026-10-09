import React, { useEffect, useRef, useState } from 'react'
import { subscribeConfirm, resolveConfirm, PendingConfirm } from '../lib/confirm'

// Renders the active confirm dialog (one at a time). Esc cancels. Enter confirms
// only for benign dialogs — on a danger dialog a stray Enter must never delete,
// so there Enter is inert and Cancel takes the initial focus instead. Tab and
// Shift+Tab stay on its two buttons: it is modal, and it can be raised from
// inside another dialog, whose own Tab trap stands aside while it is up.
export default function ConfirmHost() {
  const [c, setC] = useState<PendingConfirm | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  // What asked the question gets focus back when it is answered. Taken in the
  // subscription, which runs the moment confirmDialog() is called — before the
  // dialog renders and its autoFocus moves focus onto its own button. Without
  // it focus fell to <body> on every answer, and Tab then walked the page
  // behind the dialog that asked (a task drawer, the chat info panel).
  const askedFrom = useRef<HTMLElement | null>(null)
  useEffect(() => subscribeConfirm((next) => {
    if (next) { if (!askedFrom.current) askedFrom.current = document.activeElement as HTMLElement | null }
    else { const el = askedFrom.current; askedFrom.current = null; if (el?.isConnected) el.focus() }
    setC(next)
  }), [])
  useEffect(() => {
    if (!c) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); resolveConfirm(false); return }
      // A ringing call is painted over this dialog: it is the top layer, so Tab
      // and Enter are the call's, not this question's hidden buttons.
      if (document.querySelector('.call-ringer')) return
      if (e.key === 'Enter' && !c.danger) { e.preventDefault(); resolveConfirm(true) }
      else if (e.key === 'Tab') {
        const buttons = Array.from(boxRef.current?.querySelectorAll<HTMLElement>('button') || [])
        if (!buttons.length) return
        const at = buttons.indexOf(document.activeElement as HTMLElement)
        e.preventDefault()
        buttons[at < 0 ? 0 : (at + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [c])
  if (!c) return null
  return (
    <div className="modal-center confirm-center" onClick={() => resolveConfirm(false)}>
      <div className="modal confirm-modal" ref={boxRef} onClick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label={c.title || 'Confirm'}>
        <div className="confirm-body">
          <div className={'confirm-icon' + (c.danger ? ' danger' : '')}>
            {c.danger
              ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12" y2="17" /></svg>
              : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="11" x2="12" y2="16" /><line x1="12" y1="8" x2="12" y2="8" /></svg>}
          </div>
          <div style={{ minWidth: 0 }}>
            {c.title && <h3 className="confirm-title">{c.title}</h3>}
            <p className="confirm-message">{c.message}</p>
          </div>
        </div>
        <div className="confirm-actions">
          <button className="btn" onClick={() => resolveConfirm(false)} autoFocus={!!c.danger}>{c.cancelText || 'Cancel'}</button>
          <button className={'btn ' + (c.danger ? 'btn-danger-solid' : 'btn-primary')} onClick={() => resolveConfirm(true)} autoFocus={!c.danger}>
            {c.confirmText || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
