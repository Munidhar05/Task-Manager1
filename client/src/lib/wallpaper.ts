// App wallpaper (background) — a per-device preference stored in localStorage and
// applied as the page background via the --app-wallpaper CSS variable. Purely
// client-side, so it needs no backend field.

export interface Wallpaper { id: string; name: string; value: string; swatch: string }

// `value` is the CSS background applied to <body>; `swatch` is a small preview.
// id 'default' clears the override and falls back to the app's --bg colour.
export const WALLPAPERS: Wallpaper[] = [
  { id: 'default', name: 'Default', value: '', swatch: '#f8e5c5' },
  { id: 'sunset', name: 'Sunset', value: 'linear-gradient(135deg,#fde68a 0%,#fca5a5 100%)', swatch: 'linear-gradient(135deg,#fde68a,#fca5a5)' },
  { id: 'ocean', name: 'Ocean', value: 'linear-gradient(135deg,#bae6fd 0%,#a5b4fc 100%)', swatch: 'linear-gradient(135deg,#bae6fd,#a5b4fc)' },
  { id: 'mint', name: 'Mint', value: 'linear-gradient(135deg,#bbf7d0 0%,#99f6e4 100%)', swatch: 'linear-gradient(135deg,#bbf7d0,#99f6e4)' },
  { id: 'lavender', name: 'Lavender', value: 'linear-gradient(135deg,#ede9fe 0%,#fbcfe8 100%)', swatch: 'linear-gradient(135deg,#ede9fe,#fbcfe8)' },
  { id: 'slate', name: 'Slate', value: 'linear-gradient(135deg,#e2e8f0 0%,#cbd5e1 100%)', swatch: 'linear-gradient(135deg,#e2e8f0,#cbd5e1)' },
  { id: 'charcoal', name: 'Charcoal', value: 'linear-gradient(135deg,#334155 0%,#1e293b 100%)', swatch: 'linear-gradient(135deg,#334155,#1e293b)' },
]

const KEY = 'appWallpaper'

export const getWallpaperId = (): string => localStorage.getItem(KEY) || 'default'

// Persist + apply a wallpaper by id. Sets/clears the CSS variable on <html>.
export function applyWallpaper(id: string): void {
  const w = WALLPAPERS.find((x) => x.id === id) || WALLPAPERS[0]
  localStorage.setItem(KEY, w.id)
  const root = document.documentElement
  if (w.value) root.style.setProperty('--app-wallpaper', w.value)
  else root.style.removeProperty('--app-wallpaper')
}
