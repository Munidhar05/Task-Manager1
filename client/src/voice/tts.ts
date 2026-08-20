// Text-to-speech for the voice assistant's spoken replies.
//
// Three paths, tried in order:
//   1. ElevenLabs, via the server proxy (/api/tts) so the key stays server-side.
//      Natural, and the reason the assistant sounds like a person rather than a
//      screen reader.
//   2. Native (Android): the @capacitor-community/text-to-speech plugin, reached
//      via Capacitor's registerPlugin proxy so the web bundle never imports it.
//   3. Web: the built-in window.speechSynthesis.
//
// 2 and 3 are the FALLBACK, not dead code — they carry the whole feature on a
// deployment with no ElevenLabs key, offline, or when the quota runs out mid-day.
// The rule from the rest of this codebase applies: the app must work with no API
// keys at all, so a missing key can never cost the user a spoken reply.
//
// speak() resolves when the utterance finishes (or immediately if TTS is off), so
// the conversation loop can re-open the mic right after the assistant stops talking.
import { Capacitor, registerPlugin } from '@capacitor/core'
import { API_BASE, getToken } from '../api'

interface TextToSpeechPlugin {
  speak(options: { text: string; lang?: string; rate?: number; pitch?: number; volume?: number }): Promise<void>
  stop(): Promise<void>
}
const NativeTTS = registerPlugin<TextToSpeechPlugin>('TextToSpeech')

const isNative = () => Capacitor.isNativePlatform()
export const ttsSupported = () =>
  isNative() || (typeof window !== 'undefined' && 'speechSynthesis' in window)

let enabled = true
export const setTtsEnabled = (on: boolean) => { enabled = on; if (!on) stopSpeaking() }
export const isTtsEnabled = () => enabled

// ---- ElevenLabs ------------------------------------------------------------

// Probed once per session. `null` = not asked yet; the probe is fire-and-forget so
// the first reply never waits on it — it just uses the fallback and the next one
// gets the good voice.
let remoteAvailable: boolean | null = null
let probing: Promise<void> | null = null

const probe = (): Promise<void> => {
  if (probing) return probing
  probing = (async () => {
    try {
      const token = getToken()
      if (!token) { remoteAvailable = false; return }
      const res = await fetch(`${API_BASE}/api/tts/status`, { headers: { authorization: `Bearer ${token}` } })
      const data = await res.json().catch(() => null)
      remoteAvailable = !!(res.ok && data?.enabled)
    } catch {
      remoteAvailable = false
    }
  })()
  return probing
}

// Kick the probe on load so the very first spoken reply can already use ElevenLabs.
if (typeof window !== 'undefined') setTimeout(() => { probe() }, 0)

// Short phrases repeat constantly ("Okay, cancelled.", "Shall I go ahead?"). Caching
// the decoded blob URL saves a paid call AND the round-trip latency, which is what
// the user actually notices — a re-fetch reads as the assistant hesitating.
const cache = new Map<string, string>()
const CACHE_MAX = 24

const cacheAudio = (text: string, url: string) => {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest) { URL.revokeObjectURL(cache.get(oldest)!); cache.delete(oldest) }
  }
  cache.set(text, url)
}

let current: HTMLAudioElement | null = null
// In-flight streaming fetch, so a barge-in can cut synthesis off mid-generation
// instead of only muting the player while the bytes keep arriving.
let streamAbort: AbortController | null = null

// Play `text` by STREAMING it: MP3 chunks are appended to a MediaSource as
// ElevenLabs produces them, so audio starts a few hundred ms in instead of after
// the whole clip is synthesized and downloaded. Resolves true if playback actually
// started; false means "fall back" (no MSE on this browser, network error, autoplay
// blocked). The completed clip is cached so repeats skip the network entirely.
async function speakRemoteStream(text: string): Promise<boolean> {
  const MS: typeof MediaSource | undefined = (window as any).MediaSource
  if (!MS || !MS.isTypeSupported('audio/mpeg')) return false
  const token = getToken()
  if (!token) return false

  const ctrl = new AbortController()
  streamAbort = ctrl
  try {
    const res = await fetch(`${API_BASE}/api/tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    })
    if (!res.ok || !res.body) {
      if (res.status === 503) remoteAvailable = false
      return false
    }

    const ms = new MS()
    const audio = new Audio(URL.createObjectURL(ms))
    current = audio
    let started = false
    let complete = false            // reader drained cleanly -> safe to cache
    const chunks: BlobPart[] = []

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => { if (!settled) { settled = true; resolve() } }
      audio.onended = finish
      audio.onerror = finish
      // stopSpeaking() pauses for a barge-in; a paused element never fires 'ended'.
      audio.onpause = finish

      ms.addEventListener('sourceopen', async () => {
        let sb: SourceBuffer
        try { sb = ms.addSourceBuffer('audio/mpeg') } catch { finish(); return }
        // appendBuffer is async and rejects overlapping calls — serialize on updateend.
        const append = (buf: Uint8Array) => new Promise<void>((ok, fail) => {
          sb.addEventListener('updateend', () => ok(), { once: true })
          sb.addEventListener('error', () => fail(new Error('append failed')), { once: true })
          try { sb.appendBuffer(buf as BufferSource) } catch (e) { fail(e as Error) }
        })
        const reader = res.body!.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) { complete = true; break }
            if (value?.length) { chunks.push(value); await append(value) }
          }
        } catch { /* network died or barge-in — play out whatever was buffered */ }
        try { if (ms.readyState === 'open') ms.endOfStream() } catch {}
      }, { once: true })

      // Autoplay policy can reject before a gesture — report "did not play" so the
      // caller falls back rather than silently swallowing the reply.
      audio.play().then(() => { started = true }).catch(finish)
    })

    try { URL.revokeObjectURL(audio.src) } catch {}
    if (current === audio) current = null
    if (started && complete) cacheAudio(text, URL.createObjectURL(new Blob(chunks, { type: 'audio/mpeg' })))
    return started
  } catch {
    return false
  } finally {
    if (streamAbort === ctrl) streamAbort = null
  }
}

// Play `text` through ElevenLabs. Resolves true if it actually played, false if the
// caller should fall back. Never throws — every failure is just "use the other voice".
async function speakRemote(text: string): Promise<boolean> {
  try {
    let url = cache.get(text)
    if (!url) {
      const token = getToken()
      if (!token) return false
      const res = await fetch(`${API_BASE}/api/tts/speak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) {
        // 503 means the key was removed since we probed — stop trying for this
        // session rather than paying a failed round-trip before every reply.
        if (res.status === 503) remoteAvailable = false
        return false
      }
      url = URL.createObjectURL(await res.blob())
      cacheAudio(text, url)
    }

    const audio = new Audio(url)
    current = audio
    let started = false
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => { if (!settled) { settled = true; resolve() } }
      audio.onended = finish
      audio.onerror = finish
      // stopSpeaking() pauses for a barge-in, and a paused element never fires
      // 'ended'. Without this the promise never settles and the whole conversation
      // loop hangs waiting for a reply that already stopped.
      audio.onpause = finish
      // Autoplay policy can reject before the page has seen a gesture. Report that
      // as "did not play" so the caller falls back, rather than silently swallowing
      // the reply — `started` is what distinguishes the two.
      audio.play().then(() => { started = true }).catch(finish)
    })
    if (current === audio) current = null
    return started
  } catch {
    return false
  }
}

// ---- on-device fallback ----------------------------------------------------

async function speakLocal(text: string, lang: string): Promise<void> {
  if (isNative()) {
    try { await NativeTTS.speak({ text, lang, rate: 1.0, pitch: 1.0, volume: 1.0 }) } catch {}
    return
  }
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  await new Promise<void>((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = lang
      u.onend = () => resolve()
      u.onerror = () => resolve()
      window.speechSynthesis.speak(u)
      // Safety: some browsers never fire onend — resolve on a length-based timeout.
      setTimeout(resolve, Math.min(15000, 1200 + text.length * 60))
    } catch { resolve() }
  })
}

// ---- public API ------------------------------------------------------------

export function stopSpeaking() {
  if (streamAbort) { try { streamAbort.abort() } catch {}; streamAbort = null }
  if (current) { try { current.pause() } catch {}; current = null }
  if (isNative()) { NativeTTS.stop().catch(() => {}) }
  try { window.speechSynthesis?.cancel() } catch {}
}

// Speak `text`; resolves when done. Never rejects — TTS is best-effort.
export async function speak(text: string, lang = 'en-US'): Promise<void> {
  if (!enabled || !text) return
  stopSpeaking()

  // Undecided on the first reply: don't block on the probe, just use the fallback
  // this once. Deciding is worth less than answering promptly.
  if (remoteAvailable === null) probe()
  if (remoteAvailable) {
    // Cached sentences skip the network entirely; new ones stream so playback
    // starts on the first synthesized chunk; the buffered path is the safety net
    // for browsers without MSE (and for a stream that fails mid-handshake).
    if (cache.has(text)) { if (await speakRemote(text)) return }
    else if (await speakRemoteStream(text)) return
    else if (remoteAvailable && await speakRemote(text)) return
  }

  await speakLocal(text, lang)
}
