import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, getToken, userAvatarUrl, groupAvatarUrl, API_BASE, wsUrl } from '../api'
import { useAuth } from '../auth'
import { Avatar, EmptyState, Ic } from '../ui'
import { pushBackHandler } from '../back'
import { toast } from '../lib/toast'
import { confirmDialog } from '../lib/confirm'
import { useSurface } from '../voice/uiRegistry'
import { typeInto, flashPress, pause, settle, findVaEl } from '../voice/uiController'

interface Member { id: string; name: string; avatar_color?: string; avatar_file?: string | null; role: string }
interface Conversation {
  id: string; type: 'direct' | 'group'; name: string; avatar_color?: string; avatar_file?: string | null
  other_user_id?: string | null; other_last_seen?: string | null; member_count: number; members: Member[]; role: string
  last_message: string | null; last_sender_name: string | null; last_from_me: boolean; last_at: string | null; unread: number
  muted?: boolean; pinned?: boolean
}
interface Reaction { emoji: string; user_id: string }
interface ReplyPreview { id: string; sender_id: string; sender_name: string; text: string }
interface ChatFile { name: string; type?: string; size?: number }
interface Msg {
  id: string; conversation_id: string; sender_id: string; body: string; created_at: string
  edited_at?: string | null; forwarded?: boolean; reply_to?: string | null; reply?: ReplyPreview | null; file?: ChatFile | null
  reactions: Reaction[]; starred: boolean; seen: boolean; deleted?: boolean; uploading?: boolean
}
interface OrgUser { id: string; name: string; email: string; role: string; avatar_color?: string; avatar_file?: string | null }

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
  return new Date(iso).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
}
function dayLabel(iso: string) {
  const d = new Date(iso), today = new Date(), yest = new Date()
  yest.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yest.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function lastSeenLabel(iso?: string | null) {
  if (!iso) return ''
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'last seen just now'
  if (s < 3600) return `last seen ${Math.floor(s / 60)}m ago`
  if (s < 86400) return `last seen ${Math.floor(s / 3600)}h ago`
  const d = new Date(iso)
  const isYesterday = (Date.now() - new Date(iso).getTime()) < 172800000
  return `last seen ${isYesterday ? 'yesterday' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

// Avatar with an "online" green dot (and optional photo).
function PresenceAvatar({ name, color, size, online, src }: { name?: string; color?: string; size: number; online?: boolean; src?: string }) {
  return <span className="avatar-wrap"><Avatar name={name} color={color} size={size} src={src} />{online && <span className="online-dot" />}</span>
}

// Group avatar: uploaded photo if present, else a '#' tile.
function GroupAvatar({ conv, size }: { conv: { id: string; avatar_file?: string | null; avatar_color?: string }; size: number }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => { setBroken(false) }, [conv.avatar_file])
  if (conv.avatar_file && !broken) return <img className="avatar" src={groupAvatarUrl(conv.id, conv.avatar_file)} onError={() => setBroken(true)} style={{ width: size, height: size, objectFit: 'cover' }} />
  return <span className="avatar group-avatar" style={{ background: conv.avatar_color, width: size, height: size }}>#</span>
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
  const [menuId, setMenuId] = useState<string | null>(null)
  const [reactFor, setReactFor] = useState<string | null>(null)
  const [typingName, setTypingName] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [showStarred, setShowStarred] = useState(false)
  const [forwardMsg, setForwardMsg] = useState<Msg | null>(null)
  const [online, setOnline] = useState<Set<string>>(new Set())
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({})
  const [threadLastRead, setThreadLastRead] = useState<string | null>(null)
  const [convoMenu, setConvoMenu] = useState<string | null>(null)
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
    setThreadLastRead(d.last_read_at || null)
    if (d.conversation.type === 'direct' && d.conversation.other_user_id && d.conversation.other_last_seen) {
      setLastSeen((s) => ({ ...s, [d.conversation.other_user_id]: d.conversation.other_last_seen }))
    }
    setConvos((cs) => cs.map((c) => (c.id === cid ? { ...c, unread: 0, members: d.conversation.members, role: d.conversation.role, muted: d.conversation.muted, pinned: d.conversation.pinned } : c)))
    pingNav()
  }).catch(() => {})

  useEffect(() => {
    let cancel = false
    loadConvos().then(() => { if (!cancel) setLoading(false) })
    api.get('/chat/presence').then((d) => { if (!cancel) setOnline(new Set(d.online)) }).catch(() => {})
    return () => { cancel = true }
  }, [user?.id])

  // `/chats?with=<userId>` opens (or creates) that person's direct thread — the
  // one deliberate exception to "never auto-open a chat" below, because the user
  // asked for a specific conversation by name ("open Ravi's chat"). The param is
  // stripped straight away with replace:true so Back doesn't bounce them into the
  // same thread, and so a refresh doesn't reopen a chat they've since left.
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    const withUser = params.get('with')
    if (!withUser || !user) return
    setParams(new URLSearchParams(), { replace: true })
    api.post('/chat/conversations', { type: 'direct', userId: withUser })
      .then((conv: any) => { loadConvos(); setActiveId(conv.id) })
      .catch(() => toast.error("I couldn't open that conversation."))
  }, [params, user?.id])

  // WhatsApp-style: do NOT auto-open a chat. The list is shown first; the user
  // taps a conversation to open it (and the back arrow returns to the list).
  useEffect(() => { if (activeId) { loadThread(activeId); setReplyTo(null); setEditing(null); setInSearch(''); setInSearchOpen(false); setShowInfo(false) } }, [activeId])
  // Auto-scroll only when the reader is already at (or near) the bottom, or the
  // last message is their own — an incoming message must not yank someone who
  // scrolled up to read history. Opening a thread always starts at the bottom.
  const forceScrollRef = useRef(true)
  useEffect(() => { forceScrollRef.current = true }, [activeId])
  useEffect(() => {
    const el = logRef.current
    if (!el || inSearchOpen) return
    const last = messages[messages.length - 1]
    const mine = !!last && last.sender_id === user?.id
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (forceScrollRef.current || mine || nearBottom) {
      el.scrollTo(0, el.scrollHeight)
      if (messages.length) forceScrollRef.current = false
    }
  }, [messages, busy, typingName, inSearchOpen])
  useEffect(() => { const h = () => { setMenuId(null); setReactFor(null); setConvoMenu(null) }; document.addEventListener('click', h); return () => document.removeEventListener('click', h) }, [])

  // Android back button: close the top-most open layer (menu → modal → search →
  // conversation list) instead of leaving Chats / quitting the app.
  useEffect(() => pushBackHandler(() => {
    if (menuId || reactFor || convoMenu) { setMenuId(null); setReactFor(null); setConvoMenu(null); return true }
    if (forwardMsg) { setForwardMsg(null); return true }
    if (showStarred) { setShowStarred(false); return true }
    if (showInfo) { setShowInfo(false); return true }
    if (showNew) { setShowNew(false); return true }
    if (inSearchOpen) { setInSearchOpen(false); setInSearch(''); return true }
    if (activeId) { setActiveId(''); return true } // open chat → back to the list
    return false
  }), [menuId, reactFor, convoMenu, forwardMsg, showStarred, showInfo, showNew, inSearchOpen, activeId])

  // WebSocket: messages, edits, reactions, deletes, reads, typing, membership changes.
  useEffect(() => {
    if (!user) return
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false
    const connect = () => {
      const ws = new WebSocket(wsUrl(`/api/chat/ws?token=${getToken()}`))
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
          if (d.action === 'removed' && d.conversationId === activeIdRef.current) { setActiveId(''); setMessages([]) }
          loadConvos()
        } else if (d.type === 'cleared') {
          if (d.conversationId === activeIdRef.current) setMessages([])
          loadConvos()
        } else if (d.type === 'presence') {
          setOnline((s) => { const n = new Set(s); d.online ? n.add(d.userId) : n.delete(d.userId); return n })
          if (!d.online && d.last_seen) setLastSeen((s) => ({ ...s, [d.userId]: d.last_seen }))
        } else if (d.type === 'presence-list') {
          setOnline(new Set(d.online))
        }
      }
      ws.onclose = () => { if (!closed) retry = setTimeout(connect, 3000) }
      ws.onerror = () => { try { ws.close() } catch {} }
    }
    connect()
    return () => { closed = true; if (retry) clearTimeout(retry); try { wsRef.current?.close() } catch {} }
  }, [user?.id])

  // Fallback refresh ONLY: the WebSocket above already pushes every change, so
  // poll just when it's down — and never while the tab is hidden (battery/network).
  // The old unconditional 25s wholesale refetch also flickered the thread and
  // could momentarily drop in-flight optimistic messages.
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.hidden) return
      if (wsRef.current?.readyState === WebSocket.OPEN) return
      loadConvos(); if (activeIdRef.current) loadThread(activeIdRef.current)
    }, 25000)
    // Catch up once when the user returns to the tab.
    const onVisible = () => {
      if (document.hidden) return
      loadConvos(); if (activeIdRef.current) loadThread(activeIdRef.current)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVisible) }
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
    const optimistic: Msg = { id: 'tmp_' + Date.now(), conversation_id: active.id, sender_id: user!.id, body, created_at: new Date().toISOString(), reactions: [], starred: false, seen: false, reply: rep ? { id: rep.id, sender_id: rep.sender_id, sender_name: senderName(rep.sender_id), text: rep.file ? rep.file.name : rep.body } : null, reply_to: rep?.id || null }
    setMessages((m) => [...m, optimistic]); setReplyTo(null)
    try {
      const saved = await api.post(`/chat/conversations/${active.id}/messages`, { body, replyTo: rep?.id })
      mergeIncoming(saved); loadConvos()
    } catch (e: any) {
      setMessages((m) => m.filter((x) => x.id !== optimistic.id)); setInput(body); toast.error('Could not send: ' + e.message)
    } finally { setBusy(false) }
  }

  // ---- Agent surface -------------------------------------------------------
  // Sending a message by voice used to POST straight to the chat API and then
  // navigate to /chats, so the user saw a thread that already contained a message
  // they never watched being written. Now the agent opens the conversation, types
  // into the real composer and presses the real Send — which matters more here than
  // anywhere else in the app, because this is the one action that is visible to
  // ANOTHER PERSON and cannot be taken back.
  useSurface('chats', {
    // Find or create the direct thread with someone, then open it.
    openDirect: async ({ userId }: { userId: string }) => {
      const conv: any = await api.post('/chat/conversations', { type: 'direct', userId })
      loadConvos()
      setActiveId(conv.id)
      await pause(420)                 // let the thread render before typing into it
      return { id: conv.id }
    },
    typeMessage: ({ value }: { value: string }) =>
      typeInto(findVaEl('chats.composer'), value, setInput),
    send: async () => {
      // settle() before reading state: typeInto set `input` through React, and the
      // real send() closes over it. Without a commit the message would post empty.
      await settle()
      await flashPress(findVaEl('chats.send'))
      await send()
    },
  })

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file || !active || busy) return
    if (file.size > MAX_FILE) { toast.error('File too large (max 15 MB)'); return }
    const caption = input.trim(); const rep = replyTo
    setInput(''); setBusy(true); setReplyTo(null)
    const tmpId = 'tmp_' + Date.now()
    setMessages((m) => [...m, { id: tmpId, conversation_id: active.id, sender_id: user!.id, body: caption, created_at: new Date().toISOString(), reactions: [], starred: false, seen: false, file: { name: file.name, type: file.type, size: file.size }, uploading: true }])
    try {
      const form = new FormData(); form.append('file', file)
      if (caption) form.append('body', caption)
      if (rep) form.append('replyTo', rep.id)
      const headers: Record<string, string> = {}; const t = getToken(); if (t) headers.authorization = `Bearer ${t}`
      const res = await fetch(`${API_BASE}/api/chat/conversations/${active.id}/upload`, { method: 'POST', headers, body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Upload failed')
      setMessages((prev) => prev.map((x) => (x.id === tmpId ? data : x))); loadConvos()
    } catch (err: any) {
      setMessages((m) => m.filter((x) => x.id !== tmpId)); toast.error('Could not send file: ' + err.message)
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
    } catch (e: any) { toast.error('Could not edit: ' + e.message) } finally { setBusy(false) }
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
    if (!(await confirmDialog({ message: mine ? 'Delete this message for everyone?' : 'Remove this message for you?', confirmText: mine ? 'Delete' : 'Remove', danger: true }))) return
    const snap = messages
    if (mine) setMessages((p) => p.map((x) => (x.id === m.id ? { ...x, deleted: true, body: '', file: null, reactions: [] } : x)))
    else setMessages((p) => p.filter((x) => x.id !== m.id))
    try { await api.del(`/chat/message/${m.id}`); loadConvos() } catch (e: any) { setMessages(snap); toast.error('Could not delete: ' + e.message) }
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
    else { try { await navigator.clipboard.writeText(url || m.body); toast.success('Link copied to clipboard') } catch {} }
  }
  const download = (m: Msg) => {
    setMenuId(null)
    const a = document.createElement('a'); a.href = fileUrl(m, true); a.download = m.file?.name || 'file'
    document.body.appendChild(a); a.click(); a.remove()
  }
  const startEdit = (m: Msg) => { setMenuId(null); setEditing({ id: m.id, body: m.body }); setInput(m.body); setReplyTo(null) }
  const startReply = (m: Msg) => { setMenuId(null); setReplyTo(m); setEditing(null) }

  const setPref = async (c: Conversation, pref: 'muted' | 'pinned') => {
    setConvoMenu(null)
    const next = !c[pref]
    setConvos((cs) => cs.map((x) => (x.id === c.id ? { ...x, [pref]: next } : x)))
    try { await api.post(`/chat/conversations/${c.id}/prefs`, { [pref]: next }); loadConvos() } catch { loadConvos() }
  }

  const clearChat = async (c: Conversation) => {
    setConvoMenu(null)
    if (!(await confirmDialog({ title: 'Clear chat', message: 'Clear all messages in this chat? This only clears them for you.', confirmText: 'Clear' }))) return
    try { await api.post(`/chat/conversations/${c.id}/clear`); if (c.id === activeId) setMessages([]); loadConvos() }
    catch (e: any) { toast.error('Could not clear: ' + e.message) }
  }

  const senderName = (uid: string) => (active?.members.find((mm) => mm.id === uid)?.name) || (uid === user?.id ? 'You' : 'Unknown')
  const senderColor = (uid: string) => active?.members.find((mm) => mm.id === uid)?.avatar_color

  const filteredConvos = convos.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
  const shownMessages = inSearch.trim()
    ? messages.filter((m) => !m.deleted && (m.body || '').toLowerCase().includes(inSearch.toLowerCase()))
    : messages
  // Interleave date separators (Today / Yesterday / date) + an "unread" divider.
  const logItems: ({ sep: string } | { unread: true } | { m: Msg })[] = []
  let lastDay = ''
  let unreadShown = false
  for (const m of shownMessages) {
    const day = new Date(m.created_at).toDateString()
    if (day !== lastDay) { logItems.push({ sep: dayLabel(m.created_at) }); lastDay = day }
    if (!unreadShown && !inSearch && threadLastRead && m.created_at > threadLastRead && m.sender_id !== user?.id) {
      logItems.push({ unread: true }); unreadShown = true
    }
    logItems.push({ m })
  }

  if (loading) return <div className="card" style={{ display: 'grid', placeItems: 'center', height: 'calc(100vh - 160px)' }}><span className="spinner" /></div>

  return (
    <div className={'assistant-layout chat-layout' + (activeId ? ' chat-open' : '')}>
      {/* ---- sidebar: conversations ---- */}
      <aside className="chat-history">
        <div className="chat-history-head">
          <span className="ch-title">Chats</span>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowStarred(true)} title="Starred messages" aria-label="Starred messages"><Ic name="star" size={16} /></button>
            <button className="btn btn-primary btn-sm row" style={{ gap: 5 }} onClick={() => setShowNew(true)} title="New chat / group"><Ic name="plus" size={15} /> New</button>
          </div>
        </div>
        <input className="chat-contact-search" placeholder="Search chats…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="convo-list">
          {filteredConvos.length === 0 && <div className="empty" style={{ padding: 16, fontSize: 13 }}>No chats yet</div>}
          {filteredConvos.map((c) => (
            <div key={c.id} className={'convo-item chat-contact' + (c.id === activeId ? ' active' : '')} onClick={() => setActiveId(c.id)}>
              {c.type === 'group'
                ? <GroupAvatar conv={c} size={38} />
                : <PresenceAvatar name={c.name} color={c.avatar_color} size={38} online={!!c.other_user_id && online.has(c.other_user_id)} src={c.avatar_file && c.other_user_id ? userAvatarUrl(c.other_user_id, c.avatar_file) : undefined} />}
              <div className="convo-meta" style={{ minWidth: 0, flex: 1 }}>
                <div className="row spread" style={{ gap: 6 }}>
                  <div className="convo-title row" style={{ gap: 5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.pinned && <span title="Pinned" style={{ display: 'inline-flex', color: 'var(--muted)' }}><Ic name="pin" size={12} /></span>}{c.name}</div>
                  {c.last_at && <span className="convo-time" style={{ flexShrink: 0 }}>{relTime(c.last_at)}</span>}
                </div>
                <div className="chat-contact-preview">
                  {c.last_message
                    ? (c.type === 'group' && c.last_sender_name ? `${c.last_from_me ? 'You' : c.last_sender_name}: ` : (c.last_from_me ? 'You: ' : '')) + c.last_message
                    : <span className="muted">{c.type === 'group' ? `${c.member_count} members` : 'Start a conversation'}</span>}
                </div>
              </div>
              <div className="convo-trailing">
                {c.muted && <span title="Muted" style={{ display: 'inline-flex', opacity: .6, color: 'var(--muted)' }}><Ic name="muteBell" size={13} /></span>}
                {c.unread > 0 && <span className={'chat-unread-badge' + (c.muted ? ' dim' : '')}>{c.unread > 9 ? '9+' : c.unread}</span>}
                <div className="convo-menu-wrap">
                  <button className="convo-menu-btn" title="Options" aria-label={`Options for ${c.name}`} onClick={(e) => { e.stopPropagation(); setConvoMenu(convoMenu === c.id ? null : c.id) }}>⋯</button>
                  {convoMenu === c.id && (
                    <div className="msg-menu mine" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => setPref(c, 'pinned')}>{c.pinned ? 'Unpin' : 'Pin to top'}</button>
                      <button onClick={() => setPref(c, 'muted')}>{c.muted ? 'Unmute' : 'Mute'}</button>
                      <button className="danger" onClick={() => clearChat(c)}>Clear chat</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* ---- conversation pane ---- */}
      <div className="card chat-pane" style={{ padding: 18 }}>
        <div className="chat">
          {active && (() => { const otherOnline = active.type === 'direct' && !!active.other_user_id && online.has(active.other_user_id); return (
            <div className="chat-peer-head">
              {/* Mobile-only: back to the conversation list (WhatsApp-style). */}
              <button className="chat-list-btn" onClick={() => setActiveId('')} title="Back to chats" aria-label="Back to chats">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
              </button>
              {active.type === 'group'
                ? <GroupAvatar conv={active} size={36} />
                : <PresenceAvatar name={active.name} color={active.avatar_color} size={36} online={otherOnline} src={active.avatar_file && active.other_user_id ? userAvatarUrl(active.other_user_id, active.avatar_file) : undefined} />}
              <div style={{ minWidth: 0, cursor: active.type === 'group' ? 'pointer' : 'default' }} onClick={() => active.type === 'group' && setShowInfo(true)}>
                <div style={{ fontWeight: 600 }}>{active.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {typingName ? <span className="typing-text">{typingName} is typing…</span>
                    : active.type === 'group' ? active.members.map((m) => m.name.split(' ')[0]).join(', ')
                      : otherOnline ? <span className="online-text">online</span>
                        : (active.other_user_id && lastSeen[active.other_user_id]) ? <span>{lastSeenLabel(lastSeen[active.other_user_id])}</span>
                          : <span style={{ textTransform: 'capitalize' }}>{active.members.find((m) => m.id !== user!.id)?.role || ''}</span>}
                </div>
              </div>
              <div className="row" style={{ marginLeft: 'auto', gap: 4 }}>
                <button className="btn btn-ghost btn-sm" title="Search in chat" aria-label="Search in chat" onClick={() => setInSearchOpen((o) => !o)}>
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
                  </svg>
                </button>
                {active.type === 'group' && <button className="btn btn-ghost btn-sm" title="Group info" aria-label="Group info" onClick={() => setShowInfo(true)}>ⓘ</button>}
              </div>
            </div>
          ) })()}

          {inSearchOpen && (
            <div className="in-search">
              <input autoFocus placeholder="Search messages…" value={inSearch} onChange={(e) => setInSearch(e.target.value)} />
              <button className="btn btn-ghost btn-sm" aria-label="Close search" onClick={() => { setInSearch(''); setInSearchOpen(false) }}>✕</button>
            </div>
          )}

          <div className="chat-log" ref={logRef}>
            {!active && (
              <div style={{ margin: 'auto' }}>
                <EmptyState
                  icon={<Ic name="chat" size={40} />}
                  title={convos.length ? 'Select a conversation' : 'No conversations yet'}
                  hint={convos.length
                    ? 'Choose a chat from the list to read and reply to messages.'
                    : 'Start a new chat with a teammate or create a group to begin messaging.'}
                  action={!convos.length ? <button className="btn btn-primary btn-sm row" style={{ gap: 5 }} onClick={() => setShowNew(true)}><Ic name="plus" size={15} /> New chat</button> : undefined}
                />
              </div>
            )}
            {active && shownMessages.length === 0 && <div className="empty" style={{ margin: 'auto', textAlign: 'center' }}>{inSearch ? 'No matching messages' : <>No messages yet.<br />Say hello</>}</div>}
            {logItems.map((it, idx) => {
              if ('sep' in it) return <div key={'sep' + idx} className="date-sep"><span>{it.sep}</span></div>
              if ('unread' in it) return <div key={'unread' + idx} className="unread-sep"><span>Unread messages</span></div>
              const m = it.m
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
                        <div className="bubble deleted row" style={{ gap: 6 }}><Ic name="block" size={13} /> This message was deleted<span className="bubble-foot"><span className="bubble-time">{fmtTime(m.created_at)}</span></span></div>
                      ) : (
                        <div className={'bubble ' + (mine ? 'user' : 'ai') + (m.file ? ' file-bubble' : '')}>
                          {m.forwarded && <div className="forwarded-tag row" style={{ gap: 5 }}><Ic name="forward" size={12} /> Forwarded</div>}
                          {m.reply && (
                            <div className="reply-quote"><span className="reply-quote-name">{m.reply.sender_id === user!.id ? 'You' : m.reply.sender_name}</span><span className="reply-quote-text">{m.reply.text}</span></div>
                          )}
                          {m.file && (isImage && !m.uploading
                            ? <a href={fileUrl(m)} target="_blank" rel="noreferrer"><img className="chat-image" src={fileUrl(m)} alt={m.file.name} /></a>
                            : <div className="chat-file">
                                <span className="chat-file-icon">{m.uploading ? <Ic name="clock" size={18} /> : <Ic name="attach" size={18} />}</span>
                                <span className="chat-file-meta"><span className="chat-file-name">{m.file?.name}</span><span className="chat-file-size">{m.uploading ? 'Sending…' : fmtSize(m.file?.size)}</span></span>
                                {!m.uploading && <button className="chat-file-dl" title="Download" aria-label="Download" onClick={() => download(m)}><Ic name="download" size={14} /></button>}
                              </div>)}
                          {m.body && <span className="bubble-text">{m.body}</span>}
                          {!m.file && (
                            <span className="bubble-foot-spacer" aria-hidden="true">
                              {m.starred && <span><Ic name="star" size={11} /></span>}
                              {m.edited_at && <span className="edited-tag">edited</span>}
                              <span>{fmtTime(m.created_at)}</span>
                              {mine && <span className="ticks">{m.seen ? '✓✓' : '✓'}</span>}
                            </span>
                          )}
                          <span className="bubble-foot">
                            {m.starred && <span title="Starred" style={{ display: 'inline-flex' }}><Ic name="star" size={11} /></span>}
                            {m.edited_at && <span className="edited-tag">edited</span>}
                            <span className="bubble-time">{fmtTime(m.created_at)}</span>
                            {mine && <span className="ticks" title={m.seen ? 'Seen' : 'Sent'}>{m.seen ? '✓✓' : '✓'}</span>}
                          </span>
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
                        <button className="msg-tool-btn" title="React" aria-label="React" onClick={(e) => { e.stopPropagation(); setReactFor(reactFor === m.id ? null : m.id); setMenuId(null) }}><Ic name="smile" size={16} /></button>
                        <button className="msg-tool-btn" title="Reply" aria-label="Reply" onClick={(e) => { e.stopPropagation(); startReply(m) }}><Ic name="reply" size={16} /></button>
                        <div className="msg-menu-wrap">
                          <button className="msg-tool-btn" title="More" onClick={(e) => { e.stopPropagation(); setMenuId(menuId === m.id ? null : m.id); setReactFor(null) }}>⋯</button>
                          {menuId === m.id && (
                            <div className={'msg-menu' + (mine ? ' mine' : '')} onClick={(e) => e.stopPropagation()}>
                              <button onClick={() => { setMenuId(null); startReply(m) }}>Reply</button>
                              <button onClick={() => { setMenuId(null); setForwardMsg(m) }}>Forward</button>
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
                  <div className="reply-banner-body"><span className="reply-quote-name">Replying to {replyTo.sender_id === user!.id ? 'yourself' : senderName(replyTo.sender_id)}</span><span className="reply-quote-text row" style={{ gap: 5 }}>{replyTo.file ? <><Ic name="attach" size={12} /> {replyTo.file.name}</> : replyTo.body}</span></div>
                  <button className="btn btn-ghost btn-sm" aria-label="Cancel reply" onClick={() => setReplyTo(null)}>✕</button>
                </div>
              )}
              {editing && (
                <div className="reply-banner editing"><div className="reply-banner-body"><span className="reply-quote-name">Editing message</span></div><button className="btn btn-ghost btn-sm" aria-label="Cancel editing" onClick={() => { setEditing(null); setInput('') }}>✕</button></div>
              )}
              <div className="chat-input">
                <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onPickFile} />
                <button className="btn btn-ghost attach-btn" title="Attach a file" aria-label="Attach a file" disabled={busy || !!editing} onClick={() => fileRef.current?.click()}>＋</button>
                <input
                  data-va="chats.composer"
                  placeholder={editing ? 'Edit your message…' : 'Type a message…'}
                  value={input}
                  onChange={(e) => { setInput(e.target.value); if (!editing) sendTyping(true) }}
                  // isComposing guard: with Indic (Telugu/Hindi) and other IME keyboards,
                  // Enter first COMMITS the composition — that keystroke must not send.
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send() }}
                  onBlur={() => sendTyping(false)}
                  autoFocus
                />
                <button data-va="chats.send" className="btn btn-primary" onClick={send} disabled={busy || !input.trim()}>{editing ? 'Save' : 'Send'}</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showNew && <NewChatModal user={user!} convos={convos} onClose={() => setShowNew(false)} onOpen={(cid) => { setShowNew(false); setActiveId(cid); loadConvos() }} />}
      {showInfo && active && active.type === 'group' && <GroupInfo conv={active} user={user!} onClose={() => setShowInfo(false)} onChanged={() => { loadConvos(); loadThread(active.id) }} onLeft={() => { setShowInfo(false); setActiveId(''); loadConvos() }} />}
      {forwardMsg && <ForwardModal message={forwardMsg} convos={convos} onClose={() => setForwardMsg(null)} onDone={() => { setForwardMsg(null); loadConvos() }} />}
      {showStarred && <StarredModal onClose={() => setShowStarred(false)} onOpen={(cid) => { setShowStarred(false); setActiveId(cid) }} />}
    </div>
  )
}

// ---------- Forward modal ----------
function ForwardModal({ message, convos, onClose, onDone }: { message: Msg; convos: Conversation[]; onClose: () => void; onDone: () => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const list = convos.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const go = async () => {
    if (!sel.size) return
    setBusy(true)
    try { await api.post(`/chat/message/${message.id}/forward`, { conversationIds: [...sel] }); onDone() } catch (e: any) { toast.error(e.message); setBusy(false) }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 style={{ margin: 0, fontSize: 16 }}>Forward to…</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>
        <div className="fwd-preview row" style={{ gap: 5 }}>{message.file ? <><Ic name="attach" size={13} /> {message.file.name}</> : message.body}</div>
        <input className="chat-contact-search" placeholder="Search chats…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="modal-list">
          {list.map((c) => (
            <div key={c.id} className="modal-user" onClick={() => toggle(c.id)}>
              {c.type === 'group' ? <GroupAvatar conv={c} size={34} /> : <Avatar name={c.name} color={c.avatar_color} size={34} src={c.avatar_file && c.other_user_id ? userAvatarUrl(c.other_user_id, c.avatar_file) : undefined} />}
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{c.name}</div><div className="muted" style={{ fontSize: 11.5 }}>{c.type === 'group' ? `${c.member_count} members` : 'Direct'}</div></div>
              <input type="checkbox" readOnly checked={sel.has(c.id)} />
            </div>
          ))}
          {list.length === 0 && <div className="empty" style={{ padding: 16 }}>No chats</div>}
        </div>
        <button className="btn btn-primary" style={{ width: '100%', marginTop: 10 }} disabled={busy || !sel.size} onClick={go}>Forward ({sel.size})</button>
      </div>
    </div>
  )
}

// ---------- Starred messages modal ----------
function StarredModal({ onClose, onOpen }: { onClose: () => void; onOpen: (convId: string) => void }) {
  const [items, setItems] = useState<Msg[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { api.get('/chat/starred').then((d) => setItems(d.items)).catch(() => {}).finally(() => setLoaded(true)) }, [])
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="star" size={16} /> Starred messages</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="modal-list">
          {loaded && items.length === 0 && <div className="empty" style={{ padding: 20 }}>No starred messages yet</div>}
          {items.map((m) => (
            <div key={m.id} className="starred-item" onClick={() => onOpen(m.conversation_id)}>
              <div className="starred-body row" style={{ gap: 6 }}>{m.file ? <><Ic name="attach" size={13} /> {m.file.name}</> : m.body}</div>
              <div className="muted" style={{ fontSize: 11 }}>{fmtTime(m.created_at)}</div>
            </div>
          ))}
        </div>
      </div>
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
    try { const c = await api.post('/chat/conversations', { type: 'direct', userId: uid }); onOpen(c.id) } catch (e: any) { toast.error(e.message); setBusy(false) }
  }
  const createGroup = async () => {
    if (!groupName.trim() || sel.size === 0) return
    setBusy(true)
    try { const c = await api.post('/chat/conversations', { type: 'group', name: groupName.trim(), memberIds: [...sel] }); onOpen(c.id) } catch (e: any) { toast.error(e.message); setBusy(false) }
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
              <Avatar name={u.name} color={u.avatar_color} size={34} src={u.avatar_file ? userAvatarUrl(u.id, u.avatar_file) : undefined} />
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
  const photoInput = useRef<HTMLInputElement>(null)
  const isAdmin = conv.role === 'admin'
  useEffect(() => { if (adding) api.get('/chat/users').then((d) => setUsers(d.users.filter((u: OrgUser) => !conv.members.some((m) => m.id === u.id)))).catch(() => {}) }, [adding])

  const uploadPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { toast.error('Please choose an image'); return }
    try {
      const form = new FormData(); form.append('file', file)
      const headers: Record<string, string> = {}; const t = getToken(); if (t) headers.authorization = `Bearer ${t}`
      const res = await fetch(`${API_BASE}/api/chat/conversations/${conv.id}/avatar`, { method: 'POST', headers, body: form })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Upload failed')
      onChanged()
    } catch (err: any) { toast.error('Could not set photo: ' + err.message) }
  }

  const rename = async () => { if (!name.trim() || name === conv.name) return; try { await api.patch(`/chat/conversations/${conv.id}`, { name: name.trim() }); onChanged() } catch (e: any) { toast.error(e.message) } }
  const addMembers = async () => { if (!sel.size) return; try { await api.post(`/chat/conversations/${conv.id}/members`, { userIds: [...sel] }); setAdding(false); setSel(new Set()); onChanged() } catch (e: any) { toast.error(e.message) } }
  const remove = async (uid: string) => { if (!(await confirmDialog({ message: 'Remove this member?', confirmText: 'Remove', danger: true }))) return; try { await api.del(`/chat/conversations/${conv.id}/members/${uid}`); onChanged() } catch (e: any) { toast.error(e.message) } }
  const leave = async () => { if (!(await confirmDialog({ title: 'Leave group', message: 'Leave this group?', confirmText: 'Leave', danger: true }))) return; try { await api.del(`/chat/conversations/${conv.id}/members/${user.id}`); onLeft() } catch (e: any) { toast.error(e.message) } }
  const deleteGroup = async () => { if (!(await confirmDialog({ title: 'Delete group', message: `Delete "${conv.name}" for everyone? This cannot be undone.`, confirmText: 'Delete', danger: true }))) return; try { await api.del(`/chat/conversations/${conv.id}`); onLeft() } catch (e: any) { toast.error(e.message) } }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 style={{ margin: 0, fontSize: 16 }}>Group info</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>
        <div style={{ display: 'grid', placeItems: 'center', marginBottom: 12 }}>
          <input ref={photoInput} type="file" accept="image/*" style={{ display: 'none' }} onChange={uploadPhoto} />
          <button className="avatar-edit-btn" disabled={!isAdmin} title={isAdmin ? 'Change group photo' : ''} onClick={() => isAdmin && photoInput.current?.click()}>
            <GroupAvatar conv={conv} size={72} />
            {isAdmin && <span className="avatar-edit-icon"><Ic name="edit" size={10} /></span>}
          </button>
        </div>
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
                  <Avatar name={u.name} color={u.avatar_color} size={32} src={u.avatar_file ? userAvatarUrl(u.id, u.avatar_file) : undefined} /><div style={{ flex: 1 }}>{u.name}</div><input type="checkbox" readOnly checked={sel.has(u.id)} />
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
                <Avatar name={m.name} color={m.avatar_color} size={32} src={m.avatar_file ? userAvatarUrl(m.id, m.avatar_file) : undefined} />
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.name}{m.id === user.id ? ' (you)' : ''}</div><div className="muted" style={{ fontSize: 11 }}>{m.role}</div></div>
                {isAdmin && m.id !== user.id && <button className="btn btn-ghost btn-sm danger" onClick={() => remove(m.id)}>Remove</button>}
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn btn-ghost danger" style={{ flex: 1 }} onClick={leave}>Leave group</button>
          {isAdmin && <button className="btn danger-solid" style={{ flex: 1 }} onClick={deleteGroup}>Delete group</button>}
        </div>
      </div>
    </div>
  )
}
