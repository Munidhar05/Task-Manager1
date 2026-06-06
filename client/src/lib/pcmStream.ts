// Capture microphone audio and emit base64-encoded little-endian 16-bit PCM @ 16kHz
// frames — the format Sarvam's streaming WebSocket expects. MediaRecorder only
// produces webm/opus, so we tap the raw samples via the Web Audio API instead.
//
// Returns a stop() function that tears down the graph and mic.

export interface PcmStream {
  stop: () => void
}

// Float32 [-1,1] -> Int16 little-endian bytes -> base64 (browser-safe, no Buffer).
function float32ToBase64Pcm16(input: Float32Array): string {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const bytes = new Uint8Array(out.buffer)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

// Linear-ish downsample from the AudioContext rate (usually 44.1/48kHz) to 16kHz.
function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  const target = 16000
  if (inputRate === target) return input
  const ratio = inputRate / target
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(Math.floor((i + 1) * ratio), input.length)
    let sum = 0, n = 0
    for (let j = start; j < end; j++) { sum += input[j]; n++ }
    out[i] = n ? sum / n : input[start] || 0
  }
  return out
}

// Start streaming mic PCM to `onFrame` (called with each base64 chunk).
// `onError` fires if mic access fails.
export async function startPcmStream(
  onFrame: (base64: string) => void,
  onError: (message: string) => void,
): Promise<PcmStream> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
  } catch {
    onError('Microphone permission denied. Allow mic access and try again.')
    return { stop: () => {} }
  }

  const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
  const ctx: AudioContext = new AudioCtx()
  const source = ctx.createMediaStreamSource(stream)

  // ScriptProcessorNode is deprecated but universally supported and simplest for
  // pulling raw frames. 4096-sample buffer ≈ 85ms at 48kHz — low latency, low overhead.
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0)
    const down = downsampleTo16k(input, ctx.sampleRate)
    onFrame(float32ToBase64Pcm16(down))
  }
  source.connect(processor)
  processor.connect(ctx.destination) // required for onaudioprocess to fire in some browsers

  return {
    stop: () => {
      try { processor.disconnect() } catch {}
      try { source.disconnect() } catch {}
      try { ctx.close() } catch {}
      stream.getTracks().forEach((t) => t.stop())
    },
  }
}
