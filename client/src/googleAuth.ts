// Google Sign-In helper — one API, two implementations.
//
//  • Web: Google Identity Services (GIS). We render Google's official button into
//    a container and receive an ID token ("credential") in the callback.
//  • Native (Capacitor/Android): the @codetrix-studio/capacitor-google-auth plugin
//    drives the native account picker and returns an ID token. We reach it via
//    Capacitor's registerPlugin proxy so the web bundle never imports the package.
//
// Both paths yield a Google ID token that the app posts to POST /api/auth/google,
// so the backend verification is identical regardless of platform.
import { Capacitor, registerPlugin } from '@capacitor/core'

// The Web OAuth client id. Set VITE_GOOGLE_CLIENT_ID in client/.env(.production).
// Empty string when unconfigured — the UI hides the Google button in that case.
export const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || ''
export const googleEnabled = () => !!GOOGLE_CLIENT_ID
export const isNativePlatform = () => Capacitor.isNativePlatform()

// ---- Web (Google Identity Services) ---------------------------------------
let gisPromise: Promise<any> | null = null
// Load the GIS script exactly once and resolve with window.google.
function loadGis(): Promise<any> {
  if ((window as any).google?.accounts?.id) return Promise.resolve((window as any).google)
  if (gisPromise) return gisPromise
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.defer = true
    s.onload = () => resolve((window as any).google)
    s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google Sign-In. Check your connection.')) }
    document.head.appendChild(s)
  })
  return gisPromise
}

// Render Google's official button into `container`. `onCredential` fires with the
// ID token when the user completes sign-in. Returns a cleanup function.
export async function renderGoogleButton(
  container: HTMLElement,
  onCredential: (credential: string) => void,
  onError?: (message: string) => void,
): Promise<() => void> {
  if (!GOOGLE_CLIENT_ID) { onError?.('Google Sign-In is not configured.'); return () => {} }
  let google: any
  try { google = await loadGis() }
  catch (e: any) { onError?.(e.message); return () => {} }

  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: (resp: any) => {
      if (resp?.credential) onCredential(resp.credential)
      else onError?.('Google sign-in was cancelled.')
    },
  })
  google.accounts.id.renderButton(container, {
    theme: 'outline', size: 'large', width: container.clientWidth || 320,
    text: 'continue_with', shape: 'pill', logo_alignment: 'center',
  })
  return () => { try { google.accounts.id.cancel() } catch {} }
}

// ---- Native (Capacitor plugin) --------------------------------------------
// We talk to the native @codetrix-studio/capacitor-google-auth plugin through
// Capacitor's registerPlugin proxy instead of importing the npm package. This
// keeps the web bundle free of the plugin (Vite never has to resolve it), while
// the proxy still routes to the real native implementation once the plugin is
// installed and synced into the Android project (see docs/GOOGLE_SIGNIN_SETUP.md).
interface GoogleAuthPlugin {
  initialize(options?: Record<string, unknown>): Promise<void>
  signIn(): Promise<{ authentication?: { idToken?: string } }>
}
const GoogleAuth = registerPlugin<GoogleAuthPlugin>('GoogleAuth')

let nativeInit = false
// Sign in via the native Google account picker; resolves with an ID token.
export async function nativeGoogleSignIn(): Promise<string> {
  if (!nativeInit) {
    // Boot the native SDK. serverClientId comes from capacitor.config.ts.
    try { await GoogleAuth.initialize() } catch {}
    nativeInit = true
  }
  let result
  try { result = await GoogleAuth.signIn() }
  catch { throw new Error('Google Sign-In is not available in this build.') }
  const idToken = result?.authentication?.idToken
  if (!idToken) throw new Error('Google did not return a sign-in token.')
  return idToken
}
