// Live speech-to-text using the browser's own SpeechRecognition — no API key,
// no audio leaving the device, nothing to pay for.
//
// It is the same engine the Meetings recorder already falls back to when no
// server transcription provider is configured (see Meetings.tsx). The important
// limitation, and the reason callers have to design around it: SpeechRecognition
// listens to the DEFAULT MICROPHONE of the machine it runs on. It cannot be
// handed a MediaStream, so it can never hear the far end of a call. Each
// participant transcribes themselves and the server stitches the sides together.
//
// Availability: Chrome, Edge and the Android WebView. Not Firefox, and not iOS
// WKWebView (CLAUDE.md) — `isSupported()` is the check every caller must make
// before promising a transcript.
//
// The whole design problem here is that Chrome ENDS the session constantly:
// after a few seconds of quiet it fires `no-speech` and then `onend`, and any
// one person's microphone is quiet for most of a call. A recogniser that is not
// restarted therefore stops at the first pause; one restarted *immediately* gets
// throttled by Chrome until `start()` throws. Either way the transcript dies a
// few seconds in and nothing says so — which is exactly what happened. Hence the
// backoff, and the status reporting that makes a dead recogniser visible.

export type SpeechStatus =
  | { kind: 'listening' }
  | { kind: 'retrying'; reason: string }
  | { kind: 'dead'; reason: string }

type Listener = (text: string) => void
type StatusListener = (s: SpeechStatus) => void

const SRClass: any = typeof window !== 'undefined'
  && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

export const isSupported = () => !!SRClass

export interface LiveSpeech {
  stop: () => void
  /** Utterances recognised so far — lets the UI prove it is actually working. */
  count: () => number
}

// Permission problems are the only thing worth giving up on. Everything else —
// a dropped network, a quiet room, Chrome ending the session on its own — is
// routine and recoverable.
const FATAL = ['not-allowed', 'service-not-allowed']

/**
 * Start listening and call `onFinal` with each completed utterance.
 *
 * `lang` defaults to the browser's locale so Indian-English, Hindi and Telugu
 * users get their own recogniser rather than en-US mangling every proper noun.
 */
export function startLiveSpeech(onFinal: Listener, lang?: string, onStatus?: StatusListener): LiveSpeech | null {
  if (!SRClass) return null

  let stopped = false
  let rec: any = null
  let heard = 0
  let restarts = 0          // consecutive restarts with nothing recognised between them
  let timer: ReturnType<typeof setTimeout> | null = null

  const status = (s: SpeechStatus) => { try { onStatus?.(s) } catch {} }

  // Grows only while restarts keep coming back empty, and resets the moment a
  // real utterance lands. A quiet stretch costs a slower poll rather than a dead
  // recogniser, and Chrome never sees the rapid-fire start() that throttles a page.
  const delay = () => Math.min(3000, 250 * Math.pow(1.6, Math.min(restarts, 6)))

  const build = (): any => {
    const r = new SRClass()
    r.continuous = true
    r.interimResults = false          // only completed utterances reach the caller
    r.maxAlternatives = 1
    r.lang = lang || navigator.language || 'en-IN'

    r.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        if (!res.isFinal) continue
        const text = String(res[0]?.transcript || '').trim()
        if (!text) continue
        heard++
        restarts = 0                  // it is working; go back to a fast restart
        onFinal(text)
      }
    }

    r.onerror = (e: any) => {
      const err = String(e?.error || 'unknown')
      if (FATAL.includes(err)) {
        stopped = true
        status({ kind: 'dead', reason: err === 'not-allowed' ? 'microphone permission denied' : 'speech service unavailable' })
        return
      }
      // 'no-speech' is the common one and means nothing is wrong. 'network'
      // means Chrome could not reach its speech service — worth retrying, and
      // worth naming, because on a locked-down network it will never succeed and
      // the user should be told rather than handed an empty transcript.
      if (err !== 'no-speech' && err !== 'aborted') restarts++
    }

    // Chrome ends the session by itself after a pause. Not a failure.
    r.onend = () => { if (!stopped) { restarts++; schedule('session ended') } }
    return r
  }

  function schedule(reason: string) {
    if (stopped) return
    if (timer) clearTimeout(timer)
    status({ kind: 'retrying', reason })
    timer = setTimeout(() => {
      if (stopped) return
      try {
        rec = build()
        rec.start()
        status({ kind: 'listening' })
      } catch {
        // Chrome refuses a start that comes too soon after the last one. That is
        // a reason to wait longer, never a reason to give up — giving up here is
        // precisely what lost whole calls silently.
        restarts++
        schedule('throttled')
      }
    }, delay())
  }

  try {
    rec = build()
    rec.start()
    status({ kind: 'listening' })
  } catch {
    return null
  }

  return {
    stop: () => {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
      try { rec?.abort() } catch {}
      rec = null
    },
    count: () => heard,
  }
}
