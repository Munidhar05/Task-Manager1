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

// ------------------------------------------------------------- media length
//
// Call recordings, and clips recorded in a browser, are MediaRecorder WebM
// written in timeslices: streamed out while still being recorded, so the
// header has no Duration and the file has no Cues. Browsers then report
// duration = Infinity until they have read to the end, which leaves a player
// at 0:00 with a waveform that cannot seek, and a video tile with no length.
//
// The usual fix, seeking the element far past the end and reading the duration
// it finds there, makes the browser read the whole file to get there: 13.7 MB
// of requests for a 5.7 MB, 90-second recording (measured), and a half-hour
// call is about 30 MB at MediaRecorder's default 128 kbps. So the length is
// read from the end of the file instead. Its last Cluster carries the time of
// the last frame, which is exactly the duration the browser settles on once it
// gets there (to the millisecond, on every recording tried). 128 KB always
// holds an audio Cluster, which spans about a second; a video Cluster runs from
// one keyframe to the next, so video gets a second, 2 MB look.
//
// Anything that still has no answer (another container, a file cut short) gets
// the seek-past-the-end trick, on a throwaway muted element so the player
// itself is never moved and never heard, and only when the file is small
// enough for reading all of it to be cheap.

const TAIL_BYTES = [128 * 1024, 2 * 1024 * 1024]
const PROBE_MAX_BYTES = 2 * 1024 * 1024
const CLUSTER_START = [0x1f, 0x43, 0xb6, 0x75]
const TIMECODE = 0xe7, SIMPLE_BLOCK = 0xa3, BLOCK_GROUP = 0xa0, BLOCK = 0xa1

// An EBML variable-length number at `p`, as [value, byte length]. Element ids
// keep their length marker (`id`); a size of all ones means "unknown" and comes
// back as -1. Null when the bytes run out.
function vint(b: Uint8Array, p: number, id = false): [number, number] | null {
  const first = b[p]
  if (!first) return null
  let len = 1
  while (!(first & (0x80 >> (len - 1)))) len++
  if (p + len > b.length) return null
  let v = id ? first : first & (0xff >> len)
  let unknown = !id && v === 0xff >> len
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[p + i]
    if (b[p + i] !== 0xff) unknown = false
  }
  return [unknown ? -1 : v, len]
}

// A Block starts with its track number, then its time relative to its Cluster
// as a signed 16-bit count of milliseconds.
function blockTime(b: Uint8Array, p: number, end: number) {
  const track = vint(b, p)
  if (!track || p + track[1] + 2 > end) return 0
  const t = (b[p + track[1]] << 8) | b[p + track[1] + 1]
  return t > 0x7fff ? t - 0x10000 : t
}

// Milliseconds to the last frame of the Cluster starting at `at`, provided it
// reads cleanly to the very end of `b`. That condition is also what rules out
// the same four bytes turning up by chance inside a frame.
function clusterEnd(b: Uint8Array, at: number): number | null {
  const size = vint(b, at + 4)
  if (!size) return null
  let p = at + 4 + size[1]
  if (size[0] >= 0 && p + size[0] !== b.length) return null
  let base: number | null = null, last = 0
  while (p < b.length) {
    const el = vint(b, p, true)
    const len = el && vint(b, p + el[1])
    if (!el || !len || len[0] < 0) return null
    const body = p + el[1] + len[1], next = body + len[0]
    if (next > b.length) return null
    if (el[0] === TIMECODE) {
      base = 0
      for (let i = body; i < next; i++) base = base * 256 + b[i]
    } else if (el[0] === SIMPLE_BLOCK) {
      last = Math.max(last, blockTime(b, body, next))
    } else if (el[0] === BLOCK_GROUP) {
      for (let q = body; q < next;) {
        const child = vint(b, q, true)
        const clen = child && vint(b, q + child[1])
        if (!child || !clen || clen[0] < 0) break
        const cb = q + child[1] + clen[1]
        if (child[0] === BLOCK) last = Math.max(last, blockTime(b, cb, cb + clen[0]))
        q = cb + clen[0]
      }
    }
    p = next
  }
  return base === null ? null : base + last
}

// Seconds to the last frame of a WebM, from the end of the file. Assumes the
// 1 ms timecode scale every MediaRecorder writes.
function webmEnd(b: Uint8Array): number | null {
  for (let i = b.length - 4; i >= 0; i--) {
    if (b[i] !== CLUSTER_START[0] || b[i + 1] !== CLUSTER_START[1] || b[i + 2] !== CLUSTER_START[2] || b[i + 3] !== CLUSTER_START[3]) continue
    const ms = clusterEnd(b, i)
    if (ms !== null) return ms > 0 && ms < 864e5 ? ms / 1000 : null
  }
  return null
}

// The last `bytes` bytes of a file of `size` bytes. Asked for from an offset,
// not as a suffix: the server's range parser answers a suffix longer than the
// file (bytes=-131072 on a 60 KB recording) with 416, not with the whole file.
async function tail(src: string, bytes: number, size: number) {
  const ctl = new AbortController()
  const res = await fetch(src, { headers: { Range: `bytes=${Math.max(0, size - bytes)}-` }, signal: ctl.signal })
  // Anything but a partial answer is an error, or the whole file from
  // something that ignores Range: stop it rather than download it.
  if (res.status !== 206) { ctl.abort(); return null }
  return new Uint8Array(await res.arrayBuffer())
}

async function sizeOf(src: string) {
  const res = await fetch(src, { method: 'HEAD' })
  const n = Number(res.headers.get('content-length'))
  return res.ok && n > 0 ? n : 0
}

function probe(src: string, video: boolean): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement(video ? 'video' : 'audio')
    const timer = window.setTimeout(() => done(null), 20000)
    function done(d: number | null) {
      window.clearTimeout(timer)
      el.onloadedmetadata = el.ondurationchange = el.onerror = null
      el.removeAttribute('src')
      try { el.load() } catch { /* already released */ }
      resolve(d !== null && isFinite(d) && d > 0 ? d : null)
    }
    el.muted = true
    el.preload = 'metadata'
    el.onloadedmetadata = () => { if (isFinite(el.duration)) done(el.duration); else el.currentTime = 1e101 }
    el.ondurationchange = () => { if (isFinite(el.duration) && el.duration > 0) done(el.duration) }
    el.onerror = () => done(null)
    el.src = src
  })
}

async function findLength(src: string, video: boolean, size: number) {
  const total = size > 0 ? size : await sizeOf(src)
  if (!total) return null
  for (const n of video ? TAIL_BYTES : TAIL_BYTES.slice(0, 1)) {
    const b = await tail(src, n, total)
    if (!b) break
    const s = webmEnd(b)
    if (s) return s
    if (n >= total) break // that was the whole file
  }
  return total <= PROBE_MAX_BYTES ? probe(src, video) : null
}

// By message id, so the thread and the panel showing the same recording, or a
// video tile scrolled away and back, ask once.
const lengths = new Map<string, Promise<number | null>>()

// The length of a recording whose element reports Infinity, in seconds; null
// when it cannot be found cheaply. `size` (bytes), when the caller has it,
// saves asking the server for it.
export function mediaLength(id: string, src: string, opts: { video?: boolean; size?: number } = {}): Promise<number | null> {
  let p = lengths.get(id)
  if (!p) {
    p = findLength(src, !!opts.video, opts.size || 0).catch(() => {
      // Offline, or the connection dropped: worth asking again next time.
      lengths.delete(id)
      return null
    })
    lengths.set(id, p)
  }
  return p
}

export default function VoicePlayer({ src, id, mine, size }: { src: string; id: string; mine?: boolean; size?: number }) {
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
    // Something else can pause this element (another note starting, a video
    // in the media viewer), so the icon follows the element's own events
    // rather than only this component's clicks.
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('durationchange', onMeta)
    el.addEventListener('ended', onEnd)
    el.addEventListener('error', onErr)
    // A cached file can have its metadata before this effect runs.
    if (el.readyState >= 1) onMeta()
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('durationchange', onMeta)
      el.removeEventListener('ended', onEnd)
      el.removeEventListener('error', onErr)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
    }
  }, [])

  // No length in the header (a call recording): find it without touching the
  // element, so the total shows and the waveform seeks from the start. The
  // element seeks fine to a time past what it has read; it just cannot say
  // how long the file is until it reaches the end.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let live = true
    const learn = () => {
      if (el.duration !== Infinity) return
      mediaLength(id, src, { size }).then((d) => {
        // Played to the end meanwhile: the element's own figure stands.
        if (live && d && !isFinite(el.duration)) setDur(d)
      })
    }
    learn()
    el.addEventListener('loadedmetadata', learn)
    return () => { live = false; el.removeEventListener('loadedmetadata', learn) }
  }, [id, src, size])

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
