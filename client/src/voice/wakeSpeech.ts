// Wake-word ("hey VoTask") detection via the browser's SpeechRecognition API.
//
// This is the STOPGAP path that works today, before a custom "hey votask"
// openWakeWord model exists. It runs continuous recognition and watches the
// transcript for the phrase; `wakeword.ts` picks between this and the on-device
// ONNX detector via VITE_WAKEWORD_MODE.
//
// Trade-offs vs the ONNX path (see wakeword.ts): needs network (Chrome streams
// audio to Google), costs more battery, and is Chrome/Android-WebView only.
// The upside is that it needs no trained model and matches "votask" as words.
//
// Like the ONNX path it is config-gated and fails silently — any error just
// leaves the user tapping the mic button.
import { useEffect, useRef } from 'react'
import type { WakeStatus } from './wakeword'

const DEBUG = (import.meta.env.VITE_WAKEWORD_DEBUG as string | undefined) === 'true'
const LANG = (import.meta.env.VITE_WAKEWORD_LANG as string | undefined) || 'en-IN'

const SRClass = (): any =>
  typeof window !== 'undefined' && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

export const speechWakeSupported = () => !!SRClass()

// --- phrase matching --------------------------------------------------------
// Transcripts are normalised to lowercase letters only, with ALL whitespace and
// punctuation stripped. That single step does most of the work: "hey VoTask",
// "hey vo task", "Hey Vo-Task" and "hey, votask!" all collapse to "heyvotask", so
// the variant lists below only have to cover PHONETIC guesses, never spacing or
// punctuation ones.
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')

// "VoTask" is a coined word, so no engine has it in its vocabulary — it will always
// be reported as whatever real words it sounds closest to. Three things drive the
// variants below, and all three are worse on the en-IN models this app defaults to:
//
//  • v/w/b/f/ph all collapse. Telugu and Hindi don't contrast /v/ and /w/ the way
//    English does, so "votask" comes back as "wotask", "botask" or "photask".
//  • The /t/ migrates. "vo-TASK" is heard as "vote ask" or "boat ask" just as
//    readily as "vo task" — the syllable break lands on the wrong side of the stop.
//  • "task" itself degrades to tusk / tosk / desk / dask.
//
// The variants are graded by how much of a real English phrase they are, because
// that is exactly what governs the false-positive risk. Three tiers:

// TIER 1 — coined tokens. Not English under any reading, so they may stand alone:
// "VoTask, what's overdue?" wakes with no "hey" at all.
const STRICT = [
  'votask', 'wotask', 'botask', 'photask', 'fotask', 'bhotask', 'vhotask',
  'votusk', 'wotusk', 'botusk', 'votosk', 'votaask', 'vothask', 'vodask',
  'votas', 'wotas', 'votax', 'votaz', 'vutask', 'vatask', 'vartask',
]

// TIER 2 — near-misses that brush against real words ("vote ask", "vaultask") but
// would still be odd things to say. Any greeting-ish prefix is enough.
const LOOSE = [
  'voteask', 'votetask', 'voatask', 'voteaz', 'boatask', 'boattask',
  'vaultask', 'voltask', 'voltas', 'vodesk', 'wodesk', 'wartask', 'photoask', 'whoask',
]

// TIER 3 — the engine substituting a whole ordinary phrase for the coined word.
// These are the MOST likely mishearings and also the most dangerous: in a task
// manager, "what task", "no task" and "go task" are things people genuinely say to
// each other. They are accepted only after a full, deliberate greeting — never
// after a throwaway "ok"/"eh" — so "OK, no task for me today" cannot wake the app
// while "Okay VoTask" still can.
const RISKY = ['whattask', 'whatask', 'whotask', 'phototask', 'gotask', 'notask']

// Greeting prefixes. HEY_ANY includes the clipped interjections a real recording is
// full of; HEY_STRONG is the deliberate address, and gates TIER 3 only.
const HEY_ANY = '(?:hey|hay|hei|heigh|hi|hie|hello|helo|hallo|halo|ay|eh|okay|ok|oi)'
const HEY_STRONG = '(?:hey|hay|hei|heigh|hello|helo|hallo|halo|okay)'

// Extra variants can be added without a code change while tuning on a real
// device: VITE_WAKEWORD_EXTRA=heyvodask,heywotusk  (or the localStorage twin,
// which wins so it can be changed live from the console). Turn DEBUG on, say the
// wake word ten times, and add whatever THIS device actually reports.
const extras = (): string[] => {
  let raw = (import.meta.env.VITE_WAKEWORD_EXTRA as string | undefined) || ''
  try { raw = localStorage.getItem('wakeword_extra') || raw } catch { /* storage off */ }
  return raw.split(',').map(normalize).filter(Boolean)
}

const buildMatcher = () => {
  // Tiers 1 and 2 accept any greeting; tier 3 demands a deliberate one. All three
  // are anchored to the START of the utterance: a wake word is how you OPEN a
  // sentence, and matching mid-string is what makes "…I'll add it to VoTask
  // tomorrow", said to a colleague, wake the app.
  const anchored = (prefix: string, words: string[]) => new RegExp(`^${prefix}(?:${words.join('|')})`)
  const loose = anchored(HEY_ANY, [...STRICT, ...LOOSE])
  const risky = anchored(HEY_STRONG, RISKY)
  const extra = extras()
  return (text: string) => {
    const n = normalize(text)
    if (!n) return false
    if (loose.test(n) || risky.test(n)) return true
    // Manually-added variants stay a plain substring test: they exist precisely to
    // catch whatever odd thing one device reports, and over-constraining them would
    // defeat the point of a live-tunable escape hatch.
    if (extra.some((e) => n.includes(e))) return true
    // Bare form: tier 1 only, and only at the very start.
    return STRICT.some((s) => n.startsWith(s))
  }
}

interface Options { enabled: boolean; onWake: () => void; onStatus?: (s: WakeStatus, detail?: string) => void }

export function useSpeechWakeWord({ enabled, onWake, onStatus }: Options) {
  const onWakeRef = useRef(onWake)
  const onStatusRef = useRef(onStatus)
  onWakeRef.current = onWake
  onStatusRef.current = onStatus

  useEffect(() => {
    const say = (s: WakeStatus, d?: string) => onStatusRef.current?.(s, d)
    const SR = SRClass()
    if (!enabled) return
    // No SpeechRecognition at all — tell the dispatcher so it can fall back.
    if (!SR) { say('error', 'unavailable'); return }

    const matches = buildMatcher()
    let rec: any = null
    let stopped = false      // set by cleanup — suppresses the auto-restart
    let running = false      // start() throws InvalidStateError if already started
    let backoff = 0          // grows on network errors, reset on a clean result
    let timer: any = null
    let lastFire = 0
    let everStarted = false
    let netErrors = 0
    // The Android WebView can expose SpeechRecognition and then never fire
    // `onstart` (or immediately end every session), and the whole engine is dead
    // without network. Feature-detection can't see either case, so give it a
    // grace period to prove it works and declare it unavailable if it doesn't.
    const WATCHDOG_MS = 8000
    const watchdog = setTimeout(() => {
      if (!everStarted && !stopped) {
        stopped = true
        clearTimeout(timer)
        try { rec?.abort() } catch { /* never started */ }
        if (DEBUG) console.info('[wake-speech] no session started in 8s — reporting unavailable')
        say('error', 'unavailable')
      }
    }, WATCHDOG_MS)
    // Android re-fires the same utterance as growing-prefix results across its
    // frequent auto-restarts, so one "hey VoTask" can match many times. Refractory
    // period + this guard keep that down to a single wake.
    const REFRACTORY_MS = 2500

    const restart = (delay: number) => {
      if (stopped) return
      clearTimeout(timer)
      timer = setTimeout(() => { if (!stopped) start() }, delay)
    }

    const start = () => {
      if (stopped || running) return
      try {
        rec = new SR()
        rec.lang = LANG
        rec.continuous = true      // honoured on desktop Chrome; ignored on Android
        rec.interimResults = true  // match on interims so wake feels instant
        rec.maxAlternatives = 3    // a coined word is a coin flip — check the runners-up too

        rec.onstart = () => { running = true; everStarted = true; clearTimeout(watchdog); say('listening') }

        rec.onresult = (e: any) => {
          backoff = 0
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const result = e.results[i]
            for (let a = 0; a < result.length; a++) {
              const text = result[a].transcript as string
              if (!matches(text)) continue
              const now = Date.now()
              if (now - lastFire < REFRACTORY_MS) return
              lastFire = now
              if (DEBUG) console.info(`[wake-speech] WAKE on "${text.trim()}"`)
              // Release the mic BEFORE handing off: on Android the recorder's
              // getUserMedia and SpeechRecognition contend for the same input,
              // and a still-open recogniser can make the recording come back empty.
              stopped = true
              try { rec.abort() } catch { /* already gone */ }
              onWakeRef.current()
              return
            }
            if (DEBUG && result.isFinal) console.info(`[wake-speech] heard "${result[0].transcript.trim()}"`)
          }
        }

        rec.onerror = (e: any) => {
          const err = e?.error
          if (err === 'not-allowed' || err === 'service-not-allowed') {
            // Mic permission denied — retrying just spams the console.
            stopped = true
            say('error', 'microphone permission denied')
            return
          }
          if (err === 'network') {
            // Chrome streams audio to Google, so no network = no wake word ever.
            // Back off, and after a few failures hand over to the on-device model
            // rather than retrying forever on a phone that's offline.
            backoff = Math.min(backoff ? backoff * 2 : 1000, 30000)
            if (++netErrors >= 3) {
              stopped = true
              clearTimeout(timer); clearTimeout(watchdog)
              if (DEBUG) console.info('[wake-speech] 3 network errors — reporting unavailable')
              say('error', 'unavailable')
              return
            }
          }
          if (DEBUG) console.info(`[wake-speech] error: ${err}`)
        }

        rec.onend = () => {
          running = false
          // Android ends the session after every utterance (and after silence),
          // so restarting on end IS the continuous mode. Never restart tighter
          // than 300 ms or a permission-blocked engine becomes a busy loop.
          restart(backoff || 300)
        }

        rec.start()
      } catch (err) {
        running = false
        if (DEBUG) console.info('[wake-speech] start failed:', err)
        restart(1000)
      }
    }

    say('loading')
    // Give the voice recorder time to fully release the mic when a session ends
    // and re-enables us; grabbing it back instantly can kill the in-flight stream.
    restart(600)

    return () => {
      stopped = true
      clearTimeout(timer)
      clearTimeout(watchdog)
      try { rec?.abort() } catch { /* not started */ }
      rec = null
    }
  }, [enabled])
}
