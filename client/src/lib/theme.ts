// Light / dark / follow-the-system, stored per device in localStorage (like the
// wallpaper beside it — it describes this screen, not the account, so it needs no
// backend field and doesn't follow you onto a different machine).
//
// The choice and the result are deliberately separate things: 'system' is a
// standing instruction to track the OS, not a snapshot of it. So we store the
// choice, and resolve it to light/dark on every paint and whenever the OS flips.

export type ThemeChoice = 'light' | 'dark' | 'system'

const KEY = 'appTheme'
const DARK_MQ = '(prefers-color-scheme: dark)'

export const THEME_OPTIONS: { id: ThemeChoice; label: string; hint: string }[] = [
  { id: 'light', label: 'Light', hint: 'Always the light palette' },
  { id: 'dark', label: 'Dark', hint: 'Always the dark palette' },
  { id: 'system', label: 'System', hint: 'Follow your device setting' },
]

export const getThemeChoice = (): ThemeChoice => {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
  } catch { return 'system' }   // private mode / storage blocked
}

const systemPrefersDark = () => {
  try { return window.matchMedia(DARK_MQ).matches } catch { return false }
}

// The signed-out landing page is drawn as a light design, and it is the first
// thing anyone sees of the product. A visitor whose laptop is set to dark would
// otherwise meet it in a palette it was never composed for — so on these routes
// 'system' resolves to light instead of following the OS.
//
// Only 'system' is overridden. An explicit Light or Dark is still obeyed, because
// the landing page shows a theme switch and a control that visibly does nothing
// is worse than either palette. The token check is what makes this the *signed
// out* page: "/" is the dashboard once you are logged in, and that follows the OS
// like the rest of the app.
const LANDING_PATHS = new Set(['/', '/welcome'])
export const isLandingView = (): boolean => {
  try {
    return LANDING_PATHS.has(window.location.pathname) && !localStorage.getItem('smarttask_token')
  } catch { return false }
}

// What the choice actually resolves to right now.
export const resolveTheme = (choice: ThemeChoice = getThemeChoice()): 'light' | 'dark' =>
  choice === 'system' ? (systemPrefersDark() && !isLandingView() ? 'dark' : 'light') : choice

// Paint it. `data-theme` on <html> is what the CSS keys off; the theme-color meta
// tells the mobile browser (and the Android WebView) to match its own chrome, or
// the status bar stays white above a dark app.
function paint(choice: ThemeChoice) {
  const mode = resolveTheme(choice)
  document.documentElement.setAttribute('data-theme', mode)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', mode === 'dark' ? '#0f1216' : '#fcfaf7')
}

// Re-resolve and repaint without changing the stored choice. Needed because
// 'system' resolves differently on the landing page, and a client-side navigation
// onto it — logging out, or following a link back to "/" — never re-runs
// initTheme, so without this the page would keep whichever palette it was painted
// in before the route changed.
export const repaintTheme = (): void => paint(getThemeChoice())

export function applyTheme(choice: ThemeChoice): void {
  try { localStorage.setItem(KEY, choice) } catch { /* not fatal — the paint still lands */ }
  paint(choice)
}

// Called once at startup. The OS listener is what makes 'system' a live setting
// rather than a one-off read: flip the phone to dark at sunset and the app
// follows without being reopened.
export function initTheme(): void {
  paint(getThemeChoice())
  try {
    window.matchMedia(DARK_MQ).addEventListener('change', () => {
      if (getThemeChoice() === 'system') paint('system')
    })
  } catch { /* older WebViews without addEventListener on MediaQueryList */ }
}
