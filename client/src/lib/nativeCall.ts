// The phone's own incoming-call screen (Android), reached through the app's
// CallRing plugin (client/android/.../CallRingPlugin.java).
//
// Why a native screen at all: a web page cannot ring a phone. Once the app is
// in the background, or the phone is locked, there is no page running to play
// a sound — which is exactly the case WhatsApp gets right and we did not. The
// server sends every call as a push; the app's messaging service puts up a
// full-screen ringing call from it, with no web code involved. This module is
// the web side's half: tell native where the API is, ring natively when the
// page itself is hidden, stop the ring, and pick up an Answer pressed there.
//
// Everything here is a no-op on the website and on an older app build without
// the plugin, so callers never need to check first.
import { Capacitor, registerPlugin } from '@capacitor/core'

export interface NativeCallAction { action?: 'answer'; call_id?: string; conversation_id?: string; kind?: string }

interface CallRingPlugin {
  configure(o: { apiBase: string }): Promise<void>
  showIncoming(p: Record<string, string>): Promise<void>
  cancel(o: { call_id: string }): Promise<void>
  getPendingAction(): Promise<NativeCallAction>
  callUiDone(): Promise<void>
  fullScreenStatus(): Promise<{ allowed: boolean }>
  openFullScreenSettings(): Promise<void>
  addListener(ev: 'callAction', cb: (a: NativeCallAction) => void): Promise<{ remove: () => Promise<void> }>
}

const CallRing = registerPlugin<CallRingPlugin>('CallRing')

export const nativeCallsAvailable = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('CallRing')

const quiet = <T,>(p: () => Promise<T>, fallback: T): Promise<T> => {
  if (!nativeCallsAvailable()) return Promise.resolve(fallback)
  try { return p().catch(() => fallback) } catch { return Promise.resolve(fallback) }
}

/** The ring as the server sends it over the socket (routes/chat.js ringFor). */
export interface RingMsg {
  callId: string; conversationId: string; kind: 'audio' | 'video'
  from?: { id: string; name: string }; title?: string; conversationName?: string; group?: boolean
  expiresAt?: string; decline?: { uid: string; sig: string; url: string }
}

export const configureNativeCalls = (apiBase: string) => quiet(() => CallRing.configure({ apiBase }), undefined)

// Same keys as the push the server sends, so the native side has one parser.
export const ringNatively = (m: RingMsg) => quiet(() => CallRing.showIncoming({
  call_id: m.callId, conversation_id: m.conversationId, kind: m.kind,
  from_name: m.from?.name || '', title: m.title || m.conversationName || m.from?.name || 'VoTask',
  group: m.group ? '1' : '0', expires_at: m.expiresAt || new Date(Date.now() + 60000).toISOString(),
  decline_url: m.decline?.url || '', decline_sig: m.decline?.sig || '', uid: m.decline?.uid || '',
}), undefined)

export const stopNativeRing = (callId: string) => quiet(() => CallRing.cancel({ call_id: callId }), undefined)
export const takeNativeAction = () => quiet(() => CallRing.getPendingAction(), {} as NativeCallAction)
export const nativeCallDone = () => quiet(() => CallRing.callUiDone(), undefined)
export const nativeFullScreenStatus = () => quiet(() => CallRing.fullScreenStatus(), { allowed: true })
export const openNativeFullScreenSettings = () => quiet(() => CallRing.openFullScreenSettings(), undefined)

/** Answer pressed on the native screen while the app was already running. */
export function onNativeCallAction(cb: (a: NativeCallAction) => void): () => void {
  if (!nativeCallsAvailable()) return () => {}
  let handle: { remove: () => Promise<void> } | null = null
  let gone = false
  CallRing.addListener('callAction', cb).then((h) => { if (gone) h.remove(); else handle = h }).catch(() => {})
  return () => { gone = true; handle?.remove().catch(() => {}) }
}
