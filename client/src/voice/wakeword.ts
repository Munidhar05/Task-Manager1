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
const THRESHOLD = Number(import.meta.env.VITE_WAKEWORD_THRESHOLD) || 0.5
// Where onnxruntime-web loads its WASM from. Defaults to a CDN pinned to the
// installed version; set VITE_ORT_WASM_PATH to a self-hosted path for offline.
const ORT_WASM = (import.meta.env.VITE_ORT_WASM_PATH as string | undefined) || 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/'

export const wakeWordConfigured = () => ENABLED

// openWakeWord streaming constants.
const SR = 16000
const CHUNK = 1280            // 80 ms hops
const MEL_BINS = 32
const EMB_WINDOW = 76         // mel frames per embedding
const WW_EMBS = 16           // embeddings per wakeword input
const EMB_STRIDE = 8          // mel frames between embeddings
const NEEDED_MEL = EMB_WINDOW + (WW_EMBS - 1) * EMB_STRIDE // 196
const AUDIO_KEEP = SR * 2     // ~2 s rolling buffer
const REFRACTORY_MS = 1500

interface WakeOptions { enabled: boolean; onWake: () => void }

// Subscribe to the wake word while `enabled`. Safe to call always.
export function useWakeWord({ enabled, onWake }: WakeOptions) {
  const onWakeRef = useRef(onWake)
  onWakeRef.current = onWake

  useEffect(() => {
    if (!enabled || !ENABLED) return
    let stop = () => {}
    let cancelled = false

    ;(async () => {
      try {
        const ort: any = await import('onnxruntime-web')
        ort.env.wasm.wasmPaths = ORT_WASM
        const opts = { executionProviders: ['wasm'] }
        const [mel, emb, ww] = await Promise.all([
          ort.InferenceSession.create(MEL_PATH, opts),
          ort.InferenceSession.create(EMB_PATH, opts),
          ort.InferenceSession.create(WW_PATH, opts),
        ])
        if (cancelled) return

        const detector = createDetector(ort, mel, emb, ww, () => onWakeRef.current())
        stop = await startMicPump(detector)
      } catch (err) {
        console.warn('[wakeword] disabled:', (err as any)?.message || err)
      }
    })()

    return () => { cancelled = true; stop() }
  }, [enabled])
}

// Build the frame processor: accumulates audio and scores the wake word.
function createDetector(ort: any, mel: any, emb: any, ww: any, onWake: () => void) {
  let audio = new Float32Array(0)
  let lastFire = 0
  let busy = false

  const runMel = async (samples: Float32Array): Promise<Float32Array[]> => {
    // openWakeWord's melspec model expects audio in int16 value range as float.
    const x = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) x[i] = samples[i] * 32767
    const out = await mel.run({ [mel.inputNames[0]]: new ort.Tensor('float32', x, [1, x.length]) })
    const t = out[mel.outputNames[0]]
    // Squeeze to [frames, MEL_BINS] and apply the openWakeWord scaling.
    const frames = t.data.length / MEL_BINS
    const rows: Float32Array[] = []
    for (let f = 0; f < frames; f++) {
      const row = new Float32Array(MEL_BINS)
      for (let b = 0; b < MEL_BINS; b++) row[b] = (t.data[f * MEL_BINS + b] as number) / 10 + 2
      rows.push(row)
    }
    return rows
  }

  const runEmb = async (window: Float32Array): Promise<Float32Array> => {
    // window is EMB_WINDOW*MEL_BINS, shaped [1, 76, 32, 1].
    const out = await emb.run({ [emb.inputNames[0]]: new ort.Tensor('float32', window, [1, EMB_WINDOW, MEL_BINS, 1]) })
    return out[emb.outputNames[0]].data as Float32Array
  }

  const score = async (): Promise<void> => {
    if (audio.length < AUDIO_KEEP * 0.9) return
    const rows = await runMel(audio)
    if (rows.length < NEEDED_MEL) return
    const melTail = rows.slice(rows.length - NEEDED_MEL)
    // 16 embeddings from sliding 76-frame windows, stride 8.
    const embs = new Float32Array(WW_EMBS * 96)
    for (let i = 0; i < WW_EMBS; i++) {
      const win = new Float32Array(EMB_WINDOW * MEL_BINS)
      for (let f = 0; f < EMB_WINDOW; f++) win.set(melTail[i * EMB_STRIDE + f], f * MEL_BINS)
      const e = await runEmb(win)
      embs.set(e.subarray(0, 96), i * 96)
    }
    const out = await ww.run({ [ww.inputNames[0]]: new ort.Tensor('float32', embs, [1, WW_EMBS, 96]) })
    const s = (out[ww.outputNames[0]].data[0] as number)
    const now = Date.now()
    if (s >= THRESHOLD && now - lastFire > REFRACTORY_MS) { lastFire = now; onWake() }
  }

  // Called with each new mono 16k frame.
  return async (frame: Float32Array) => {
    const merged = new Float32Array(audio.length + frame.length)
    merged.set(audio); merged.set(frame, audio.length)
    audio = merged.length > AUDIO_KEEP ? merged.subarray(merged.length - AUDIO_KEEP) : merged
    if (busy) return
    busy = true
    try { await score() } catch (e) { /* keep listening */ } finally { busy = false }
  }
}

// Open the mic at 16 kHz and pump CHUNK-sized frames to `onFrame`. Returns a stop fn.
async function startMicPump(onFrame: (f: Float32Array) => void): Promise<() => void> {
  const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
  const ctx: AudioContext = new AudioCtx({ sampleRate: SR })
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
  const src = ctx.createMediaStreamSource(stream)
  const node = ctx.createScriptProcessor(4096, 1, 1)
  let acc = new Float32Array(0)

  node.onaudioprocess = (e) => {
    const inp = e.inputBuffer.getChannelData(0)
    const merged = new Float32Array(acc.length + inp.length)
    merged.set(acc); merged.set(inp, acc.length)
    let off = 0
    while (merged.length - off >= CHUNK) { onFrame(merged.slice(off, off + CHUNK)); off += CHUNK }
    acc = merged.subarray(off)
  }
  src.connect(node)
  node.connect(ctx.destination)

  return () => {
    try { node.disconnect() } catch {}
    try { src.disconnect() } catch {}
    try { stream.getTracks().forEach((t) => t.stop()) } catch {}
    try { ctx.close() } catch {}
  }
}
