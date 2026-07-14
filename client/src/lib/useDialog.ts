import { useEffect, useRef } from 'react'

// Accessibility hook for modal dialogs. Attach the returned ref to the dialog
// container and it will:
//   • close on Escape,
//   • trap Tab focus inside the dialog (so keyboard users can't tab out to the
//     page behind it),
//   • move focus into the dialog on open, and
//   • restore focus to the previously-focused element on close.
// Pair with role="dialog" (or "alertdialog") + aria-modal="true" on the container.
export function useDialog<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T | null>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])

  useEffect(() => {
    const prevActive = document.activeElement as HTMLElement | null

    const selector = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
    // Query the LIVE node each time — the dialog's content can swap (skeleton →
    // loaded), so a node captured at mount would go stale.
    const focusables = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(selector) || [])
      .filter((el) => el.offsetParent !== null || el === document.activeElement)

    // Move focus into the dialog (first field, else the dialog itself).
    const first = focusables()[0]
    if (first) first.focus()
    else if (ref.current) { ref.current.setAttribute('tabindex', '-1'); ref.current.focus() }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const firstEl = items[0], lastEl = items[items.length - 1]
      const active = document.activeElement as HTMLElement
      if (e.shiftKey && (active === firstEl || !ref.current?.contains(active))) { e.preventDefault(); lastEl.focus() }
      else if (!e.shiftKey && active === lastEl) { e.preventDefault(); firstEl.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      // Restore focus to whatever opened the dialog.
      if (prevActive && typeof prevActive.focus === 'function') prevActive.focus()
    }
  }, [])

  return ref
}
