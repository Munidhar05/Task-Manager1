import React, { useEffect, useState } from 'react'
import { subscribeToasts, dismissToast, ToastItem } from '../lib/toast'

// Renders the live toast stack. Mounted once near the app root.
const ICON: Record<string, React.ReactNode> = {
  success: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
  ),
  error: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="13" /><line x1="12" y1="16.5" x2="12" y2="16.5" /></svg>
  ),
  info: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="11" x2="12" y2="16" /><line x1="12" y1="8" x2="12" y2="8" /></svg>
  ),
}

export default function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([])
  useEffect(() => subscribeToasts(setItems), [])
  if (!items.length) return null
  return (
    <div className="toast-host" role="region" aria-live="polite" aria-label="Notifications">
      {items.map((t) => (
        // Errors are announced assertively so screen readers hear failures promptly.
        <button key={t.id} className={'toast toast-' + t.kind} onClick={() => dismissToast(t.id)} title="Dismiss"
          role={t.kind === 'error' ? 'alert' : undefined}>
          <span className="toast-icon">{ICON[t.kind]}</span>
          <span className="toast-text">{t.text}</span>
        </button>
      ))}
    </div>
  )
}
