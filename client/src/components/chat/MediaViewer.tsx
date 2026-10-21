import React, { useEffect, useRef, useState } from 'react'
import { Ic } from '../../ui'
import { useDialog } from '../../lib/useDialog'
import type { Msg } from './types'
import { fileUrl, isVideo, whenLabel } from './types'
import { ChevronLeft, ChevronRight } from './glyphs'

// WhatsApp's photo viewer: the picture full screen on black, who sent it and
// when along the top, the caption along the bottom, and a swipe (or the arrow
// keys) to the next one in the chat. Opening a picture used to throw it into a
// new browser tab — on the phone app, out of the app entirely.

export default function MediaViewer({ items, startId, senderName, meId, onClose, onForward, onShowInChat }: {
  items: Msg[]
  startId: string
  senderName: (uid: string) => string
  meId: string
  onClose: () => void
  onForward: (m: Msg) => void
  onShowInChat: (m: Msg) => void
}) {
  const ref = useDialog<HTMLDivElement>(onClose)
  const [idx, setIdx] = useState(() => Math.max(0, items.findIndex((m) => m.id === startId)))
  const m = items[idx]
  const touch = useRef<{ x: number; y: number } | null>(null)
  const go = (d: number) => setIdx((i) => Math.min(items.length - 1, Math.max(0, i + d)))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [items.length])
  // The item it was opened on went away (deleted for everyone): close.
  useEffect(() => { if (!m) onClose() }, [m])
  if (!m) return null

  const download = () => {
    const a = document.createElement('a'); a.href = fileUrl(m, true); a.download = m.file?.name || 'file'
    document.body.appendChild(a); a.click(); a.remove()
  }

  return (
    <div className="mv-overlay" ref={ref} role="dialog" aria-modal="true" aria-label="Photo viewer"
      onTouchStart={(e) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY } }}
      onTouchEnd={(e) => {
        const s = touch.current; touch.current = null
        if (!s) return
        const t = e.changedTouches[0]
        const dx = t.clientX - s.x, dy = t.clientY - s.y
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1)
        else if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.5) onClose() // swipe down to close
      }}>
      <div className="mv-head">
        <button className="mv-btn" onClick={onClose} aria-label="Close"><ChevronLeft size={24} /></button>
        <div className="mv-who">
          <div className="mv-name">{m.sender_id === meId ? 'You' : senderName(m.sender_id)}</div>
          <div className="mv-when">{whenLabel(m.created_at)}{items.length > 1 ? ` · ${idx + 1} of ${items.length}` : ''}</div>
        </div>
        <button className="mv-btn" onClick={() => onShowInChat(m)} aria-label="Show in chat" title="Show in chat"><Ic name="chat" size={19} /></button>
        <button className="mv-btn" onClick={() => onForward(m)} aria-label="Forward" title="Forward"><Ic name="forward" size={19} /></button>
        <button className="mv-btn" onClick={download} aria-label="Download" title="Download"><Ic name="download" size={19} /></button>
      </div>
      <div className="mv-stage" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
        {idx > 0 && <button className="mv-nav prev" onClick={() => go(-1)} aria-label="Previous"><ChevronLeft size={30} /></button>}
        {isVideo(m.file)
          ? <video key={m.id} className="mv-media" src={fileUrl(m)} controls autoPlay playsInline />
          : <img key={m.id} className="mv-media" src={fileUrl(m)} alt={m.body || m.file?.name || 'Photo'} />}
        {idx < items.length - 1 && <button className="mv-nav next" onClick={() => go(1)} aria-label="Next"><ChevronRight size={30} /></button>}
      </div>
      {m.body && <div className="mv-caption">{m.body}</div>}
    </div>
  )
}
