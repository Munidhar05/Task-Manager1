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

type Listener = (text: string) => void

const SRClass: any = typeof window !== 'undefined'
  && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

export const isSupported = () => !!SRClass

export interface LiveSpeech {
  stop: () => void
}

/**
 * Start listening and call `onFinal` with each completed utterance.
 *
 * `lang` defaults to the browser's locale so Indian-English, Hindi and Telugu
 * users get their own recogniser rather than en-US mangling every proper noun.
 */
export function startLiveSpeech(onFinal: Listener, lang?: string): LiveSpeech | null {
  if (!SRClass) return null

  let stopped = false
  let rec: any = null

  const build = () => {
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
        if (text) onFinal(text)
      }
    }

    // Chrome ends the session on its own after a stretch of silence, and a
    // 'no-speech' error is routine rather than a failure. Restart unless we were
    // deliberately stopped, or a long quiet patch in a call kills the transcript
    // for the rest of it.
    r.onend = () => { if (!stopped) { try { rec = build(); rec.start() } catch { /* mic gone */ } } }
    r.onerror = (e: any) => {
      // 'aborted' and 'no-speech' are normal; anything else means the engine is
      // unavailable (permission withdrawn, no network) and retrying would spin.
      if (e?.error && !['no-speech', 'aborted'].includes(e.error)) stopped = true
    }
    return r
  }

  try {
    rec = build()
    rec.start()
  } catch {
    return null
  }

  return {
    stop: () => {
      stopped = true
      try { rec?.stop() } catch {}
      rec = null
    },
  }
}
