// Streaming speech-to-text for the voice assistant — the fast path.
//
// The classic turn was: record a webm until VAD silence (1.4s tail), upload the
// whole blob, wait for a REST transcription, THEN think. This module streams mic
// PCM to /api/assistant/live (a Sarvam relay, see server ws/liveTranscribe.js)
// WHILE the user talks, so by the moment they stop, the transcript already exists
// — the entire upload+transcribe round-trip disappears from the turn.
//
// Endpointing is a two-party handshake rather than a single timer:
//   - Sarvam's server-side VAD decides when an UTTERANCE is finished (that's when
//     a `transcript` message arrives — it does not send partials mid-utterance).
//   - Our local RMS watcher decides when the TURN is finished: a transcript in
//     hand + `silenceMs` of local quiet. The local grace period is what lets
//     someone breathe mid-command ("assign the logo task … to Ravi") without the
//     first half being fired off as the whole command.
// If Sarvam never finalizes (packet loss, hard mishear), `hardSilenceMs` of quiet
// ends the turn anyway with whatever text arrived, so the loop can never hang.
import { getToken, wsUrl } from '../api'
import { startPcmStream, type PcmStream } from '../lib/pcmStream'

export interface LiveListen {
  stop: () => void     // finalize now (user tapped) — waits briefly for the tail transcript
  cancel: () => void   // abort; `done` resolves ''
  done: Promise<string>
}

export interface LiveListenOptions {
  onPartial?: (text: string) => void  // accumulated transcript so far, for live display
  onLevel?: (level: number) => void   // 0..1 for the mic meter
  silenceMs?: number                  // local quiet needed to end the turn once a transcript exists
  hardSilenceMs?: number              // quiet that ends the turn even with no transcript
  minSpeechMs?: number                // require this much sound before silence can end it
  speechThreshold?: number            // RMS loud enough to START a turn
  holdThreshold?: number              // ...and the lower bar that KEEPS it going
  noSpeechMs?: number                 // nobody spoke at all -> give up
  maxMs?: number                      // hard cap on a turn
  tailWaitMs?: number                 // after stop(): how long to wait for the final transcript
  connectTimeoutMs?: number           // WS+Sarvam handshake budget before falling back
}

// Rejects if the socket can't be established (no Sarvam on this deployment, auth,
// network) — the caller falls back to the classic record→upload path. Once it
// RESOLVES, `done` always resolves (possibly ''), never rejects.
export function startLiveListen(opts: LiveListenOptions = {}): Promise<LiveListen> {
  const {
    onPartial, onLevel,
    // 800ms of quiet used to end the turn, which is shorter than an ordinary
    // pause mid-sentence — "assign this to… Ravi" was enough to get cut off, and
    // the 15s cap ended anything longer than a sentence outright. Both were tuned
    // for terse commands; people talk to this thing in paragraphs.
    //
    // 1.5s is past a thinking pause but still feels prompt. The 3-minute cap is
    // now only a runaway guard — a mic that never stops must not stream forever —
    // rather than something a real utterance can reach.
    // 2s of real silence ends a turn — the number the product asks for. Every
    // other limit here exists to catch a BROKEN session, never a long one:
    //   noSpeechMs   nobody ever spoke
    //   maxMs        30 minutes, a runaway-mic guard. A turn is expected to end
    //                on silence; if this fires, something is wrong, so it must
    //                sit far beyond any real utterance rather than trimming one.
    silenceMs = 2000, hardSilenceMs = 4500, minSpeechMs = 350,
    speechThreshold = 0.045, holdThreshold = 0.018, noSpeechMs = 8000, maxMs = 1800000,
    tailWaitMs = 1400, connectTimeoutMs = 3000,
  } = opts

  return new Promise<LiveListen>((resolveStart, rejectStart) => {
    const ws = new WebSocket(wsUrl(`/api/assistant/live?token=${encodeURIComponent(getToken() || '')}`))
    let started = false           // resolveStart already fired
    let pcm: PcmStream | null = null
    let ticker: ReturnType<typeof setInterval> | null = null
    let finalized = false

    const segments: string[] = []
    let speechAccum = 0
    let lastLoudAt = Date.now()
    let lastFrameAt = Date.now()
    let startedAt = Date.now()
    // stop() flips the turn into "finalizing": mic off, waiting only for Sarvam's
    // trailing transcript of what was already said.
    let finalizeDeadline = 0

    let resolveDone: (text: string) => void
    const done = new Promise<string>((res) => { resolveDone = res })

    const cleanup = () => {
      if (ticker) { clearInterval(ticker); ticker = null }
      try { pcm?.stop() } catch {}
      pcm = null
      try { ws.close() } catch {}
    }
    const finalize = (text: string) => {
      if (finalized) return
      finalized = true
      cleanup()
      resolveDone(text)
    }
    const text = () => segments.join(' ').replace(/\s+/g, ' ').trim()

    const connectTimer = setTimeout(() => {
      if (!started) { try { ws.close() } catch {}; rejectStart(new Error('live STT connect timeout')) }
    }, connectTimeoutMs)

    ws.onmessage = async (e) => {
      let msg: any
      try { msg = JSON.parse(String(e.data)) } catch { return }

      // Server says the upstream Sarvam socket is live — audio can flow. Only now
      // does the turn begin: mic on, clocks started, caller unblocked.
      if (msg.ready && !started) {
        started = true
        clearTimeout(connectTimer)
        try {
          pcm = await startPcmStream(
            (b64) => { lastFrameAt = Date.now(); if (ws.readyState === WebSocket.OPEN) ws.send(b64) },
            () => finalize(''),  // mic permission lost mid-session — end the turn quietly
            (rms) => {
              onLevel?.(Math.min(1, rms * 3))
              const now = Date.now()
              // Hysteresis: it takes a clear 0.045 to decide someone STARTED
              // talking, but only 0.018 to accept they are STILL talking.
              //
              // One threshold did both jobs, and that is what kept cutting people
              // off. Ordinary speech dips under 0.045 constantly — between words,
              // on soft consonants, mid-breath — so the "still talking" clock
              // restarted inside a sentence and the turn ended while the speaker
              // was plainly still going. A single low threshold is not the fix
              // either: room noise would then hold the mic open forever. The gap
              // between the two is the point.
              if (rms >= speechThreshold) { speechAccum += 85; lastLoudAt = now } // ~85ms per 4096-sample frame @48k
              else if (speechAccum >= minSpeechMs && rms >= holdThreshold) lastLoudAt = now
            },
          )
        } catch {
          finalize('')
          rejectStart(new Error('microphone unavailable'))
          return
        }
        startedAt = Date.now()
        lastLoudAt = startedAt

        ticker = setInterval(() => {
          if (finalized) return
          const now = Date.now()
          // Finalizing after stop(): resolve as soon as the tail transcript lands
          // (handled in onmessage) or the wait budget runs out.
          if (finalizeDeadline) {
            if (now >= finalizeDeadline) finalize(text())
            return
          }
          const quietFor = now - lastLoudAt
          const why = (reason: string, bad = true) => (bad ? console.warn : console.debug)(
            `[voice] turn ended: ${reason} | quiet ${quietFor}ms, speech ${speechAccum}ms, ` +
            `segments ${segments.length}, elapsed ${now - startedAt}ms, sinceFrame ${now - lastFrameAt}ms`)
          // Turn complete: Sarvam gave us words and the speaker has stayed quiet.
          if (segments.length && speechAccum >= minSpeechMs && quietFor >= silenceMs) { why(`silence ${silenceMs}ms with transcript`, false); return finalize(text()) }
          // Spoke, went quiet, but no transcript ever arrived — don't hang the loop.
          if (speechAccum >= minSpeechMs && quietFor >= hardSilenceMs) { why(`hard silence ${hardSilenceMs}ms, NO transcript from Sarvam`); return finalize(text()) }
          // Nobody said anything at all.
          if (speechAccum < minSpeechMs && now - startedAt >= noSpeechMs) { why(`no speech detected in ${noSpeechMs}ms — mic too quiet?`); return finalize(text()) }
          // Absolute cap: stop the mic, give the tail one last chance to arrive.
          if (now - startedAt >= maxMs) { why(`hit the ${maxMs}ms cap`); try { pcm?.stop() } catch {}; pcm = null; finalizeDeadline = now + tailWaitMs }
          // The audio graph died silently (tab backgrounded on some devices).
          if (now - lastFrameAt > 4000) { why('no audio frames for 4s — audio graph died'); return finalize(text()) }
        }, 100)

        resolveStart({
          stop: () => {
            if (finalized || finalizeDeadline) return
            try { pcm?.stop() } catch {}
            pcm = null
            // If words already arrived, a short tail wait risks nothing; if none
            // have, this is the only window in which they can still land.
            finalizeDeadline = Date.now() + tailWaitMs
          },
          cancel: () => finalize(''),
          done,
        })
        return
      }

      if (typeof msg.transcript === 'string' && msg.transcript.trim()) {
        segments.push(msg.transcript.trim())
        onPartial?.(text())
        // The tap-to-stop tail wait was for exactly this message.
        if (finalizeDeadline) finalize(text())
        return
      }

      if (msg.error) {
        // Before start: this deployment can't stream (no provider, bad auth) —
        // reject so the caller uses the classic path. After start: keep whatever
        // words we have; the ticker's hard-silence guard will end the turn.
        if (!started) { clearTimeout(connectTimer); try { ws.close() } catch {}; rejectStart(new Error(msg.error)) }
      }
    }

    ws.onerror = () => {
      if (!started) { clearTimeout(connectTimer); rejectStart(new Error('live STT socket failed')) }
    }
    ws.onclose = () => {
      if (!started) { clearTimeout(connectTimer); rejectStart(new Error('live STT socket closed')) }
      // Mid-turn close: resolve with what we have rather than stranding the loop.
      else if (!finalized) finalize(text())
    }
  })
}
