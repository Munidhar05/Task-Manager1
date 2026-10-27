// Call sounds, synthesised with WebAudio — no file to ship and nothing to 404.
//
//   ringtone  — the callee's: a bright two-note trill, twice, every 2.6s, loud
//               enough to hear across a room (the old 0.16-gain sine beep was
//               easy to miss with a laptop's speakers turned down), plus the
//               phone buzzing where the browser can vibrate.
//   ringback  — the caller's "tring tring" while it rings at the other end, the
//               Indian ringback cadence (0.4s on, 0.2s off, 0.4s on, 2s off).
//               Without it a caller cannot tell ringing from a frozen screen.
//
// Browsers start an AudioContext suspended until the page has been interacted
// with. A tab someone has clicked on is fine; one opened and left alone may stay
// silent, so the context resumes on the next key or tap — the ring is then
// heard the moment they touch the page, and the visual ringer covers the gap.

type Stop = () => void

function context(): AudioContext | null {
  try { return new (window.AudioContext || (window as any).webkitAudioContext)() } catch { return null }
}

function unlockOnGesture(ctx: AudioContext): Stop {
  if (ctx.state !== 'suspended') return () => {}
  const wake = () => { ctx.resume().catch(() => {}) }
  ctx.resume().catch(() => {})
  const evs = ['pointerdown', 'keydown', 'touchstart'] as const
  for (const e of evs) window.addEventListener(e, wake, { capture: true })
  return () => { for (const e of evs) window.removeEventListener(e, wake, { capture: true }) }
}

function tone(ctx: AudioContext, freq: number, at: number, dur: number, gain: number, type: OscillatorType = 'sine') {
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = type
  o.frequency.value = freq
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(gain, at + 0.02)
  g.gain.setValueAtTime(gain, at + dur - 0.04)
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  o.connect(g); g.connect(ctx.destination)
  o.start(at); o.stop(at + dur + 0.02)
}

function loop(build: (ctx: AudioContext, t0: number) => void, periodMs: number, vibrate?: number[]): Stop {
  const ctx = context()
  if (!ctx) return () => {}
  const unlock = unlockOnGesture(ctx)
  let stopped = false
  const once = () => {
    if (stopped) return
    if (ctx.state === 'running') build(ctx, ctx.currentTime + 0.03)
    if (vibrate && document.visibilityState === 'visible') { try { navigator.vibrate?.(vibrate) } catch {} }
  }
  once()
  const iv = setInterval(once, periodMs)
  return () => {
    stopped = true
    clearInterval(iv)
    unlock()
    try { navigator.vibrate?.(0) } catch {}
    try { ctx.close() } catch {}
  }
}

export function startRingtone(): Stop {
  return loop((ctx, t) => {
    for (const burst of [0, 0.62]) {
      for (let i = 0; i < 6; i++) tone(ctx, i % 2 ? 1175 : 880, t + burst + i * 0.085, 0.08, 0.32, 'triangle')
    }
  }, 2600, [500, 250, 500])
}

export function startRingback(): Stop {
  return loop((ctx, t) => {
    // 400 + 450 Hz together, as Indian exchanges play it.
    for (const at of [0, 0.6]) { tone(ctx, 400, t + at, 0.4, 0.07); tone(ctx, 450, t + at, 0.4, 0.07) }
  }, 3000)
}
