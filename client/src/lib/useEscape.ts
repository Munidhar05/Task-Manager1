import { useEffect, useRef } from 'react'
import { lockBodyScroll, unlockBodyScroll } from './scrollLock'

// Calls `onClose` when the user presses Escape. Used by modals/drawers so desktop
// users can dismiss them with the keyboard (mobile uses the Android back handler).
// `lockScroll` defaults on because every caller today is a full-screen modal, and
// a modal that lets the page drift behind it is the bug this exists to stop. A
// future non-modal user of the Escape key should pass false.
export function useEscape(onClose: () => void, lockScroll = true) {
  const ref = useRef(onClose)
  useEffect(() => { ref.current = onClose }, [onClose])
  useEffect(() => {
    if (!lockScroll) return
    lockBodyScroll()
    return () => unlockBodyScroll()
  }, [lockScroll])
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])
}
