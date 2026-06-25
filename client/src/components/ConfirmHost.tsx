import React, { useEffect, useState } from 'react'
import { subscribeConfirm, resolveConfirm, PendingConfirm } from '../lib/confirm'

// Renders the active confirm dialog (one at a time). Esc cancels, Enter confirms.
export default function ConfirmHost() {
  const [c, setC] = useState<PendingConfirm | null>(null)
  useEffect(() => subscribeConfirm(setC), [])
  useEffect(() => {
    if (!c) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); resolveConfirm(false) }
      else if (e.key === 'Enter') { e.preventDefault(); resolveConfirm(true) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [c])
  if (!c) return null
  return (
    <div className="modal-center" onClick={() => resolveConfirm(false)}>
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label={c.title || 'Confirm'}>
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
          <button className="btn" onClick={() => resolveConfirm(false)}>{c.cancelText || 'Cancel'}</button>
          <button className={'btn ' + (c.danger ? 'btn-danger-solid' : 'btn-primary')} onClick={() => resolveConfirm(true)} autoFocus>
            {c.confirmText || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
