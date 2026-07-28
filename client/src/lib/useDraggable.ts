import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

// Makes a `position: fixed` element draggable anywhere in the viewport, with the
// spot remembered per-device. Pointer events (not mouse events) so one code path
// covers mouse, touch and pen.
//
// The element keeps whatever corner its CSS anchors it to until the user actually
// moves it — only then do we switch to inline left/top. That way there's no layout
// flash on first paint and the default position stays a pure CSS concern.

export type DragPos = { x: number; y: number }

const MARGIN = 12   // px of viewport the element can never be dragged past
const SLOP = 4      // px of travel before a press counts as a drag rather than a tap
const NUDGE = 8     // px moved per arrow key (×3 with Shift) — keyboard equivalent of dragging

function clamp(p: DragPos, w: number, h: number): DragPos {
  const maxX = Math.max(MARGIN, window.innerWidth - w - MARGIN)
  const maxY = Math.max(MARGIN, window.innerHeight - h - MARGIN)
  return { x: Math.min(Math.max(p.x, MARGIN), maxX), y: Math.min(Math.max(p.y, MARGIN), maxY) }
}

function readPos(key: string): DragPos | null {
  try {
    const p = JSON.parse(localStorage.getItem(key) || 'null')
    if (p && typeof p.x === 'number' && typeof p.y === 'number') return p
  } catch { /* storage off or corrupt — fall back to the CSS default corner */ }
  return null
}

export function useDraggable({ storageKey, enabled = true }: { storageKey: string; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<DragPos | null>(() => readPos(storageKey))
  const [dragging, setDragging] = useState(false)
  const posRef = useRef(pos)
  posRef.current = pos
  // Where the press started + the grab offset inside the element, so the element
  // doesn't jump to centre itself under the cursor.
  const start = useRef({ px: 0, py: 0, dx: 0, dy: 0 })
  const moved = useRef(false)        // has this press passed the slop yet?
  const justDragged = useRef(false)  // set on release, so the trailing click can be swallowed

  const persist = useCallback((p: DragPos) => {
    try { localStorage.setItem(storageKey, JSON.stringify(p)) } catch { /* storage off — position is session-only */ }
  }, [storageKey])

  // A spot saved on a larger window (or before a rotate) can land off-canvas —
  // pull it back inside on mount and on every resize.
  const reclamp = useCallback(() => {
    const el = ref.current
    if (!el) return
    setPos((p) => (p ? clamp(p, el.offsetWidth, el.offsetHeight) : p))
  }, [])
  useLayoutEffect(() => { if (enabled) reclamp() }, [enabled, reclamp])
  useEffect(() => {
    if (!enabled) return
    window.addEventListener('resize', reclamp)
    return () => window.removeEventListener('resize', reclamp)
  }, [enabled, reclamp])

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    const el = ref.current
    if (!el || e.button !== 0) return
    const r = el.getBoundingClientRect()
    start.current = { px: e.clientX, py: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top }
    moved.current = false
    justDragged.current = false
    setDragging(true)
    // Capture so the drag survives the pointer leaving the element (fast flicks).
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* unsupported — plain events still work */ }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const el = ref.current
    if (!dragging || !el) return
    // Under the slop this is still a tap: leave the element alone so a click opens it.
    if (!moved.current && Math.hypot(e.clientX - start.current.px, e.clientY - start.current.py) < SLOP) return
    moved.current = true
    setPos(clamp({ x: e.clientX - start.current.dx, y: e.clientY - start.current.dy }, el.offsetWidth, el.offsetHeight))
  }

  const endDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (!dragging) return
    setDragging(false)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* never captured */ }
    justDragged.current = moved.current
    if (moved.current && posRef.current) persist(posRef.current)  // one write per drop, not per frame
  }

  // Arrow keys move it too, so the position isn't mouse-only. Reads the live rect,
  // which means it also works from the un-dragged CSS default corner.
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const el = ref.current
    if (!el) return
    const step = e.shiftKey ? NUDGE * 3 : NUDGE
    const delta: Record<string, [number, number]> = {
      ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0],
    }
    const d = delta[e.key]
    if (!d) return
    e.preventDefault()  // otherwise the arrow keys scroll the page behind it
    const r = el.getBoundingClientRect()
    const next = clamp({ x: r.left + d[0], y: r.top + d[1] }, r.width, r.height)
    setPos(next)
    persist(next)
  }

  const reset = useCallback(() => {
    setPos(null)
    try { localStorage.removeItem(storageKey) } catch { /* storage off */ }
  }, [storageKey])

  return {
    /** Attach to the element being moved (must be `position: fixed`). */
    ref,
    dragging,
    /** Spread onto the drag handle. Empty when disabled, so nothing is bound. */
    handleProps: enabled
      ? { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, onKeyDown }
      : {},
    /** Inline position once moved; undefined keeps the element on its CSS corner. */
    style: enabled && pos
      ? ({ left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } as React.CSSProperties)
      : undefined,
    pos: enabled ? pos : null,
    /** True if the last release was a drag — call from onClick to swallow that click. */
    consumeClick: () => { const was = justDragged.current; justDragged.current = false; return was },
    /** Send it back to its default corner and forget the saved spot. */
    reset,
  }
}
