// Stops the page behind an overlay from scrolling.
//
// The overlay covers the screen but is not itself scrollable, so a wheel or a
// swipe that isn't over the drawer's own scroller falls through to the document
// — and reaching the end of the drawer chains into it too. Either way the page
// creeps along behind, and closing the overlay leaves you somewhere you never
// meant to go.
//
// Reference-counted, because overlays stack: a confirm dialog opened from inside
// the task drawer must not unlock the page when only IT closes. The count is what
// makes "locked while ANY overlay is open" true rather than "while the last one
// that happened to run is open".

let depth = 0
let prevOverflow: string[] = ['', '']   // [html, body], restored in the same order
let prevPadding = ''

// BOTH elements, because which one scrolls is not fixed. On desktop it is
// documentElement; on phones the stylesheet sets `html, body { overflow-x: hidden }`,
// and a non-visible overflow-x forces overflow-y to compute as `auto` — so body
// becomes the scroller and locking documentElement alone does nothing. Measured,
// not assumed: at 420px the document reports zero scrollable height while the page
// still scrolls.
const roots = () => [document.documentElement, document.body]

export function lockBodyScroll(): void {
  if (depth++ > 0) return
  const [html, body] = roots()
  // Hiding the scrollbar narrows the viewport, and the page jumps sideways.
  // Replace its width with padding so nothing moves.
  const barWidth = window.innerWidth - html.clientWidth
  prevOverflow = [html.style.overflow, body.style.overflow]
  prevPadding = html.style.paddingRight
  html.style.overflow = 'hidden'
  body.style.overflow = 'hidden'
  if (barWidth > 0) html.style.paddingRight = barWidth + 'px'
}

export function unlockBodyScroll(): void {
  if (depth === 0) return          // defensive: never unlock more than we locked
  if (--depth > 0) return
  const [html, body] = roots()
  html.style.overflow = prevOverflow[0]
  body.style.overflow = prevOverflow[1]
  html.style.paddingRight = prevPadding
}
