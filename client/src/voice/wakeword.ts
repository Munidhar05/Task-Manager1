// Wake-word ("hey BTM") detection using openWakeWord models, run fully on-device
// in the browser / Android WebView via onnxruntime-web (WASM). Free & unlimited —
// no cloud, no per-user licensing.
//
// openWakeWord is a 3-stage ONNX pipeline:
//   audio → [melspectrogram] → mel frames → [embedding] → 96-d vectors → [wakeword] → score
// The first two models are fixed (shared by every wake word); the third is the
// custom "hey BTM" model you train (see docs/VOICE_ASSISTANT_SETUP.md).
//
// It is OPTIONAL and config-gated: with VITE_WAKEWORD_ENABLED unset (or the model
// files missing) it no-ops and the app uses the tap-the-mic button. Any load/runtime
// error disables it silently — it can never break the app.
//
// NOTE: this browser port needs on-device tuning (threshold, and self-hosting the
// ORT wasm for offline use). Constants below follow the openWakeWord reference.
import { useEffect, useRef } from 'react'

const ENABLED = (import.meta.env.VITE_WAKEWORD_ENABLED as string | undefined) === 'true'
const MEL_PATH = (import.meta.env.VITE_WAKEWORD_MELSPEC_PATH as string | undefined) || '/wakeword/melspectrogram.onnx'
const EMB_PATH = (import.meta.env.VITE_WAKEWORD_EMBEDDING_PATH as string | undefined) || '/wakeword/embedding_model.onnx'
const WW_PATH = (import.meta.env.VITE_WAKEWORD_MODEL_PATH as string | undefined) || '/wakeword/hey_btm.onnx'
// Detection threshold. A localStorage override wins so you can TUNE LIVE — set
//   localStorage.setItem('wakeword_threshold','0.2')  then reload (no dev-server
// restart needed). Falls back to the env default, then 0.5.
const lsThreshold = (() => { try { return localStorage.getItem('wakeword_threshold') } catch { return null } })()
const THRESHOLD = Number(lsThreshold || import.meta.env.VITE_WAKEWORD_THRESHOLD) || 0.5
// Where onnxruntime-web loads its WASM from. Defaults to a CDN pinned to the
// installed version; set VITE_ORT_WASM_PATH to a self-hosted path for offline.
const ORT_WASM = (import.meta.env.VITE_ORT_WASM_PATH as string | undefined) || 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/'

// Log every scored frame above a floor — invaluable for tuning the threshold.
const DEBUG = (import.meta.env.VITE_WAKEWORD_DEBUG as string | undefined) === 'true'

export const wakeWordConfigured = () => ENABLED

// The spoken phrase to SHOW users. Must match whatever model is loaded — while the
// placeholder "hey jarvis" model is active, the UI must say "hey jarvis" (telling
// people to say "hey BTM" against the jarvis model means it never fires). Set
// VITE_WAKEWORD_PHRASE to override; defaults to the real target phrase.
export const wakeWordPhrase = () => (import.meta.env.VITE_WAKEWORD_PHRASE as string | undefined) || 'hey BTM'

// What the detector is doing, so the UI can say so instead of failing silently.
export type WakeStatus = 'off' | 'loading' | 'awaiting-gesture' | 'listening' | 'error'

// openWakeWord streaming constants (verified against the reference models).
const SR = 16000
const CHUNK = 1280            // 80 ms hops
const MEL_BINS = 32
const EMB_WINDOW = 76         // mel frames per embedding
const WW_EMBS = 16            // embeddings per wakeword input
// The melspectrogram model uses a 640-sample window with a 160-sample hop, so a
// 1280-sample chunk yields exactly 8 new mel frames — which is also the embedding
// stride. That lets us advance the pipeline incrementally: feed melspec the last
// 1760 samples for 8 fresh frames, then take ONE embedding from the newest 76
// frames. (Recomputing 2 s of mel + all 16 embeddings each chunk was ~19x slower.)
const MEL_HOP = 160
const MEL_WIN = 640
const MEL_FEED = MEL_WIN + (CHUNK / MEL_HOP - 1) * MEL_HOP // 1760
const REFRACTORY_MS = 1500

interface WakeOptions { enabled: boolean; onWake: () => void; onStatus?: (s: WakeStatus, detail?: string) => void }

// Subscribe to the wake word while `enabled`. Safe to call always.
export function useWakeWord({ enabled, onWake, onStatus }: WakeOptions) {
  const onWakeRef = useRef(onWake)
  const onStatusRef = useRef(onStatus)
  onWakeRef.current = onWake
  onStatusRef.current = onStatus

  useEffect(() => {
    const say = (s: WakeStatus, d?: string) => onStatusRef.current?.(s, d)
    if (!ENABLED) { say('off'); return }
    if (!enabled) return
    let stop = () => {}
    let cancelled = false

    ;(async () => {
      try {
        say('loading')
        const ort: any = await import('onnxruntime-web')
        ort.env.wasm.wasmPaths = ORT_WASM
        // Single-threaded: multi-threaded WASM needs SharedArrayBuffer, which needs
        // COOP/COEP headers we don't serve. Without this, session creation fails.
        ort.env.wasm.numThreads = 1
        ort.env.wasm.simd = true
        ort.env.wasm.proxy = false

        const opts = { executionProviders: ['wasm'] }
        const [mel, emb, ww] = await Promise.all([
          ort.InferenceSession.create(MEL_PATH, opts),
          ort.InferenceSession.create(EMB_PATH, opts),
          ort.InferenceSession.create(WW_PATH, opts),
        ])
        if (cancelled) return

        const detector = createDetector(ort, mel, emb, ww, () => onWakeRef.current())
        stop = await startMicPump(detector, say)
        if (cancelled) { stop(); return }
      } catch (err) {
        const msg = (err as any)?.message || String(err)
        console.error('[wakeword] failed to start:', err)
        say('error', msg)
      }
    })()

    return () => { cancelled = true; stop() }
  }, [enabled])
}

// Build the frame processor: advances the 3-stage pipeline one 80 ms chunk at a
// time, keeping rolling rings of mel frames and embeddings. Verified against
// openWakeWord's reference clip (peak score 1.0 on the target utterance).
function createDetector(ort: any, mel: any, emb: any, ww: any, onWake: () => void) {
  let raw = new Float32Array(0)          // last MEL_FEED samples
  const melRing: Float32Array[] = []     // newest mel frames (32 bins each)
  const embRing: Float32Array[] = []     // newest 96-d embeddings
  let lastFire = 0

  // Feed the newest MEL_FEED samples -> exactly CHUNK/MEL_HOP fresh mel frames.
  const runMel = async (): Promise<void> => {
    const x = new Float32Array(raw.length)
    // openWakeWord's melspec model expects audio in int16 value range as float.
    for (let i = 0; i < raw.length; i++) x[i] = raw[i] * 32767
    const out = await mel.run({ [mel.inputNames[0]]: new ort.Tensor('float32', x, [1, x.length]) })
    const t = out[mel.outputNames[0]]
    const frames = t.data.length / MEL_BINS
    for (let f = 0; f < frames; f++) {
      const row = new Float32Array(MEL_BINS)
      for (let b = 0; b < MEL_BINS; b++) row[b] = (t.data[f * MEL_BINS + b] as number) / 10 + 2
      melRing.push(row)
    }
    while (melRing.length > EMB_WINDOW + 8) melRing.shift()
  }

  // One embedding from the newest 76 mel frames. Because each chunk adds exactly
  // 8 frames, successive embeddings are 8 frames apart — the required stride.
  const runEmb = async (): Promise<void> => {
    const win = new Float32Array(EMB_WINDOW * MEL_BINS)
    const start = melRing.length - EMB_WINDOW
    for (let f = 0; f < EMB_WINDOW; f++) win.set(melRing[start + f], f * MEL_BINS)
    const out = await emb.run({ [emb.inputNames[0]]: new ort.Tensor('float32', win, [1, EMB_WINDOW, MEL_BINS, 1]) })
    embRing.push(Float32Array.from((out[emb.outputNames[0]].data as Float32Array).subarray(0, 96)))
    while (embRing.length > WW_EMBS) embRing.shift()
  }

  const score = async (): Promise<void> => {
    if (raw.length < MEL_FEED) return
    await runMel()
    if (melRing.length < EMB_WINDOW) return
    await runEmb()
    if (embRing.length < WW_EMBS) return
    const embs = new Float32Array(WW_EMBS * 96)
    for (let i = 0; i < WW_EMBS; i++) embs.set(embRing[i], i * 96)
    const out = await ww.run({ [ww.inputNames[0]]: new ort.Tensor('float32', embs, [1, WW_EMBS, 96]) })
    const s = (out[ww.outputNames[0]].data[0] as number)
    if (DEBUG && s > 0.05) console.info(`[wakeword] score ${s.toFixed(3)}${s >= THRESHOLD ? ' *** WAKE ***' : ''}`)
    const now = Date.now()
    if (s >= THRESHOLD && now - lastFire > REFRACTORY_MS) { lastFire = now; onWake() }
  }

  // Called with each new mono 16k frame. Chunks MUST be processed in order and
  // none may be dropped: each contributes exactly 8 mel frames, and skipping one
  // would break the embedding stride. A promise chain serializes them (a pass is
  // ~3 ms against an 80 ms budget, so this never backs up in practice).
  let chain: Promise<void> = Promise.resolve()
  return (frame: Float32Array) => {
    chain = chain.then(async () => {
      const merged = new Float32Array(raw.length + frame.length)
      merged.set(raw); merged.set(frame, raw.length)
      raw = merged.length > MEL_FEED ? merged.slice(merged.length - MEL_FEED) : merged
      await score()
    }).catch(() => { /* keep listening */ })
  }
}

// Browsers start an AudioContext SUSPENDED until the page sees a user gesture, and
// a suspended context never fires onaudioprocess — the mic would appear dead with no
// error. Resume it now if allowed; otherwise arm a one-shot gesture listener.
function ensureRunning(ctx: AudioContext, say: (s: WakeStatus, d?: string) => void): () => void {
  if (ctx.state === 'running') { say('listening'); return () => {} }
  const events = ['pointerdown', 'keydown', 'touchstart'] as const
  const cleanup = () => events.forEach((e) => window.removeEventListener(e, kick))
  const kick = () => {
    ctx.resume().then(() => {
      if (ctx.state === 'running') { cleanup(); say('listening') }
    }).catch(() => {})
  }
  ctx.resume().then(() => {
    if (ctx.state === 'running') say('listening')
    else { say('awaiting-gesture'); events.forEach((e) => window.addEventListener(e, kick, { passive: true })) }
  }).catch(() => {
    say('awaiting-gesture')
    events.forEach((e) => window.addEventListener(e, kick, { passive: true }))
  })
  return cleanup
}

// Linear resampler → 16 kHz. Passthrough when the source is already 16 kHz, so
// this can never affect the (rare) browser that honoured the sample-rate hint.
// A carried-over fractional read position keeps successive blocks continuous.
function makeResampler(inRate: number) {
  if (inRate === SR) return (b: Float32Array) => b
  const ratio = inRate / SR
  let pos = 0 // fractional read index into a virtual continuous input stream
  let prevTail = new Float32Array(0)
  return (block: Float32Array) => {
    const buf = new Float32Array(prevTail.length + block.length)
    buf.set(prevTail); buf.set(block, prevTail.length)
    const out: number[] = []
    while (pos + 1 < buf.length) {
      const i0 = Math.floor(pos), frac = pos - i0
      out.push(buf[i0] * (1 - frac) + buf[i0 + 1] * frac)
      pos += ratio
    }
    // Keep the last sample so the next block interpolates across the seam.
    const consumed = Math.floor(pos)
    prevTail = buf.slice(Math.max(0, consumed))
    pos -= consumed
    return Float32Array.from(out)
  }
}

// Open the mic and pump 16 kHz CHUNK-sized frames to `onFrame`. Returns a stop fn.
async function startMicPump(onFrame: (f: Float32Array) => void, say: (s: WakeStatus, d?: string) => void): Promise<() => void> {
  const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
  const ctx: AudioContext = new AudioCtx({ sampleRate: SR })
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
  const src = ctx.createMediaStreamSource(stream)
  const node = ctx.createScriptProcessor(4096, 1, 1)
  let acc = new Float32Array(0)
  // Chrome/Firefox honour `sampleRate: 16000`; Safari & some Android WebViews do
  // NOT and run at 48 kHz — feeding 48 kHz audio to the 16 kHz models is exactly
  // why detection can silently never fire. Resample whatever we actually got.
  const resample = makeResampler(ctx.sampleRate)
  if (ctx.sampleRate !== SR) console.warn(`[wakeword] context is ${ctx.sampleRate}Hz (not ${SR}Hz) — resampling to ${SR}Hz`)

  node.onaudioprocess = (e) => {
    const inp = resample(e.inputBuffer.getChannelData(0))
    const merged = new Float32Array(acc.length + inp.length)
    merged.set(acc); merged.set(inp, acc.length)
    let off = 0
    while (merged.length - off >= CHUNK) { onFrame(merged.slice(off, off + CHUNK)); off += CHUNK }
    // Copy, don't subarray: a view would retain the whole `merged` buffer.
    acc = merged.slice(off)
  }
  src.connect(node)
  // A ScriptProcessor only runs while connected downstream. It writes no output,
  // so nothing is played back — no mic echo.
  node.connect(ctx.destination)

  const unarm = ensureRunning(ctx, say)
  if (DEBUG) console.info(`[wakeword] mic open @${ctx.sampleRate}Hz, state=${ctx.state}`)

  return () => {
    unarm()
    try { node.disconnect() } catch {}
    try { src.disconnect() } catch {}
    try { stream.getTracks().forEach((t) => t.stop()) } catch {}
    try { ctx.close() } catch {}
  }
}
