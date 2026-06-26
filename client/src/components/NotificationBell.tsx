import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'

interface Notif { id: string; type: string; message: string; task_id?: string; read: number; created_at: string }

const ICON: Record<string, string> = {
  task_submitted: '📩', task_approved: '✅', task_reopened: '↩', task_assigned: '📌', task_comment: '💬', chat_message: '💬',
}

// 3D glossy notification logo: a round brand-orange button with a white outline
// bell. Original artwork — gradient body + a soft top gloss for the 3D look.
const BellIcon = ({ size = 33 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="nb-circ" x1="20" y1="2" x2="20" y2="38" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#e8853c" />
        <stop offset=".5" stopColor="#c5560f" />
        <stop offset="1" stopColor="#a3450b" />
      </linearGradient>
    </defs>
    {/* button: dark rim + gradient body + glossy top reflection */}
    <circle cx="20" cy="20" r="19" fill="#8f3c06" />
    <circle cx="20" cy="20" r="18" fill="url(#nb-circ)" />
    <ellipse cx="20" cy="12.5" rx="13.5" ry="7.5" fill="#ffffff" opacity=".2" />
    {/* white outline bell */}
    <g stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 25V18a6 6 0 0 1 12 0v7" />
      <line x1="11.5" y1="25" x2="28.5" y2="25" />
      <path d="M17.8 28a2.3 2.3 0 0 0 4.4 0" />
    </g>
  </svg>
)

// Line-style bell / bell-off for the small mute toggle inside the panel header
// (replaces the 🔔 / 🔕 emoji so it matches the topbar icon's quality).
const BellLineIcon = ({ size = 17 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
  </svg>
)
const BellOffIcon = ({ size = 17 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8.7 3A6 6 0 0 1 18 8c0 2.4.33 4.1.77 5.4" />
    <path d="M6.05 6.05A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h13" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </svg>
)

export default function NotificationBell() {
  const navigate = useNavigate()
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

  // Click a notification → jump to whatever it's about: the related task drawer, or
  // the Chats page for message notifications.
  const openNotif = (n: Notif) => {
    setOpen(false)
    if (n.type === 'chat_message') navigate('/chats')
    else if (n.task_id) navigate(`/tasks?task=${n.task_id}`)
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn btn-ghost bell-btn" onClick={toggle} title="Notifications" style={{ position: 'relative', lineHeight: 1, padding: 6 }}>
        <span className={vibrating ? 'bell-vibrate' : ''} style={{ display: 'inline-flex' }}><BellIcon /></span>
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
              className={'mute-toggle' + (soundOn ? ' on' : ' off')}
              title={soundOn ? 'Sound on — tap to mute' : 'Muted — tap to unmute'}
              aria-pressed={soundOn}
              onClick={() => setSoundOn((on) => {
                const next = !on
                localStorage.setItem('notifSound', next ? 'on' : 'off')
                if (next) playChime() // preview the chime when turning it on
                return next
              })}
            >
              <span className="mute-toggle-ic">{soundOn ? <BellLineIcon size={15} /> : <BellOffIcon size={15} />}</span>
              <span className="mute-toggle-label">{soundOn ? 'Sound' : 'Muted'}</span>
            </button>
          </div>
          {items.length === 0 && <div className="empty" style={{ padding: 24 }}>You're all caught up 🎉</div>}
          {items.map((n) => {
            const actionable = n.type === 'chat_message' || !!n.task_id
            return (
              <div
                key={n.id}
                className={'notif-item' + (actionable ? ' actionable' : '')}
                onClick={actionable ? () => openNotif(n) : undefined}
                role={actionable ? 'button' : undefined}
                tabIndex={actionable ? 0 : undefined}
                onKeyDown={actionable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNotif(n) } } : undefined}
                style={{ padding: '11px 14px', borderTop: '1px solid var(--border)', background: n.read ? 'var(--surface)' : 'rgba(197,86,15,.08)', fontSize: 13, display: 'flex', gap: 8 }}
              >
                <span>{ICON[n.type] || '•'}</span>
                <div>
                  <div>{n.message}</div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{new Date(n.created_at).toLocaleString()}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
