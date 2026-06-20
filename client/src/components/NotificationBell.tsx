import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'

interface Notif { id: string; type: string; message: string; task_id?: string; read: number; created_at: string }

const ICON: Record<string, string> = {
  task_submitted: '📩', task_approved: '✅', task_reopened: '↩', task_assigned: '📌', task_comment: '💬', chat_message: '💬',
}

export default function NotificationBell() {
  const [items, setItems] = useState<Notif[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [vibrating, setVibrating] = useState(false)
  // Sound preference persists across sessions; on by default.
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('notifSound') !== 'off')
  const ref = useRef<HTMLDivElement>(null)
  const prevUnread = useRef<number | null>(null) // null until first load, so we don't shake on mount
  // Shared, lazily-created audio context. Browsers block audio until a user
  // gesture, so it's resumed on play — the first click anywhere unlocks it.
  const audioCtx = useRef<AudioContext | null>(null)
  // Mirror soundOn into a ref so the polling interval (created once on mount)
  // always reads the current preference instead of a stale closure value.
  const soundOnRef = useRef(soundOn)
  useEffect(() => { soundOnRef.current = soundOn }, [soundOn])

  // Synthesize a short two-note "ding-dong" chime (no audio file needed).
  const playChime = () => {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
      if (!Ctx) return
      const ctx = audioCtx.current || (audioCtx.current = new Ctx())
      if (ctx.state === 'suspended') ctx.resume()
      const t0 = ctx.currentTime
      for (const n of [{ f: 880, at: 0 }, { f: 1174.7, at: 0.13 }]) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = n.f
        osc.connect(gain); gain.connect(ctx.destination)
        const start = t0 + n.at
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(0.2, start + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4)
        osc.start(start)
        osc.stop(start + 0.42)
      }
    } catch { /* autoplay blocked or unsupported — fail silently */ }
  }

  const load = () => api.get('/notifications').then((d) => {
    setItems(d.items)
    setUnread(d.unread)
    // A new notification just arrived → vibrate the bell and play the chime.
    if (prevUnread.current !== null && d.unread > prevUnread.current) {
      setVibrating(true)
      setTimeout(() => setVibrating(false), 800)
      if (soundOnRef.current) playChime()
    }
    prevUnread.current = d.unread
  }).catch(() => {})

  useEffect(() => {
    load()
    const iv = setInterval(load, 15000) // poll every 15s
    return () => clearInterval(iv)
  }, [])

  // close on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (next && unread > 0) { await api.post('/notifications/read-all'); setUnread(0); load() }
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn btn-ghost" onClick={toggle} title="Notifications" style={{ fontSize: 18, position: 'relative', lineHeight: 1 }}>
        <span className={vibrating ? 'bell-vibrate' : ''} style={{ display: 'inline-block' }}>🔔</span>
        {unread > 0 && (
          <span style={{ position: 'absolute', top: -2, right: -2, background: '#ef4444', color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 700, minWidth: 16, height: 16, display: 'grid', placeItems: 'center', padding: '0 4px' }}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 330, maxHeight: 420, overflowY: 'auto', zIndex: 100, boxShadow: '0 10px 30px rgba(0,0,0,.15)' }}>
          <div className="card-head spread">
            <h3 style={{ fontSize: 14, margin: 0 }}>Notifications</h3>
            <button
              className="btn btn-ghost btn-sm"
              title={soundOn ? 'Mute notification sound' : 'Unmute notification sound'}
              onClick={() => setSoundOn((on) => {
                const next = !on
                localStorage.setItem('notifSound', next ? 'on' : 'off')
                if (next) playChime() // preview the chime when turning it on
                return next
              })}
              style={{ fontSize: 16, lineHeight: 1, padding: '2px 6px' }}
            >
              {soundOn ? '🔔' : '🔕'}
            </button>
          </div>
          {items.length === 0 && <div className="empty" style={{ padding: 24 }}>You're all caught up 🎉</div>}
          {items.map((n) => (
            <div key={n.id} style={{ padding: '11px 14px', borderTop: '1px solid var(--border)', background: n.read ? 'var(--surface)' : 'rgba(197,86,15,.08)', fontSize: 13, display: 'flex', gap: 8 }}>
              <span>{ICON[n.type] || '•'}</span>
              <div>
                <div>{n.message}</div>
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{new Date(n.created_at).toLocaleString()}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
