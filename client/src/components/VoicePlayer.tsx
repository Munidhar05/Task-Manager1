import React, { useEffect, useRef, useState } from 'react'
import { Ic } from '../ui'

// A voice note plays where it sits, the way it does in WhatsApp.
//
// Built on a bare <audio> with our own controls rather than `<audio controls>`,
// for two reasons. The native player carries a kebab menu whose first item is
// Download — offering to save a colleague's voice note to disk every time you
// glance at it, which is not a choice this UI should be pushing. And the native
// widget is a different shape, size and colour in every browser, so it never
// sits right inside a chat bubble.
//
// Downloading is still possible: it lives in the message's ⋯ menu with every
// other file action, which is where someone who actually wants the file will
// look. It is just no longer the most prominent thing on the message.

const SPEEDS = [1, 1.5, 2]

// Deterministic bar heights from the message id, so a note looks the same every
// render without decoding the audio. Real waveform extraction would mean
// fetching and decoding the whole file just to draw 28 rectangles.
function bars(seed: string, n = 28) {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    h = (h * 1103515245 + 12345) >>> 0
    out.push(0.25 + ((h >>> 16) % 1000) / 1000 * 0.75)
  }
  return out
}

const fmt = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

export default function VoicePlayer({ src, id, mine }: { src: string; id: string; mine?: boolean }) {
  const ref = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [at, setAt] = useState(0)
  const [dur, setDur] = useState(0)
  const [rate, setRate] = useState(1)
  const [broken, setBroken] = useState(false)
  const shape = useRef(bars(id)).current

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onTime = () => setAt(el.currentTime)
    const onMeta = () => { if (isFinite(el.duration)) setDur(el.duration) }
    const onEnd = () => { setPlaying(false); setAt(0); el.currentTime = 0 }
    const onErr = () => setBroken(true)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('durationchange', onMeta)
    el.addEventListener('ended', onEnd)
    el.addEventListener('error', onErr)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('durationchange', onMeta)
      el.removeEventListener('ended', onEnd)
      el.removeEventListener('error', onErr)
    }
  }, [])

  const toggle = async () => {
    const el = ref.current
    if (!el) return
    if (playing) { el.pause(); setPlaying(false); return }
    // Only one voice note at a time — starting this one stops any other, which
    // is what you want when thumbing down a thread full of them.
    for (const other of Array.from(document.querySelectorAll('audio.vp-audio'))) {
      if (other !== el) { try { (other as HTMLAudioElement).pause() } catch {} }
    }
    try { await el.play(); setPlaying(true) } catch { setBroken(true) }
  }

  const cycleRate = () => {
    const next = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length]
    setRate(next)
    if (ref.current) ref.current.playbackRate = next
  }

  // Seek by clicking anywhere on the waveform.
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el || !dur) return
    const box = e.currentTarget.getBoundingClientRect()
    const pct = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
    el.currentTime = pct * dur
    setAt(el.currentTime)
  }

  const progress = dur ? at / dur : 0
  // Before metadata loads, duration is unknown — show elapsed rather than a
  // confident-looking 0:00 total that is about to change.
  const label = dur ? fmt(dur - at) : fmt(at)

  return (
    <div className={'vp' + (mine ? ' mine' : '')}>
      <audio ref={ref} className="vp-audio" src={src} preload="metadata" />
      <button className="vp-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play voice note'} disabled={broken}>
        <Ic name={playing ? 'pause' : 'play'} size={15} />
      </button>
      <div className="vp-wave" onClick={seek} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Seek">
        {shape.map((h, i) => (
          <span key={i} className={'vp-bar' + (i / shape.length <= progress ? ' on' : '')} style={{ height: `${Math.round(h * 100)}%` }} />
        ))}
      </div>
      <span className="vp-time">{broken ? '—' : label}</span>
      <button className="vp-rate" onClick={cycleRate} aria-label={`Playback speed ${rate}x`} title="Playback speed" disabled={broken}>{rate}×</button>
    </div>
  )
}
