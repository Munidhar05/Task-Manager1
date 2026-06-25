import { useEffect, useRef } from 'react'

// Calls `onClose` when the user presses Escape. Used by modals/drawers so desktop
// users can dismiss them with the keyboard (mobile uses the Android back handler).
export function useEscape(onClose: () => void) {
  const ref = useRef(onClose)
  useEffect(() => { ref.current = onClose }, [onClose])
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])
}
