// Microphone recorder with voice-activity detection (auto-stop on silence) — the
// capture primitive for the hands-free voice assistant. It records via
// MediaRecorder (same webm pipeline the app already uses for transcription) while
// a WebAudio analyser watches the input level: once the speaker has said something
// and then goes quiet for `silenceMs`, recording stops on its own so the
// conversation can flow without tapping. A hard `maxMs` cap is the safety net.
//
// Returns a live `level` (0..1) for the UI meter and a `done` promise resolving
// with the recorded Blob (empty Blob if nothing usable was captured).

export interface Recording {
  stop: () => void          // stop early (e.g. user tapped) — resolves `done`
  cancel: () => void        // abort without resolving a usable blob
  done: Promise<Blob>
}

export interface RecordOptions {
  onLevel?: (level: number) => void   // 0..1 mic level for the animated indicator
  silenceMs?: number                  // quiet time after speech that ends the turn
  maxMs?: number                      // hard cap on a single turn
  minSpeechMs?: number                // require this much sound before silence can end it
  speechThreshold?: number            // RMS level (0..1) counted as "speaking"
  noSpeechMs?: number                 // if nobody speaks at all, give up this quickly
}

export const canRecord = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof (window as any).MediaRecorder !== 'undefined'

export async function startRecording(opts: RecordOptions = {}): Promise<Recording> {
  // Matches liveStt: a turn ends on a real pause, not a mid-sentence one, and the
  // cap is a runaway guard rather than a limit on how much you may say.
  const { onLevel, silenceMs = 1500, maxMs = 180000, minSpeechMs = 350, speechThreshold = 0.045, noSpeechMs = 8000 } = opts

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

  let mr: MediaRecorder
  try { mr = new MediaRecorder(stream, { mimeType: 'audio/webm' }) } catch { mr = new MediaRecorder(stream) }
  const chunks: BlobPart[] = []
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }

  // --- level / silence detection ---
  const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
  const ctx: AudioContext | null = AudioCtx ? new AudioCtx() : null
  const analyser = ctx ? ctx.createAnalyser() : null
  if (ctx && analyser) {
    analyser.fftSize = 512
    ctx.createMediaStreamSource(stream).connect(analyser)
  }
  const buf = analyser ? new Uint8Array(analyser.fftSize) : null

  const startedAt = Date.now()
  let speechAccum = 0        // ms of detected speech
  let lastLoudAt = Date.now()
  let cancelled = false
  let raf = 0
  let maxTimer: any = 0

  const cleanup = () => {
    cancelAnimationFrame(raf)
    clearTimeout(maxTimer)
    try { stream.getTracks().forEach((t) => t.stop()) } catch {}
    try { ctx?.close() } catch {}
  }

  let resolveDone: (b: Blob) => void
  const done = new Promise<Blob>((resolve) => { resolveDone = resolve })

  mr.onstop = () => {
    cleanup()
    if (cancelled) { resolveDone(new Blob([])); return }
    resolveDone(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }))
  }

  const finish = () => { try { if (mr.state !== 'inactive') mr.stop() } catch { cleanup(); resolveDone(new Blob(chunks)) } }

  // Poll the analyser each frame for the RMS level.
  const tick = () => {
    if (analyser && buf) {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
      const rms = Math.sqrt(sum / buf.length)
      onLevel?.(Math.min(1, rms * 3))
      const now = Date.now()
      if (rms >= speechThreshold) { speechAccum += 16; lastLoudAt = now }
      // End the turn only after the speaker actually spoke, then fell silent.
      if (speechAccum >= minSpeechMs && now - lastLoudAt >= silenceMs) { finish(); return }
      // Nobody spoke at all within the grace window — give up so idle listening
      // (waiting for a follow-up) doesn't hold the mic open for the full maxMs.
      if (speechAccum === 0 && now - startedAt >= noSpeechMs) { finish(); return }
    }
    raf = requestAnimationFrame(tick)
  }

  mr.start()
  raf = requestAnimationFrame(tick)
  maxTimer = setTimeout(finish, maxMs)

  return {
    stop: finish,
    cancel: () => { cancelled = true; finish() },
    done,
  }
}
