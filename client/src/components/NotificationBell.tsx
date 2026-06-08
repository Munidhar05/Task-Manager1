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
  const ref = useRef<HTMLDivElement>(null)
  const prevUnread = useRef<number | null>(null) // null until first load, so we don't shake on mount

  const load = () => api.get('/notifications').then((d) => {
    setItems(d.items)
    setUnread(d.unread)
    // A new notification just arrived → vibrate the bell once.
    if (prevUnread.current !== null && d.unread > prevUnread.current) {
      setVibrating(true)
      setTimeout(() => setVibrating(false), 800)
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
          <div className="card-head spread"><h3 style={{ fontSize: 14, margin: 0 }}>Notifications</h3></div>
          {items.length === 0 && <div className="empty" style={{ padding: 24 }}>You're all caught up 🎉</div>}
          {items.map((n) => (
            <div key={n.id} style={{ padding: '11px 14px', borderTop: '1px solid #f1f5f9', background: n.read ? '#fff' : '#eff6ff', fontSize: 13, display: 'flex', gap: 8 }}>
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
