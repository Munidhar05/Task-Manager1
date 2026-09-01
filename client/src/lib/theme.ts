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

// What the choice actually resolves to right now.
export const resolveTheme = (choice: ThemeChoice = getThemeChoice()): 'light' | 'dark' =>
  choice === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : choice

// Paint it. `data-theme` on <html> is what the CSS keys off; the theme-color meta
// tells the mobile browser (and the Android WebView) to match its own chrome, or
// the status bar stays white above a dark app.
function paint(choice: ThemeChoice) {
  const mode = resolveTheme(choice)
  document.documentElement.setAttribute('data-theme', mode)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', mode === 'dark' ? '#0f1216' : '#f2f4f7')
}

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
