import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, getToken } from '../api'
import { useAuth } from '../auth'
import { Avatar } from '../ui'

interface Member { id: string; name: string; avatar_color?: string; role: string }
interface Conversation {
  id: string; type: 'direct' | 'group'; name: string; avatar_color?: string
  other_user_id?: string | null; member_count: number; members: Member[]; role: string
  last_message: string | null; last_sender_name: string | null; last_from_me: boolean; last_at: string | null; unread: number
}
interface Reaction { emoji: string; user_id: string }
interface ReplyPreview { id: string; sender_id: string; sender_name: string; text: string }
interface ChatFile { name: string; type?: string; size?: number }
interface Msg {
  id: string; conversation_id: string; sender_id: string; body: string; created_at: string
  edited_at?: string | null; reply_to?: string | null; reply?: ReplyPreview | null; file?: ChatFile | null
  reactions: Reaction[]; starred: boolean; seen: boolean; deleted?: boolean; uploading?: boolean
}
interface OrgUser { id: string; name: string; email: string; role: string; avatar_color?: string }

const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏']
const MAX_FILE = 15 * 1024 * 1024
const fileUrl = (m: Msg, download = false) => `/api/chat/file/${m.id}?token=${getToken()}${download ? '&download=1' : ''}`

function relTime(iso: string | null) {
  if (!iso) return ''
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}
function fmtSize(n?: number) {
  if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'
  return (n / 1048576).toFixed(1) + ' MB'
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })
}

export default function Chats() {
  const { user } = useAuth()
  const [convos, setConvos] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState('')
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')       // sidebar people search
  const [inSearch, setInSearch] = useState('')   // in-conversation message search
  const [inSearchOpen, setInSearchOpen] = useState(false)
  const [replyTo, setReplyTo] = useState<Msg | null>(null)
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [reactFor, setReactFor] = useState<string | null>(null)
  const [typingName, setTypingName] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const activeIdRef = useRef('')
  const typingClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typingSentRef = useRef(0)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])

  const active = useMemo(() => convos.find((c) => c.id === activeId) || null, [convos, activeId])

  const pingNav = () => window.dispatchEvent(new Event('chat-unread-changed'))
  const loadConvos = () => api.get('/chat/conversations').then((d) => { setConvos(d.conversations); pingNav() }).catch(() => {})

  const mergeIncoming = (m: Msg) => setMessages((prev) => {
    if (prev.some((x) => x.id === m.id)) return prev
    const ti = prev.findIndex((x) => x.id.startsWith('tmp_') && x.sender_id === m.sender_id && x.body === m.body && !!x.file === !!m.file)
    if (ti >= 0) { const c = prev.slice(); c[ti] = m; return c }
    return [...prev, m]
  })

  const loadThread = (cid: string) => api.get(`/chat/conversations/${cid}`).then((d) => {
    setMessages(d.messages)
    setConvos((cs) => cs.map((c) => (c.id === cid ? { ...c, unread: 0, members: d.conversation.members, role: d.conversation.role } : c)))
    pingNav()
  }).catch(() => {})

  useEffect(() => {
    let cancel = false
    loadConvos().then(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [user?.id])

  useEffect(() => { if (!activeId && convos.length) setActiveId(convos[0].id) }, [convos, activeId])
  useEffect(() => { if (activeId) { loadThread(activeId); setReplyTo(null); setEditing(null); setInSearch(''); setInSearchOpen(false); setShowInfo(false) } }, [activeId])
  useEffect(() => { if (!inSearchOpen) logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [messages, busy, typingName, inSearchOpen])
  useEffect(() => { const h = () => { setMenuId(null); setReactFor(null) }; document.addEventListener('click', h); return () => document.removeEventListener('click', h) }, [])

  // WebSocket: messages, edits, reactions, deletes, reads, typing, membership changes.
  useEffect(() => {
    if (!user) return
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/api/chat/ws?token=${getToken()}`)
      wsRef.current = ws
      ws.onmessage = (ev) => {
        let d: any
        try { d = JSON.parse(ev.data) } catch { return }
        const inActive = d.conversationId === activeIdRef.current
        if (d.type === 'message' && d.message) {
          if (inActive) {
            mergeIncoming(d.message)
            if (d.message.sender_id !== user.id) api.post(`/chat/conversations/${activeIdRef.current}/read`).catch(() => {})
          }
          loadConvos()
        } else if (d.type === 'edit') {
          if (inActive) setMessages((p) => p.map((m) => (m.id === d.id ? { ...m, body: d.body, edited_at: d.edited_at } : m)))
        } else if (d.type === 'reaction') {
          if (inActive) setMessages((p) => p.map((m) => (m.id === d.id ? { ...m, reactions: d.reactions } : m)))
        } else if (d.type === 'delete') {
          if (inActive) {
            if (d.scope === 'all') setMessages((p) => p.map((m) => (m.id === d.id ? { ...m, deleted: true, body: '', file: null, reactions: [] } : m)))
            else setMessages((p) => p.filter((m) => m.id !== d.id))
          }
          loadConvos()
        } else if (d.type === 'read') {
          if (inActive && d.userId !== user.id) setMessages((p) => p.map((m) => (m.sender_id === user.id && m.created_at <= d.last_read_at ? { ...m, seen: true } : m)))
        } else if (d.type === 'typing') {
          if (inActive && d.userId !== user.id) {
            setTypingName(d.isTyping ? d.name : null)
            if (typingClearRef.current) clearTimeout(typingClearRef.current)
            if (d.isTyping) typingClearRef.current = setTimeout(() => setTypingName(null), 4000)
          }
        } else if (d.type === 'conversation') {
          if (d.action === 'removed' && d.conversationId === activeIdRef.current) setActiveId('')
          loadConvos()
        }
      }
      ws.onclose = () => { if (!closed) retry = setTimeout(connect, 3000) }
      ws.onerror = () => { try { ws.close() } catch {} }
    }
    connect()
    return () => { closed = true; if (retry) clearTimeout(retry); try { wsRef.current?.close() } catch {} }
  }, [user?.id])

  useEffect(() => {
    const iv = setInterval(() => { loadConvos(); if (activeIdRef.current) loadThread(activeIdRef.current) }, 25000)
    return () => clearInterval(iv)
  }, [])

  // ---- composer actions ----
  const sendTyping = (isTyping: boolean) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeId) return
    const nowMs = Date.now()
    if (isTyping && nowMs - typingSentRef.current < 1500) return
    typingSentRef.current = nowMs
    try { ws.send(JSON.stringify({ type: 'typing', conversationId: activeId, isTyping })) } catch {}
  }

  const send = async () => {
    const body = input.trim()
    if (!body || busy || !active) return
    if (editing) return saveEdit()
    setInput(''); setBusy(true); sendTyping(false)
    const rep = replyTo
    const optimistic: Msg = { id: 'tmp_' + Date.now(), conversation_id: active.id, sender_id: user!.id, body, created_at: new Date().toISOString(), reactions: [], starred: false, seen: false, reply: rep ? { id: rep.id, sender_id: rep.sender_id, sender_name: senderName(rep.sender_id), text: rep.file ? '📎 ' + rep.file.name : rep.body } : null, reply_to: rep?.id || null }
    setMessages((m) => [...m, optimistic]); setReplyTo(null)
    try {
      const saved = await api.post(`/chat/conversations/${active.id}/messages`, { body, replyTo: rep?.id })
      mergeIncoming(saved); loadConvos()
    } catch (e: any) {
      setMessages((m) => m.filter((x) => x.id !== optimistic.id)); setInput(body); alert('Could not send: ' + e.message)
    } finally { setBusy(false) }
  }

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file || !active || busy) return
    if (file.size > MAX_FILE) { alert('File too large (max 15 MB)'); return }
    const caption = input.trim(); const rep = replyTo
    setInput(''); setBusy(true); setReplyTo(null)
    const tmpId = 'tmp_' + Date.now()
    setMessages((m) => [...m, { id: tmpId, conversation_id: active.id, sender_id: user!.id, body: caption, created_at: new Date().toISOString(), reactions: [], starred: false, seen: false, file: { name: file.name, type: file.type, size: file.size }, uploading: true }])
    try {
      const form = new FormData(); form.append('file', file)
      if (caption) form.append('body', caption)
      if (rep) form.append('replyTo', rep.id)
      const headers: Record<string, string> = {}; const t = getToken(); if (t) headers.authorization = `Bearer ${t}`
      const res = await fetch(`/api/chat/conversations/${active.id}/upload`, { method: 'POST', headers, body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Upload failed')
      setMessages((prev) => prev.map((x) => (x.id === tmpId ? data : x))); loadConvos()
    } catch (err: any) {
      setMessages((m) => m.filter((x) => x.id !== tmpId)); alert('Could not send file: ' + err.message)
    } finally { setBusy(false) }
  }

  const saveEdit = async () => {
    if (!editing) return
    const body = input.trim(); if (!body) return
    setBusy(true)
    try {
      await api.patch(`/chat/message/${editing.id}`, { body })
      setMessages((p) => p.map((m) => (m.id === editing.id ? { ...m, body, edited_at: new Date().toISOString() } : m)))
      setEditing(null); setInput('')
    } catch (e: any) { alert('Could not edit: ' + e.message) } finally { setBusy(false) }
  }

  // ---- message actions ----
  const react = async (m: Msg, emoji: string) => {
    setReactFor(null); setMenuId(null)
    try { const d = await api.post(`/chat/message/${m.id}/reactions`, { emoji }); setMessages((p) => p.map((x) => (x.id === m.id ? { ...x, reactions: d.reactions } : x))) } catch {}
  }
  const toggleStar = async (m: Msg) => {
    setMenuId(null)
    const next = !m.starred
    setMessages((p) => p.map((x) => (x.id === m.id ? { ...x, starred: next } : x)))
    try { if (next) await api.post(`/chat/message/${m.id}/star`); else await api.del(`/chat/message/${m.id}/star`) } catch {}
  }
  const del = async (m: Msg) => {
    setMenuId(null)
    const mine = m.sender_id === user!.id
    if (!window.confirm(mine ? 'Delete this message for everyone?' : 'Remove this message for you?')) return
    const snap = messages
    if (mine) setMessages((p) => p.map((x) => (x.id === m.id ? { ...x, deleted: true, body: '', file: null, reactions: [] } : x)))
    else setMessages((p) => p.filter((x) => x.id !== m.id))
    try { await api.del(`/chat/message/${m.id}`); loadConvos() } catch (e: any) { setMessages(snap); alert('Could not delete: ' + e.message) }
  }
  const copy = async (m: Msg) => {
    setMenuId(null)
    const text = m.file ? `${location.origin}${fileUrl(m)}` : m.body
    try { await navigator.clipboard.writeText(text) } catch { window.prompt('Copy:', text) }
  }
  const share = async (m: Msg) => {
    setMenuId(null)
    const url = m.file ? `${location.origin}${fileUrl(m)}` : undefined
    const shareData: any = m.file ? { title: m.file.name, url } : { text: m.body }
    if (navigator.share) { try { await navigator.share(shareData) } catch {} }
    else { try { await navigator.clipboard.writeText(url || m.body); alert('Link copied to clipboard') } catch {} }
  }
  const download = (m: Msg) => {
    setMenuId(null)
    const a = document.createElement('a'); a.href = fileUrl(m, true); a.download = m.file?.name || 'file'
    document.body.appendChild(a); a.click(); a.remove()
  }
  const startEdit = (m: Msg) => { setMenuId(null); setEditing({ id: m.id, body: m.body }); setInput(m.body); setReplyTo(null) }
  const startReply = (m: Msg) => { setMenuId(null); setReplyTo(m); setEditing(null) }

  const senderName = (uid: string) => (active?.members.find((mm) => mm.id === uid)?.name) || (uid === user?.id ? 'You' : 'Unknown')
  const senderColor = (uid: string) => active?.members.find((mm) => mm.id === uid)?.avatar_color

  const filteredConvos = convos.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
  const shownMessages = inSearch.trim()
    ? messages.filter((m) => !m.deleted && (m.body || '').toLowerCase().includes(inSearch.toLowerCase()))
    : messages

  if (loading) return <div className="card" style={{ display: 'grid', placeItems: 'center', height: 'calc(100vh - 160px)' }}><span className="spinner" /></div>

  return (
    <div className={'assistant-layout' + (navOpen ? ' nav-open' : '')}>
      {/* ---- sidebar: conversations ---- */}
      <aside className="chat-history">
        <div className="chat-history-head">
          <span className="ch-title">Chats</span>
          <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)} title="New chat / group">＋ New</button>
        </div>
        <input className="chat-contact-search" placeholder="Search chats…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="convo-list">
          {filteredConvos.length === 0 && <div className="empty" style={{ padding: 16, fontSize: 13 }}>No chats yet</div>}
          {filteredConvos.map((c) => (
            <div key={c.id} className={'convo-item chat-contact' + (c.id === activeId ? ' active' : '')} onClick={() => { setActiveId(c.id); setNavOpen(false) }}>
              {c.type === 'group'
                ? <span className="avatar group-avatar" style={{ background: c.avatar_color, width: 38, height: 38 }}>#</span>
                : <Avatar name={c.name} color={c.avatar_color} size={38} />}
              <div className="convo-meta" style={{ minWidth: 0, flex: 1 }}>
                <div className="row spread" style={{ gap: 6 }}>
                  <div className="convo-title" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
                  {c.last_at && <span className="convo-time" style={{ flexShrink: 0 }}>{relTime(c.last_at)}</span>}
                </div>
                <div className="chat-contact-preview">
                  {c.last_message
                    ? (c.type === 'group' && c.last_sender_name ? `${c.last_from_me ? 'You' : c.last_sender_name}: ` : (c.last_from_me ? 'You: ' : '')) + c.last_message
                    : <span className="muted">{c.type === 'group' ? `${c.member_count} members` : 'Start a conversation'}</span>}
                </div>
              </div>
              {c.unread > 0 && <span className="chat-unread-badge">{c.unread > 9 ? '9+' : c.unread}</span>}
            </div>
          ))}
        </div>
      </aside>

      {/* ---- conversation pane ---- */}
      <div className="card chat-pane" style={{ padding: 18 }}>
        <div className="chat">
          <div className="chat-mobile-bar">
            <button className="btn btn-ghost btn-sm" onClick={() => setNavOpen((o) => !o)}>☰ Chats</button>
            <span className="convo-current">{active?.name}</span>
          </div>

          {active && (
            <div className="chat-peer-head">
              {active.type === 'group'
                ? <span className="avatar group-avatar" style={{ background: active.avatar_color, width: 36, height: 36 }}>#</span>
                : <Avatar name={active.name} color={active.avatar_color} size={36} />}
              <div style={{ minWidth: 0, cursor: active.type === 'group' ? 'pointer' : 'default' }} onClick={() => active.type === 'group' && setShowInfo(true)}>
                <div style={{ fontWeight: 600 }}>{active.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {typingName ? <span className="typing-text">{typingName} is typing…</span>
                    : active.type === 'group' ? active.members.map((m) => m.name.split(' ')[0]).join(', ')
                      : <span style={{ textTransform: 'capitalize' }}>{active.members.find((m) => m.id !== user!.id)?.role || ''}</span>}
                </div>
              </div>
              <div className="row" style={{ marginLeft: 'auto', gap: 4 }}>
                <button className="btn btn-ghost btn-sm" title="Search in chat" onClick={() => setInSearchOpen((o) => !o)}>
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
                  </svg>
                </button>
                {active.type === 'group' && <button className="btn btn-ghost btn-sm" title="Group info" onClick={() => setShowInfo(true)}>ⓘ</button>}
              </div>
            </div>
          )}

          {inSearchOpen && (
            <div className="in-search">
              <input autoFocus placeholder="Search messages…" value={inSearch} onChange={(e) => setInSearch(e.target.value)} />
              <button className="btn btn-ghost btn-sm" onClick={() => { setInSearch(''); setInSearchOpen(false) }}>✕</button>
            </div>
          )}

          <div className="chat-log" ref={logRef}>
            {!active && <div className="empty" style={{ margin: 'auto' }}>Select a chat or start a new one</div>}
            {active && shownMessages.length === 0 && <div className="empty" style={{ margin: 'auto', textAlign: 'center' }}>{inSearch ? 'No matching messages' : <>No messages yet.<br />Say hello 👋</>}</div>}
            {shownMessages.map((m) => {
              const mine = m.sender_id === user!.id
              const isTemp = m.id.startsWith('tmp_')
              const isImage = !!m.file && (m.file.type || '').startsWith('image/')
              const showSender = active?.type === 'group' && !mine && !m.deleted
              // aggregate reactions by emoji
              const agg: Record<string, { count: number; mine: boolean }> = {}
              for (const rx of m.reactions || []) { (agg[rx.emoji] ||= { count: 0, mine: false }); agg[rx.emoji].count++; if (rx.user_id === user!.id) agg[rx.emoji].mine = true }
              return (
                <div key={m.id} className="msg-wrap" style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}>
                  <div className={'msg-line' + (mine ? ' mine' : '')}>
                    <div className="msg-body">
                      {showSender && <div className="msg-sender" style={{ color: senderColor(m.sender_id) }}>{senderName(m.sender_id)}</div>}
                      {m.deleted ? (
                        <div className="bubble deleted">🚫 This message was deleted</div>
                      ) : (
                        <div className={'bubble ' + (mine ? 'user' : 'ai') + (m.file ? ' file-bubble' : '')}>
                          {m.reply && (
                            <div className="reply-quote"><span className="reply-quote-name">{m.reply.sender_id === user!.id ? 'You' : m.reply.sender_name}</span><span className="reply-quote-text">{m.reply.text}</span></div>
                          )}
                          {m.file && (isImage && !m.uploading
                            ? <a href={fileUrl(m)} target="_blank" rel="noreferrer"><img className="chat-image" src={fileUrl(m)} alt={m.file.name} /></a>
                            : <div className="chat-file">
                                <span className="chat-file-icon">{m.uploading ? '⏳' : '📎'}</span>
                                <span className="chat-file-meta"><span className="chat-file-name">{m.file?.name}</span><span className="chat-file-size">{m.uploading ? 'Sending…' : fmtSize(m.file?.size)}</span></span>
                                {!m.uploading && <button className="chat-file-dl" title="Download" onClick={() => download(m)}>⬇</button>}
                              </div>)}
                          {m.body && <div className="bubble-text">{m.body}</div>}
                          <div className="bubble-foot">
                            {m.edited_at && <span className="edited-tag">edited</span>}
                            {m.starred && <span title="Starred">⭐</span>}
                            {mine && !m.file && <span className="ticks" title={m.seen ? 'Seen' : 'Sent'}>{m.seen ? '✓✓' : '✓'}</span>}
                          </div>
                        </div>
                      )}
                      {Object.keys(agg).length > 0 && (
                        <div className={'reactions-row' + (mine ? ' mine' : '')}>
                          {Object.entries(agg).map(([emo, info]) => (
                            <button key={emo} className={'reaction-chip' + (info.mine ? ' mine' : '')} onClick={() => react(m, emo)}>{emo} {info.count > 1 ? info.count : ''}</button>
                          ))}
                        </div>
                      )}
                    </div>
                    {!isTemp && !m.deleted && (
                      <div className="msg-tools">
                        <button className="msg-tool-btn" title="React" onClick={(e) => { e.stopPropagation(); setReactFor(reactFor === m.id ? null : m.id); setMenuId(null) }}>😊</button>
                        <button className="msg-tool-btn" title="Reply" onClick={(e) => { e.stopPropagation(); startReply(m) }}>↩</button>
                        <div className="msg-menu-wrap">
                          <button className="msg-tool-btn" title="More" onClick={(e) => { e.stopPropagation(); setMenuId(menuId === m.id ? null : m.id); setReactFor(null) }}>⋯</button>
                          {menuId === m.id && (
                            <div className={'msg-menu' + (mine ? ' mine' : '')} onClick={(e) => e.stopPropagation()}>
                              <button onClick={() => copy(m)}>Copy</button>
                              {m.file && <button onClick={() => download(m)}>Download</button>}
                              <button onClick={() => share(m)}>Share</button>
                              <button onClick={() => toggleStar(m)}>{m.starred ? 'Unstar' : 'Star'}</button>
                              {mine && !m.file && <button onClick={() => startEdit(m)}>Edit</button>}
                              <button className="danger" onClick={() => del(m)}>Delete</button>
                            </div>
                          )}
                        </div>
                        {reactFor === m.id && (
                          <div className="react-picker" onClick={(e) => e.stopPropagation()}>
                            {EMOJIS.map((emo) => <button key={emo} onClick={() => react(m, emo)}>{emo}</button>)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="msg-time">{fmtTime(m.created_at)}</div>
                </div>
              )
            })}
            {typingName && !inSearch && <div className="bubble ai typing-bubble"><span className="typing-dots"><i /><i /><i /></span></div>}
          </div>

          {/* composer */}
          {active && (
            <div className="composer">
              {replyTo && (
                <div className="reply-banner">
                  <div className="reply-banner-body"><span className="reply-quote-name">Replying to {replyTo.sender_id === user!.id ? 'yourself' : senderName(replyTo.sender_id)}</span><span className="reply-quote-text">{replyTo.file ? '📎 ' + replyTo.file.name : replyTo.body}</span></div>
                  <button className="btn btn-ghost btn-sm" onClick={() => setReplyTo(null)}>✕</button>
                </div>
              )}
              {editing && (
                <div className="reply-banner editing"><div className="reply-banner-body"><span className="reply-quote-name">Editing message</span></div><button className="btn btn-ghost btn-sm" onClick={() => { setEditing(null); setInput('') }}>✕</button></div>
              )}
              <div className="chat-input">
                <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onPickFile} />
                <button className="btn btn-ghost attach-btn" title="Attach a file" disabled={busy || !!editing} onClick={() => fileRef.current?.click()}>＋</button>
                <input
                  placeholder={editing ? 'Edit your message…' : 'Type a message…'}
                  value={input}
                  onChange={(e) => { setInput(e.target.value); if (!editing) sendTyping(true) }}
                  onKeyDown={(e) => e.key === 'Enter' && send()}
                  onBlur={() => sendTyping(false)}
                  autoFocus
                />
                <button className="btn btn-primary" onClick={send} disabled={busy || !input.trim()}>{editing ? 'Save' : 'Send'}</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showNew && <NewChatModal user={user!} convos={convos} onClose={() => setShowNew(false)} onOpen={(cid) => { setShowNew(false); setActiveId(cid); loadConvos() }} />}
      {showInfo && active && active.type === 'group' && <GroupInfo conv={active} user={user!} onClose={() => setShowInfo(false)} onChanged={() => { loadConvos(); loadThread(active.id) }} onLeft={() => { setShowInfo(false); setActiveId(''); loadConvos() }} />}
    </div>
  )
}

// ---------- New chat / group modal ----------
function NewChatModal({ user, convos, onClose, onOpen }: { user: OrgUser; convos: Conversation[]; onClose: () => void; onOpen: (cid: string) => void }) {
  const [users, setUsers] = useState<OrgUser[]>([])
  const [mode, setMode] = useState<'pick' | 'group'>('pick')
  const [q, setQ] = useState('')
  const [groupName, setGroupName] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.get('/chat/users').then((d) => setUsers(d.users)).catch(() => {}) }, [])
  const list = users.filter((u) => u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const startDirect = async (uid: string) => {
    setBusy(true)
    try { const c = await api.post('/chat/conversations', { type: 'direct', userId: uid }); onOpen(c.id) } catch (e: any) { alert(e.message); setBusy(false) }
  }
  const createGroup = async () => {
    if (!groupName.trim() || sel.size === 0) return
    setBusy(true)
    try { const c = await api.post('/chat/conversations', { type: 'group', name: groupName.trim(), memberIds: [...sel] }); onOpen(c.id) } catch (e: any) { alert(e.message); setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 style={{ margin: 0, fontSize: 16 }}>{mode === 'pick' ? 'New chat' : 'New group'}</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>
        <div className="modal-tabs">
          <button className={mode === 'pick' ? 'active' : ''} onClick={() => setMode('pick')}>Direct</button>
          <button className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')}>Group</button>
        </div>
        {mode === 'group' && <input className="chat-contact-search" style={{ marginBottom: 8 }} placeholder="Group name…" value={groupName} onChange={(e) => setGroupName(e.target.value)} />}
        <input className="chat-contact-search" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="modal-list">
          {list.map((u) => (
            <div key={u.id} className="modal-user" onClick={() => mode === 'pick' ? startDirect(u.id) : toggle(u.id)}>
              <Avatar name={u.name} color={u.avatar_color} size={34} />
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{u.name}</div><div className="muted" style={{ fontSize: 11.5, textTransform: 'capitalize' }}>{u.role}</div></div>
              {mode === 'group' && <input type="checkbox" readOnly checked={sel.has(u.id)} />}
            </div>
          ))}
          {list.length === 0 && <div className="empty" style={{ padding: 16 }}>No people found</div>}
        </div>
        {mode === 'group' && <button className="btn btn-primary" style={{ width: '100%', marginTop: 10 }} disabled={busy || !groupName.trim() || sel.size === 0} onClick={createGroup}>Create group ({sel.size})</button>}
      </div>
    </div>
  )
}

// ---------- Group info / members ----------
function GroupInfo({ conv, user, onClose, onChanged, onLeft }: { conv: Conversation; user: OrgUser; onClose: () => void; onChanged: () => void; onLeft: () => void }) {
  const [name, setName] = useState(conv.name)
  const [adding, setAdding] = useState(false)
  const [users, setUsers] = useState<OrgUser[]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const isAdmin = conv.role === 'admin'
  useEffect(() => { if (adding) api.get('/chat/users').then((d) => setUsers(d.users.filter((u: OrgUser) => !conv.members.some((m) => m.id === u.id)))).catch(() => {}) }, [adding])

  const rename = async () => { if (!name.trim() || name === conv.name) return; try { await api.patch(`/chat/conversations/${conv.id}`, { name: name.trim() }); onChanged() } catch (e: any) { alert(e.message) } }
  const addMembers = async () => { if (!sel.size) return; try { await api.post(`/chat/conversations/${conv.id}/members`, { userIds: [...sel] }); setAdding(false); setSel(new Set()); onChanged() } catch (e: any) { alert(e.message) } }
  const remove = async (uid: string) => { if (!window.confirm('Remove this member?')) return; try { await api.del(`/chat/conversations/${conv.id}/members/${uid}`); onChanged() } catch (e: any) { alert(e.message) } }
  const leave = async () => { if (!window.confirm('Leave this group?')) return; try { await api.del(`/chat/conversations/${conv.id}/members/${user.id}`); onLeft() } catch (e: any) { alert(e.message) } }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 style={{ margin: 0, fontSize: 16 }}>Group info</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          <input className="chat-contact-search" value={name} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} />
          {isAdmin && <button className="btn btn-ghost btn-sm" onClick={rename} disabled={!name.trim() || name === conv.name}>Rename</button>}
        </div>
        <div className="spread row" style={{ marginBottom: 6 }}><span className="ch-title">{conv.members.length} members</span>{isAdmin && <button className="btn btn-ghost btn-sm" onClick={() => setAdding((a) => !a)}>{adding ? 'Cancel' : '+ Add'}</button>}</div>
        {adding ? (
          <>
            <div className="modal-list">
              {users.map((u) => (
                <div key={u.id} className="modal-user" onClick={() => setSel((s) => { const n = new Set(s); n.has(u.id) ? n.delete(u.id) : n.add(u.id); return n })}>
                  <Avatar name={u.name} color={u.avatar_color} size={32} /><div style={{ flex: 1 }}>{u.name}</div><input type="checkbox" readOnly checked={sel.has(u.id)} />
                </div>
              ))}
              {users.length === 0 && <div className="empty" style={{ padding: 12 }}>Everyone is already in</div>}
            </div>
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 8 }} disabled={!sel.size} onClick={addMembers}>Add ({sel.size})</button>
          </>
        ) : (
          <div className="modal-list">
            {conv.members.map((m) => (
              <div key={m.id} className="modal-user">
                <Avatar name={m.name} color={m.avatar_color} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.name}{m.id === user.id ? ' (you)' : ''}</div><div className="muted" style={{ fontSize: 11 }}>{m.role}</div></div>
                {isAdmin && m.id !== user.id && <button className="btn btn-ghost btn-sm danger" onClick={() => remove(m.id)}>Remove</button>}
              </div>
            ))}
          </div>
        )}
        <button className="btn btn-ghost danger" style={{ width: '100%', marginTop: 12 }} onClick={leave}>Leave group</button>
      </div>
    </div>
  )
}
