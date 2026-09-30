import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, getToken, userAvatarUrl, groupAvatarUrl, API_BASE, wsUrl } from '../api'
import { useAuth } from '../auth'
import { Avatar, EmptyState, Ic } from '../ui'
import { pushBackHandler } from '../back'
import { toast } from '../lib/toast'
import { confirmDialog } from '../lib/confirm'
import { stashTaskDraft } from '../lib/taskDraft'
import { startCall } from '../lib/call'
import EmojiPicker, { rememberEmoji } from '../components/EmojiPicker'
import VoicePlayer from '../components/VoicePlayer'
import { audioFilename } from '../lib/audioFile'
import { startLiveSpeech, isSupported as speechSupported, LiveSpeech } from '../lib/liveSpeech'
import { useSurface } from '../voice/uiRegistry'
import { typeInto, flashPress, pause, settle, findVaEl } from '../voice/uiController'

interface Member { id: string; name: string; avatar_color?: string; avatar_file?: string | null; role: string; status_text?: string; status_emoji?: string; dnd_until?: string | null }
interface Conversation {
  id: string; type: 'direct' | 'group'; name: string; avatar_color?: string; avatar_file?: string | null
  other_user_id?: string | null; other_last_seen?: string | null; member_count: number; members: Member[]; role: string
  last_message: string | null; last_sender_name: string | null; last_from_me: boolean; last_at: string | null; unread: number
  muted?: boolean; pinned?: boolean; visibility?: 'private' | 'public'
}
interface Reaction { emoji: string; user_id: string }
// Who a message named. Carried as ids + current names rather than re-parsed from
// the body, so two teammates sharing a first name stay distinguishable.
interface MentionRef { id: string; name: string }
interface ReplyPreview { id: string; sender_id: string; sender_name: string; text: string }
interface ChatFile { name: string; type?: string; size?: number }
interface Msg {
  id: string; conversation_id: string; sender_id: string; body: string; created_at: string
  edited_at?: string | null; forwarded?: boolean; reply_to?: string | null; reply?: ReplyPreview | null; file?: ChatFile | null
  reactions: Reaction[]; mentions?: MentionRef[]; starred: boolean; seen: boolean; deleted?: boolean; uploading?: boolean
  pinned_at?: string | null; call?: CallInfo | null; transcript?: string | null
}
// A finished call leaves a line in the thread instead of a chat bubble.
interface CallInfo { id: string; kind: 'audio' | 'video'; status: string; started_by: string; duration_sec: number; joined: number }
interface OrgUser { id: string; name: string; email: string; role: string; avatar_color?: string; avatar_file?: string | null }

const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏']
const MAX_FILE = 15 * 1024 * 1024
const isAudio = (f?: ChatFile | null) => !!f && ((f.type || '').startsWith('audio/') || /\.(webm|m4a|mp3|ogg|wav)$/i.test(f.name || ''))
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
// Local calendar day as YYYY-MM-DD. toISOString() would shift the day for
// anyone east or west of UTC, which is the whole user base here.
function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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

// ---------- slash commands ----------
// Cliq's /commands, minus the developer platform behind them. These are the ones
// that save a real trip through the UI; a command that just opens a dialog you
// could have clicked is noise, so there are only seven.
interface SlashCmd { name: string; args?: string; help: string; manager?: boolean }
const SLASH: SlashCmd[] = [
  { name: 'task', args: '<what needs doing>', help: 'Turn the rest of the line into a task' },
  { name: 'call', help: 'Start an audio call here' },
  { name: 'video', help: 'Start a video call here' },
  { name: 'status', args: '<message>', help: 'Set your status' },
  { name: 'dnd', args: '<minutes>', help: 'Do not disturb — 0 turns it off' },
  { name: 'search', args: '<words>', help: 'Search every conversation' },
  { name: 'shrug', help: String.fromCharCode(175) + '\\_(' + String.fromCharCode(12484) + ')_/' + String.fromCharCode(175) },
]

// The half-typed command at the caret, if the line starts with one.
function slashQueryAt(value: string) {
  const m = /^\/([a-z]*)$/i.exec(value)
  return m ? m[1].toLowerCase() : null
}

// ---------- workload chip ----------
// What a chat app normally cannot tell you: what this person is already holding.
// Silent when they are clear — a chip on everyone teaches people to ignore it.
function LoadChip({ load, compact }: { load?: { open: number; overdue: number }; compact?: boolean }) {
  if (!load || !load.open) return null
  const late = load.overdue > 0
  return (
    <span className={'load-chip' + (late ? ' late' : '')} title={`${load.open} open task${load.open === 1 ? '' : 's'}${late ? `, ${load.overdue} overdue` : ''}`}>
      {late ? <Ic name="warning" size={10} /> : <Ic name="check" size={10} />}
      {compact ? `${load.open}` : `${load.open} open`}{late ? ` · ${load.overdue} late` : ''}
    </span>
  )
}

// ---------- @mentions ----------
const ALL_TOKENS = ['all', 'everyone']
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The @-token being typed, if the caret sits at the end of one. Allows a single
// space so "@Ravi Kumar" keeps matching while it's typed; two spaces ends it,
// which is what stops an ordinary sentence after a mention from re-opening the
// picker.
function mentionQueryAt(value: string, caret: number): { q: string; start: number } | null {
  const upto = value.slice(0, caret)
  const m = /(?:^|\s)@([^@\s]{0,24}(?:\s[^@\s]{0,24})?)$/.exec(upto)
  if (!m) return null
  return { q: m[1], start: upto.length - m[1].length - 1 }
}

// Which teammates a body still names. The text is the source of truth, not the
// picker: deleting "@Ravi" out of the draft has to un-mention Ravi, or people get
// pinged by a name that is no longer in the message.
function resolveMentions(text: string, picked: MentionRef[], members: Member[], meId: string): string[] {
  const ids = new Set<string>()
  if (new RegExp(`@(${ALL_TOKENS.join('|')})\\b`, 'i').test(text)) {
    for (const m of members) if (m.id !== meId) ids.add(m.id)
  }
  for (const p of picked) if (text.includes('@' + p.name)) ids.add(p.id)
  ids.delete(meId)
  return [...ids]
}

// Render a message body: fenced code, inline code, *bold*, _italic_, ~strike~,
// links, and the @names.
//
// Deliberately a hand-rolled subset rather than a markdown library. A full
// markdown renderer on chat input is a liability — it turns a lone asterisk or an
// underscore in a filename into formatting, swallows indentation as a code block,
// and (with anything that emits HTML) hands us an injection surface for free.
// This handles the five things people actually type in a work chat and leaves
// every other character alone. Nothing here produces HTML: it is all React nodes,
// so message text can never be interpreted as markup.
const CODE_FENCE = /```([\s\S]*?)```/g
// A conservative URL matcher — stops at whitespace and trailing punctuation so a
// link at the end of a sentence doesn't swallow the full stop.
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g

function renderInline(text: string, mentionNames: string[], meNames: Set<string>, keyBase: string): React.ReactNode[] {
  // One pass, longest-first so `@Ravi Kumar` never matches as `@Ravi`, and so
  // ``` has already been taken out by the caller.
  const names = [...mentionNames].sort((a, b) => b.length - a.length).map(reEsc)
  const parts: string[] = ['`[^`\\n]+`', '\\*[^*\\n]+\\*', '_[^_\\n]+_', '~[^~\\n]+~', URL_RE.source]
  if (names.length) parts.push('@(?:' + names.join('|') + ')\\b')
  parts.push('@(?:all|everyone)\\b')
  const re = new RegExp(parts.join('|'), 'gi')

  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const k = `${keyBase}-${i++}`
    if (tok.startsWith('`') && tok.endsWith('`')) out.push(<code key={k} className="msg-code">{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('*') && tok.endsWith('*')) out.push(<b key={k}>{tok.slice(1, -1)}</b>)
    else if (tok.startsWith('_') && tok.endsWith('_')) out.push(<i key={k}>{tok.slice(1, -1)}</i>)
    else if (tok.startsWith('~') && tok.endsWith('~')) out.push(<s key={k}>{tok.slice(1, -1)}</s>)
    else if (/^https?:\/\//i.test(tok)) out.push(<a key={k} href={tok} target="_blank" rel="noopener noreferrer" className="msg-link">{tok}</a>)
    else {
      const who = tok.slice(1)
      out.push(<span key={k} className={'mention-chip' + (meNames.has(who.toLowerCase()) ? ' me' : '')}>{tok}</span>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function MessageText({ body, mentions, meId, fromMe }: { body: string; mentions?: MentionRef[]; meId: string; fromMe: boolean }) {
  const refs = mentions || []
  const names = refs.map((r) => r.name)
  // Which @names refer to ME — drives the stronger chip. @all counts, but not in
  // my own message, where I am the one doing the summoning.
  const meNames = new Set<string>()
  for (const r of refs) if (r.id === meId) meNames.add(r.name.toLowerCase())
  if (!fromMe) { meNames.add('all'); meNames.add('everyone') }

  const nodes: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  CODE_FENCE.lastIndex = 0
  while ((m = CODE_FENCE.exec(body)) !== null) {
    if (m.index > last) nodes.push(...renderInline(body.slice(last, m.index), names, meNames, `t${i}`))
    nodes.push(<pre key={`c${i}`} className="msg-pre"><code>{m[1].replace(/^\n/, '').replace(/\n$/, '')}</code></pre>)
    last = m.index + m[0].length
    i++
  }
  if (last < body.length) nodes.push(...renderInline(body.slice(last), names, meNames, `t${i}`))

  return <span className="bubble-text">{nodes}</span>
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
  const navigate = useNavigate()
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
  const [showMentions, setShowMentions] = useState(false)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [pinned, setPinned] = useState<Msg[]>([])
  const [pinsOpen, setPinsOpen] = useState(false)
  const [remindFor, setRemindFor] = useState<Msg | null>(null)
  const [showLater, setShowLater] = useState(false)
  const [showStatus, setShowStatus] = useState(false)
  const [muteFor, setMuteFor] = useState<Conversation | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [myStatus, setMyStatus] = useState<{ status_text: string; status_emoji: string; dnd_until: string | null }>({ status_text: '', status_emoji: '', dnd_until: null })
  // Global message search: null = not searching, [] = searched and found nothing.
  const [hits, setHits] = useState<(Msg & { sender_name: string; conversation_name: string })[] | null>(null)
  const [hitsBusy, setHitsBusy] = useState(false)
  // open/overdue per teammate. The point of the whole feature: you see what
  // someone is already carrying at the moment you are about to hand them more.
  const [workload, setWorkload] = useState<Record<string, { open: number; overdue: number }>>({})
  const isManager = user?.role === 'manager' || user?.role === 'admin'
  const [emojiFor, setEmojiFor] = useState<string | null>(null)   // message id, or '__composer__'
  const [showChannels, setShowChannels] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const [headMenu, setHeadMenu] = useState(false)
  const [slashQ, setSlashQ] = useState<string | null>(null)
  const [slashIdx, setSlashIdx] = useState(0)
  const [forkFrom, setForkFrom] = useState<Msg | null>(null)
  const [recording, setRecording] = useState(false)
  const [recSecs, setRecSecs] = useState(0)
  const [transcribing, setTranscribing] = useState<string | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [forwardMsg, setForwardMsg] = useState<Msg | null>(null)
  // @mention composer state: the open picker, its keyboard cursor, and everyone
  // picked so far in this draft (filtered against the text again at send time).
  const [mentionQ, setMentionQ] = useState<{ q: string; start: number } | null>(null)
  const [mentionIdx, setMentionIdx] = useState(0)
  const [picked, setPicked] = useState<MentionRef[]>([])
  const [online, setOnline] = useState<Set<string>>(new Set())
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({})
  const [threadLastRead, setThreadLastRead] = useState<string | null>(null)
  const [convoMenu, setConvoMenu] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const voiceRecRef = useRef<MediaRecorder | null>(null)
  const voiceChunksRef = useRef<BlobPart[]>([])
  const voiceStreamRef = useRef<MediaStream | null>(null)
  const voiceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const voiceCancelRef = useRef(false)
  // Recognised on this device while the note is being spoken, so the text is
  // ready the moment it sends — no server key, no second pass, no cost.
  const voiceSpeechRef = useRef<LiveSpeech | null>(null)
  const voiceTextRef = useRef<string[]>([])
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

  useEffect(() => { api.get('/chat/status').then(setMyStatus).catch(() => {}) }, [])
  const loadWorkload = () => api.get('/chat/workload').then((d) => setWorkload(d.byUser || {})).catch(() => {})
  useEffect(() => { loadWorkload() }, [])
  // Re-read it when the window comes back: tasks get closed elsewhere in the app
  // and a stale "4 overdue" chip is worse than none.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') loadWorkload() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const loadPins = (cid: string) => api.get(`/chat/conversations/${cid}/pinned`).then((d) => setPinned(d.items)).catch(() => setPinned([]))
  const loadThread = (cid: string) => api.get(`/chat/conversations/${cid}`).then((d) => {
    setMessages(d.messages)
    setThreadLastRead(d.last_read_at || null)
    if (d.conversation.type === 'direct' && d.conversation.other_user_id && d.conversation.other_last_seen) {
      setLastSeen((s) => ({ ...s, [d.conversation.other_user_id]: d.conversation.other_last_seen }))
    }
    setConvos((cs) => cs.map((c) => (c.id === cid ? { ...c, unread: 0, members: d.conversation.members, role: d.conversation.role, muted: d.conversation.muted, pinned: d.conversation.pinned } : c)))
    pingNav()
    // Arrived via a message link — land on that line rather than the bottom.
    const want = deepMsgRef.current
    if (want) {
      deepMsgRef.current = null
      requestAnimationFrame(() => scrollToMessage(want))
    }
  }).catch(() => {})

  // Open a conversation and land on a specific message. The same-thread case has
  // to be handled explicitly: setActiveId to the value it already holds does not
  // re-run the load effect, so a search hit inside the thread you are already in
  // would otherwise do nothing at all.
  const openMessage = (convId: string, messageId?: string | null) => {
    if (messageId && convId === activeIdRef.current) { scrollToMessage(messageId); return }
    deepMsgRef.current = messageId || null
    setActiveId(convId)
  }

  // Bring a message into view and flash it. Shared by the date jump, message
  // links and the pinned bar — all three mean "show me that line".
  const scrollToMessage = (id: string) => {
    const el = logRef.current?.querySelector(`[data-msg="${id}"]`) as HTMLElement | null
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlashId(id)
    setTimeout(() => setFlashId((f) => (f === id ? null : f)), 1800)
  }

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
  // A pasted message link (?c=…&msg=…): open that thread and scroll to the line.
  const deepMsgRef = useRef<string | null>(null)
  useEffect(() => {
    const c = params.get('c')
    const msg = params.get('msg')
    if (!c || !user) return
    setParams(new URLSearchParams(), { replace: true })
    deepMsgRef.current = msg
    setActiveId(c)
  }, [params, user?.id])

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
  useEffect(() => { if (activeId) { loadThread(activeId); loadPins(activeId); setReplyTo(null); setEditing(null); setInSearch(''); setInSearchOpen(false); setShowInfo(false); setPinsOpen(false) } else setPinned([]) }, [activeId])
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
  useEffect(() => { const h = () => { setMenuId(null); setReactFor(null); setConvoMenu(null); setJumpOpen(false); setEmojiFor(null); setHeadMenu(false) }; document.addEventListener('click', h); return () => document.removeEventListener('click', h) }, [])

  // An open thread is a full-screen surface on a phone, so the bottom tab bar and
  // the feedback tab have to stand down: measured at 430px they cover 829–900 and
  // 786–820 while the composer occupies 787–847, which buries the one control the
  // screen exists for. The flag goes on <body>, not on this page's root, because
  // both of those are rendered by Layout in App.tsx — outside this component. The
  // mobile block in styles.css is what acts on it; on desktop it means nothing.
  useEffect(() => {
    document.body.classList.toggle('chat-thread-open', !!activeId)
    return () => document.body.classList.remove('chat-thread-open')
  }, [activeId])

  // The composer carries three buttons, so the placeholder gets ~162px at 430px
  // and less below that. "@ to mention" needs 158px and clips mid-word on a 390px
  // phone, which reads like a bug rather than a hint — so the hint only appears
  // where it actually fits. Typing @ opens the picker either way.
  const [roomForHint, setRoomForHint] = useState(() => typeof window === 'undefined' || window.innerWidth >= 430)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 430px)')
    const sync = () => setRoomForHint(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // Android back button: close the top-most open layer (menu → modal → search →
  // conversation list) instead of leaving Chats / quitting the app.
  useEffect(() => pushBackHandler(() => {
    if (emojiFor) { setEmojiFor(null); return true }
    if (recording) { finishVoiceNote(true); return true }
    if (mentionQ) { setMentionQ(null); return true }
    if (menuId || reactFor || convoMenu) { setMenuId(null); setReactFor(null); setConvoMenu(null); return true }
    if (forwardMsg) { setForwardMsg(null); return true }
    if (showMentions) { setShowMentions(false); return true }
    if (showStarred) { setShowStarred(false); return true }
    if (showInfo) { setShowInfo(false); return true }
    if (showNew) { setShowNew(false); return true }
    if (inSearchOpen) { setInSearchOpen(false); setInSearch(''); return true }
    if (activeId) { setActiveId(''); return true } // open chat → back to the list
    return false
  }), [emojiFor, recording, mentionQ, menuId, reactFor, convoMenu, forwardMsg, showMentions, showStarred, showInfo, showNew, inSearchOpen, activeId])

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
        } else if (d.type === 'transcript') {
          if (inActive) setMessages((p) => p.map((m) => (m.id === d.id ? { ...m, transcript: d.transcript } : m)))
        } else if (d.type === 'pin') {
          if (inActive) {
            setMessages((p) => p.map((m) => (m.id === d.id ? { ...m, pinned_at: d.pinned ? new Date().toISOString() : null } : m)))
            loadPins(d.conversationId)
          }
        } else if (d.type === 'status') {
          // Someone set a custom status or flipped DND — patch them wherever
          // they appear rather than refetching every conversation.
          setConvos((cs) => cs.map((c) => ({
            ...c,
            members: c.members.map((mm) => (mm.id === d.userId ? { ...mm, status_text: d.status_text, status_emoji: d.status_emoji, dnd_until: d.dnd_until } : mm)),
          })))
        } else if (d.type === 'reminder') {
          toast.info(`Reminder: ${String(d.preview || '').slice(0, 60)}`)
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
    // A slash command is an instruction to the app, not a message to the room.
    if (body.startsWith('/') && await runSlash(body)) { setSlashQ(null); return }
    const mentions = resolveMentions(body, picked, active.members, user!.id)
    const mentionRefs = picked.filter((p) => mentions.includes(p.id))
    setInput(''); setBusy(true); sendTyping(false); setPicked([]); setMentionQ(null)
    const rep = replyTo
    const optimistic: Msg = { id: 'tmp_' + Date.now(), conversation_id: active.id, sender_id: user!.id, body, created_at: new Date().toISOString(), reactions: [], mentions: mentionRefs, starred: false, seen: false, reply: rep ? { id: rep.id, sender_id: rep.sender_id, sender_name: senderName(rep.sender_id), text: rep.file ? rep.file.name : rep.body } : null, reply_to: rep?.id || null }
    setMessages((m) => [...m, optimistic]); setReplyTo(null)
    try {
      const saved = await api.post(`/chat/conversations/${active.id}/messages`, { body, replyTo: rep?.id, mentions })
      mergeIncoming(saved); loadConvos()
    } catch (e: any) {
      setMessages((m) => m.filter((x) => x.id !== optimistic.id)); setInput(body); toast.error('Could not send: ' + e.message)
    } finally { setBusy(false) }
  }

  // ---- voice notes --------------------------------------------------------
  // Speech is the fastest way to say something complicated, and this team works
  // across Telugu, Hindi and English — so a voice note is often the honest form
  // of a message. It is sent as an ordinary audio attachment, which means every
  // existing path (storage, forward, delete, search by filename) already works;
  // only the player and the transcribe button are new.
  const stopVoiceTimer = () => { if (voiceTimerRef.current) { clearInterval(voiceTimerRef.current); voiceTimerRef.current = null } }

  const releaseVoice = () => {
    stopVoiceTimer()
    try { voiceSpeechRef.current?.stop() } catch {}
    voiceSpeechRef.current = null
    try { voiceStreamRef.current?.getTracks().forEach((t) => t.stop()) } catch {}
    voiceStreamRef.current = null
    voiceRecRef.current = null
    setRecording(false)
    setRecSecs(0)
  }
  useEffect(() => releaseVoice, [])

  const startVoiceNote = async () => {
    if (recording || busy || !active) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      voiceStreamRef.current = stream
      const rec = new MediaRecorder(stream)
      voiceChunksRef.current = []
      voiceCancelRef.current = false
      rec.ondataavailable = (e) => { if (e.data && e.data.size) voiceChunksRef.current.push(e.data) }
      rec.onstop = async () => {
        const chunks = voiceChunksRef.current
        voiceChunksRef.current = []
        const cancelled = voiceCancelRef.current
        // Grab the recognised text before releaseVoice() clears it.
        const spoken = voiceTextRef.current.join(' ').trim()
        releaseVoice()
        if (cancelled || !chunks.length) return
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        if (blob.size < 1200) { toast.info('That was too short to send'); return }
        await sendVoiceNote(blob, spoken)
      }
      rec.start()
      voiceRecRef.current = rec
      voiceTextRef.current = []
      // Listen alongside the recorder. The two are independent: if speech
      // recognition is unavailable the note still sends, just without text.
      voiceSpeechRef.current = speechSupported()
        ? startLiveSpeech((t) => { voiceTextRef.current.push(t) })
        : null
      setRecording(true)
      setRecSecs(0)
      voiceTimerRef.current = setInterval(() => setRecSecs((n) => {
        // Hard stop at two minutes: past that it is a call, not a note.
        if (n >= 119) { try { voiceRecRef.current?.stop() } catch {} }
        return n + 1
      }), 1000)
    } catch {
      toast.error('No microphone available')
    }
  }

  const finishVoiceNote = (cancel = false) => {
    voiceCancelRef.current = cancel
    const rec = voiceRecRef.current
    if (rec && rec.state !== 'inactive') { try { rec.stop() } catch { releaseVoice() } }
    else releaseVoice()
  }

  const sendVoiceNote = async (blob: Blob, spoken = '') => {
    if (!active) return
    setBusy(true)
    const tmpId = 'tmp_' + Date.now()
    const name = audioFilename(blob, 'voice-note')
    setMessages((m) => [...m, { id: tmpId, conversation_id: active.id, sender_id: user!.id, body: '', created_at: new Date().toISOString(), reactions: [], starred: false, seen: false, transcript: spoken || null, file: { name, type: blob.type, size: blob.size }, uploading: true }])
    try {
      const form = new FormData()
      form.append('file', new File([blob], name, { type: blob.type || 'audio/webm' }))
      if (spoken) form.append('transcript', spoken)
      const headers: Record<string, string> = {}
      const t = getToken(); if (t) headers.authorization = `Bearer ${t}`
      const res = await fetch(`${API_BASE}/api/chat/conversations/${active.id}/upload`, { method: 'POST', headers, body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Upload failed')
      setMessages((prev) => prev.map((x) => (x.id === tmpId ? data : x)))
      loadConvos()
    } catch (e: any) {
      setMessages((m) => m.filter((x) => x.id !== tmpId))
      toast.error('Could not send the voice note: ' + e.message)
    } finally { setBusy(false) }
  }

  // Read a voice note out loud into text. Cached server-side, so the second
  // person to press it pays nothing.
  const transcribeNote = async (m: Msg) => {
    if (m.transcript || transcribing) return
    setTranscribing(m.id)
    try {
      const d = await api.post(`/chat/message/${m.id}/transcribe`)
      setMessages((p) => p.map((x) => (x.id === m.id ? { ...x, transcript: d.text } : x)))
    } catch (e: any) {
      toast.error(e.message.includes('NO_PROVIDER') || /provider/i.test(e.message)
        ? 'Transcription needs a speech provider key on the server.'
        : 'Could not transcribe: ' + e.message)
    } finally { setTranscribing(null) }
  }

  // ---- chat → task --------------------------------------------------------
  // Hand the message (or the line still in the composer) to the Tasks page as a
  // pre-filled draft. The draft is built server-side so it uses the same due-date
  // and priority rules as the rest of the app. Nothing is created here: the real
  // New task form opens filled and stops at the unpressed Create button, because
  // handing someone work should stay a deliberate act — the same reason the voice
  // assistant never submits a form either.
  const toTask = async (payload: { messageId?: string; text?: string; mentions?: string[] }) => {
    setMenuId(null)
    try {
      const draft = await api.post('/chat/task-draft', payload)
      stashTaskDraft(draft)
      navigate('/tasks?new=1')
    } catch (e: any) { toast.error('Could not build the task: ' + e.message) }
  }
  const draftFromComposer = () => {
    const text = input.trim()
    if (!text || !active) return
    toTask({ text, mentions: resolveMentions(text, picked, active.members, user!.id) })
  }

  // Print the conversation. Opens a plain, self-contained document rather than
  // printing the app: the real page is a fixed-height flex column with its own
  // scroller, which a printer turns into one page of whatever happened to be in
  // view. This is the transcript, which is what anyone printing a chat wants.
  const printConversation = () => {
    if (!active) return
    const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as any)[c])
    const rows = messages.filter((m) => !m.deleted).map((m) => {
      const who = m.sender_id === user!.id ? 'You' : senderName(m.sender_id)
      const when = `${dayLabel(m.created_at)} ${fmtTime(m.created_at)}`
      const what = m.call ? m.body : (m.body || (m.file ? `[file] ${m.file.name}` : ''))
      return `<tr><td class="w">${esc(who)}</td><td class="b">${esc(what)}</td><td class="t">${esc(when)}</td></tr>`
    }).join('')
    const win = window.open('', '_blank', 'width=820,height=900')
    if (!win) { toast.error('Your browser blocked the print window'); return }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(active.name)} — VoTask</title>
      <style>
        body { font: 13px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; color: #111; margin: 32px; }
        h1 { font-size: 17px; margin: 0 0 2px; } .sub { color: #666; font-size: 12px; margin-bottom: 18px; }
        table { border-collapse: collapse; width: 100%; }
        td { vertical-align: top; padding: 5px 8px; border-bottom: 1px solid #eee; }
        .w { font-weight: 700; white-space: nowrap; width: 1%; }
        .t { color: #888; font-size: 11px; white-space: nowrap; width: 1%; text-align: right; }
        .b { white-space: pre-wrap; word-break: break-word; }
      </style></head><body>
      <h1>${esc(active.name)}</h1>
      <div class="sub">${messages.length} messages · printed ${esc(new Date().toLocaleString())}</div>
      <table>${rows}</table></body></html>`)
    win.document.close()
    win.focus()
    setTimeout(() => win.print(), 250)
  }

  // ---- slash commands -----------------------------------------------------
  const slashOptions = useMemo(() => {
    if (slashQ === null) return []
    return SLASH.filter((c) => c.name.startsWith(slashQ)).slice(0, 7)
  }, [slashQ])

  // Returns true if the line was a command and has been dealt with, so send()
  // knows not to post it as a message.
  const runSlash = async (line: string): Promise<boolean> => {
    const m = /^\/([a-z]+)\s*([\s\S]*)$/i.exec(line.trim())
    if (!m) return false
    const cmd = m[1].toLowerCase()
    const rest = m[2].trim()
    const known = SLASH.some((c) => c.name === cmd)
    if (!known) return false

    switch (cmd) {
      case 'task':
        if (!rest) { toast.info('Try /task followed by what needs doing'); return true }
        setInput('')
        await toTask({ text: rest, mentions: active ? resolveMentions(rest, picked, active.members, user!.id) : [] })
        return true
      case 'call':
      case 'video':
        if (!active) return true
        setInput('')
        startCall(active.id, cmd === 'video' ? 'video' : 'audio', active.name)
        return true
      case 'status':
        setInput('')
        try {
          const saved = await api.post('/chat/status', { status_text: rest, status_emoji: myStatus.status_emoji || '', dnd_minutes: 0 })
          setMyStatus(saved)
          toast.success(rest ? `Status set: ${rest}` : 'Status cleared')
        } catch (e: any) { toast.error(e.message) }
        return true
      case 'dnd': {
        setInput('')
        const mins = Number(rest || 60)
        if (!Number.isFinite(mins) || mins < 0) { toast.error('Try /dnd 60'); return true }
        try {
          const saved = await api.post('/chat/status', { status_text: myStatus.status_text || '', status_emoji: myStatus.status_emoji || '', dnd_minutes: mins })
          setMyStatus(saved)
          toast.success(mins > 0 ? `Do not disturb for ${mins} min` : 'Do not disturb off')
        } catch (e: any) { toast.error(e.message) }
        return true
      }
      case 'search':
        setInput('')
        if (!rest) { toast.info('Try /search followed by what to look for'); return true }
        setSearch(rest)
        setTimeout(() => { void runGlobalSearch(rest) }, 0)
        return true
      case 'shrug':
        // Not a command so much as a shortcut — it becomes the message.
        setInput((rest ? rest + ' ' : '') + '¯\\_(ツ)_/¯')
        requestAnimationFrame(() => inputRef.current?.focus())
        return true
    }
    return false
  }

  // ---- @mention picker ----------------------------------------------------
  // Candidates for the open @-token: teammates in this conversation, plus @All in
  // a group. Filtered on the typed fragment, ranked prefix-first.
  const mentionOptions: MentionRef[] = useMemo(() => {
    if (!mentionQ || !active) return []
    const q = mentionQ.q.trim().toLowerCase()
    const people = active.members.filter((m) => m.id !== user?.id).map((m) => ({ id: m.id, name: m.name }))
    const pool: MentionRef[] = active.type === 'group' ? [{ id: '__all__', name: 'All' }, ...people] : people
    if (!q) return pool.slice(0, 6)
    // Exact beats prefix beats substring, and a shorter name breaks the tie. With
    // names like "Employee 1" and "Employee 17" a plain prefix sort leaves the
    // typed-in-full name sitting under its longer neighbour, and Enter then pings
    // the wrong person — which, unlike a filter, is a message to a real human.
    const rank = (name: string) => { const n = name.toLowerCase(); return n === q ? 3 : n.startsWith(q) ? 2 : 1 }
    return pool
      .filter((p) => p.name.toLowerCase().includes(q))
      .sort((a, b) => rank(b.name) - rank(a.name) || a.name.length - b.name.length || a.name.localeCompare(b.name))
      .slice(0, 6)
  }, [mentionQ, active, user?.id])

  // Swap the half-typed @token for the chosen name and put the caret after it.
  const applyMention = (opt: MentionRef) => {
    if (!mentionQ) return
    const before = input.slice(0, mentionQ.start)
    const after = input.slice(mentionQ.start + 1 + mentionQ.q.length)
    const next = `${before}@${opt.name} ${after.startsWith(' ') ? after.slice(1) : after}`
    setInput(next)
    if (opt.id !== '__all__') setPicked((p) => (p.some((x) => x.id === opt.id) ? p : [...p, opt]))
    setMentionQ(null); setMentionIdx(0)
    const caret = before.length + opt.name.length + 2
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(caret, caret) })
  }

  const pickSlash = (c: SlashCmd) => {
    setInput('/' + c.name + ' ')
    setSlashQ(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  // Grow with the content up to a ceiling, then scroll. Done here rather than in
  // CSS because a textarea has no content-driven height.
  const autoGrow = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 132) + 'px'
  }
  useEffect(() => { autoGrow(inputRef.current) }, [input])

  const onComposerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInput(value)
    if (!editing) sendTyping(true)
    const found = active ? mentionQueryAt(value, e.target.selectionStart ?? value.length) : null
    setMentionQ(found)
    setMentionIdx(0)
    setSlashQ(slashQueryAt(value))
    setSlashIdx(0)
  }

  // Enter/Tab take the highlighted name instead of sending — the picker is open,
  // so that keystroke belongs to it.
  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashQ !== null && slashOptions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashOptions.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashOptions.length) % slashOptions.length); return }
      if (e.key === 'Tab') { e.preventDefault(); pickSlash(slashOptions[slashIdx]); return }
      if (e.key === 'Escape') { e.preventDefault(); setSlashQ(null); return }
      // Enter on a command that needs no argument runs it; one that takes an
      // argument completes first, so you don't fire /task with nothing after it.
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault()
        const hit = slashOptions[slashIdx]
        if (hit?.args) pickSlash(hit)
        else { setSlashQ(null); void runSlash('/' + (hit?.name || slashQ)) }
        return
      }
    }
    if (mentionQ && mentionOptions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionOptions.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionOptions.length) % mentionOptions.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(mentionOptions[mentionIdx]); return }
      if (e.key === 'Escape') { e.preventDefault(); setMentionQ(null); return }
    }
    // Shift+Enter is a newline — which is what makes multi-line messages and
    // ``` code blocks typable at all. Plain Enter still sends, because that is
    // what every chat app does and muscle memory is not negotiable.
    //
    // isComposing guard: with Indic (Telugu/Hindi) and other IME keyboards,
    // Enter first COMMITS the composition — that keystroke must not send.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
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
    const capMentions = caption ? resolveMentions(caption, picked, active.members, user!.id) : []
    setInput(''); setBusy(true); setReplyTo(null); setPicked([]); setMentionQ(null)
    const tmpId = 'tmp_' + Date.now()
    setMessages((m) => [...m, { id: tmpId, conversation_id: active.id, sender_id: user!.id, body: caption, created_at: new Date().toISOString(), reactions: [], starred: false, seen: false, file: { name: file.name, type: file.type, size: file.size }, uploading: true }])
    try {
      const form = new FormData(); form.append('file', file)
      if (caption) form.append('body', caption)
      if (rep) form.append('replyTo', rep.id)
      if (capMentions.length) form.append('mentions', JSON.stringify(capMentions))
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
  const togglePin = async (m: Msg) => {
    setMenuId(null)
    const next = !m.pinned_at
    try {
      if (next) await api.post(`/chat/message/${m.id}/pin`)
      else await api.del(`/chat/message/${m.id}/pin`)
      setMessages((p) => p.map((x) => (x.id === m.id ? { ...x, pinned_at: next ? new Date().toISOString() : null } : x)))
      if (activeId) loadPins(activeId)
    } catch (e: any) { toast.error('Could not pin: ' + e.message) }
  }

  // Cliq's "leave this for later": rewind the read cursor and drop back to the
  // list, because staying in the thread would mark it read again on the spot.
  const markUnread = async (m: Msg) => {
    setMenuId(null)
    try {
      await api.post(`/chat/conversations/${m.conversation_id}/unread`, { messageId: m.id })
      setActiveId('')
      loadConvos()
      toast.success('Marked unread')
    } catch (e: any) { toast.error('Could not mark unread: ' + e.message) }
  }

  // A link that reopens this exact message. ?msg= is picked up on load and
  // scrolled to, so a link pasted into a task or an email lands on the message
  // rather than at the bottom of the thread.
  const copyLink = async (m: Msg) => {
    setMenuId(null)
    const url = `${location.origin}/chats?c=${m.conversation_id}&msg=${m.id}`
    try { await navigator.clipboard.writeText(url); toast.success('Link copied') } catch { window.prompt('Copy:', url) }
  }

  const startEdit = (m: Msg) => { setMenuId(null); setEditing({ id: m.id, body: m.body }); setInput(m.body); setReplyTo(null) }
  const startReply = (m: Msg) => { setMenuId(null); setReplyTo(m); setEditing(null) }

  // minutes = 0 unmutes. A timed mute wears off by itself server-side, which is
  // the difference between "quiet for this meeting" and accidentally going dark
  // on a channel for a month.
  const muteConversation = async (c: Conversation, minutes: number) => {
    setMuteFor(null)
    setConvos((cs) => cs.map((x) => (x.id === c.id ? { ...x, muted: minutes > 0 } : x)))
    try { await api.post(`/chat/conversations/${c.id}/prefs`, { mute_minutes: minutes }); loadConvos() }
    catch (e: any) { toast.error('Could not change mute: ' + e.message); loadConvos() }
  }

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

  // Every day the loaded thread actually contains, newest first, each pointing at
  // its first message. Built from what's on screen rather than asked of the
  // server: the thread loads whole (800 messages), so the index is already here.
  const dayIndex = useMemo(() => {
    const out: { key: string; iso: string; label: string; id: string; count: number }[] = []
    for (const m of messages) {
      if (m.deleted) continue
      const d = new Date(m.created_at)
      const key = d.toDateString()
      const hit = out.find((x) => x.key === key)
      if (hit) hit.count++
      else out.push({ key, iso: isoDay(d), label: dayLabel(m.created_at), id: m.id, count: 1 })
    }
    return out.reverse() // newest day first, which is the order people look for
  }, [messages])

  // Scroll to the first message of a day and flash it, so the jump is visible
  // rather than the thread just silently being somewhere else.
  const jumpToDay = (iso: string) => {
    setJumpOpen(false)
    let target = dayIndex.find((d) => d.iso === iso)
    if (!target) {
      // A date with no messages: land on the first day AFTER it, which is what
      // someone scrubbing for "around the 3rd" actually wants.
      const want = new Date(iso + 'T00:00:00').getTime()
      target = [...dayIndex].reverse().find((d) => new Date(d.key).getTime() >= want)
    }
    if (!target) { toast.info('No messages on or after that date'); return }
    if (inSearch) { setInSearch(''); setInSearchOpen(false) }
    const id = target.id
    requestAnimationFrame(() => scrollToMessage(id))
  }

  const runGlobalSearch = async (override?: string) => {
    const q = (override ?? search).trim()
    if (q.length < 2) return
    setHitsBusy(true)
    try { const d = await api.get(`/chat/search?q=${encodeURIComponent(q)}`); setHits(d.items) }
    catch (e: any) { toast.error('Search failed: ' + e.message) }
    finally { setHitsBusy(false) }
  }
  useEffect(() => { if (search.trim().length < 2) setHits(null) }, [search])

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
            <button className="btn btn-ghost btn-sm" onClick={() => setShowMentions(true)} title="Messages that mention me" aria-label="Messages that mention me"><Ic name="at" size={16} /></button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowStarred(true)} title="Starred messages" aria-label="Starred messages"><Ic name="star" size={16} /></button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowLater(true)} title="Reminders & scheduled messages" aria-label="Reminders and scheduled messages"><Ic name="clock" size={16} /></button>
            <button className="btn btn-primary btn-sm row" style={{ gap: 5 }} onClick={() => setShowNew(true)} title="New chat / group"><Ic name="plus" size={15} /> New</button>
          </div>
        </div>
        <input className="chat-contact-search" placeholder="Search chats…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {/* Your own status, spelled out rather than hidden behind an icon — an
            unlabelled smiley is the kind of control nobody ever finds. */}
        <button className="status-row" onClick={() => setShowStatus(true)}>
          <span className="status-dot-lg" data-dnd={myStatus.dnd_until && myStatus.dnd_until > new Date().toISOString() ? '1' : '0'} />
          <span className="status-row-text">
            {myStatus.dnd_until && myStatus.dnd_until > new Date().toISOString()
              ? 'Do not disturb'
              : (myStatus.status_text ? `${myStatus.status_emoji || ''} ${myStatus.status_text}`.trim() : 'Set a status')}
          </span>
          <Ic name="edit" size={12} />
        </button>
        {search.trim().length >= 2 && (
          <button className="search-all" onClick={() => runGlobalSearch()} disabled={hitsBusy}>
            <Ic name="search" size={13} /> {hitsBusy ? 'Searching…' : `Search all messages for "${search.trim()}"`}
          </button>
        )}
        {hits !== null ? (
          <div className="convo-list">
            <div className="ch-title" style={{ padding: '6px 4px' }}>{hits.length} message{hits.length === 1 ? '' : 's'}</div>
            {hits.length === 0 && <div className="empty" style={{ padding: 16, fontSize: 13 }}>Nothing found</div>}
            {hits.map((h) => (
              <button key={h.id} className="hit-row" onClick={() => { setHits(null); setSearch(''); openMessage(h.conversation_id, h.id) }}>
                <div className="hit-meta">{h.sender_name} · {h.conversation_name}</div>
                <div className="hit-body">{h.body || h.file?.name || ''}</div>
                <div className="hit-when">{dayLabel(h.created_at)} · {fmtTime(h.created_at)}</div>
              </button>
            ))}
          </div>
        ) : (
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
                      <button onClick={() => { setConvoMenu(null); if (c.muted) muteConversation(c, 0); else setMuteFor(c) }}>{c.muted ? 'Unmute' : 'Mute…'}</button>
                      <button className="danger" onClick={() => clearChat(c)}>Clear chat</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        )}
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
              <div className="chat-peer-who" style={{ cursor: active.type === 'group' ? 'pointer' : 'default' }} onClick={() => active.type === 'group' && setShowInfo(true)}>
                <div style={{ fontWeight: 600 }}>{active.name}</div>
                <div className="muted chat-peer-sub" style={{ fontSize: 12 }}>
                  {/* Whoever you are looking at, their load is right here. For a
                      group it is the sum, which is the number a manager actually
                      wants when deciding where the next job goes. */}
                  {active.type === 'direct'
                    ? <LoadChip load={workload[active.other_user_id || '']} />
                    : <LoadChip load={active.members.reduce((acc, mm) => {
                        const w = workload[mm.id]
                        return w ? { open: acc.open + w.open, overdue: acc.overdue + w.overdue } : acc
                      }, { open: 0, overdue: 0 })} />}
                  {typingName ? <span className="typing-text">{typingName} is typing…</span>
                    : active.type === 'group' ? active.members.map((m) => m.name.split(' ')[0]).join(', ')
                      : otherOnline ? <span className="online-text">online</span>
                        : (active.other_user_id && lastSeen[active.other_user_id]) ? <span>{lastSeenLabel(lastSeen[active.other_user_id])}</span>
                          : <span style={{ textTransform: 'capitalize' }}>{active.members.find((m) => m.id !== user!.id)?.role || ''}</span>}
                </div>
              </div>
              <div className="row chat-peer-actions" style={{ marginLeft: 'auto', gap: 4 }}>
                <button className="btn btn-ghost btn-sm" title="Audio call" aria-label="Start an audio call" onClick={() => startCall(active.id, 'audio', active.name)}>
                  <Ic name="phone" size={16} />
                </button>
                <button className="btn btn-ghost btn-sm" title="Video call" aria-label="Start a video call" onClick={() => startCall(active.id, 'video', active.name)}>
                  <Ic name="video" size={17} />
                </button>
                <div className="jump-wrap">
                  <button className="btn btn-ghost btn-sm" title="Jump to a date" aria-label="Jump to a date" onClick={(e) => { e.stopPropagation(); setJumpOpen((o) => !o) }}>
                    <Ic name="calendar" size={16} />
                  </button>
                  {jumpOpen && <JumpToDate days={dayIndex} onPick={jumpToDay} onClose={() => setJumpOpen(false)} />}
                </div>
                <button className="btn btn-ghost btn-sm" title="Search in chat" aria-label="Search in chat" onClick={() => setInSearchOpen((o) => !o)}>
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
                  </svg>
                </button>
                {active.type === 'group' && <button className="btn btn-ghost btn-sm" title="Group info" aria-label="Group info" onClick={() => setShowInfo(true)}>ⓘ</button>}
                <div className="msg-menu-wrap">
                  <button className="btn btn-ghost btn-sm" title="More" aria-label="More options" onClick={(e) => { e.stopPropagation(); setHeadMenu((o) => !o) }}>⋯</button>
                  {headMenu && (
                    <div className="msg-menu mine" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => { setHeadMenu(false); setShowFiles(true) }}>Shared files</button>
                      <button onClick={() => { setHeadMenu(false); setShowChannels(true) }}>Browse channels</button>
                      <button onClick={() => { setHeadMenu(false); printConversation() }}>Print conversation</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) })()}

          {active && pinned.length > 0 && (
            <div className="pin-bar">
              <button className="pin-bar-main" onClick={() => { if (pinned.length === 1) scrollToMessage(pinned[0].id); else setPinsOpen((o) => !o) }}>
                <Ic name="pin" size={13} />
                <span className="pin-bar-text">{pinned[0].body || pinned[0].file?.name || 'Pinned message'}</span>
                {pinned.length > 1 && <span className="pin-bar-count">+{pinned.length - 1}</span>}
              </button>
              <button className="btn btn-ghost btn-sm" title="Unpin" aria-label="Unpin" onClick={() => togglePin(pinned[0])}>✕</button>
            </div>
          )}
          {pinsOpen && pinned.length > 1 && (
            <div className="pin-list">
              {pinned.map((pm) => (
                <div key={pm.id} className="pin-row">
                  <button className="pin-row-main" onClick={() => { setPinsOpen(false); scrollToMessage(pm.id) }}>
                    <span className="pin-row-who">{senderName(pm.sender_id)}</span>
                    <span className="pin-row-text">{pm.body || pm.file?.name || ''}</span>
                  </button>
                  <button className="btn btn-ghost btn-sm" aria-label="Unpin" onClick={() => togglePin(pm)}>✕</button>
                </div>
              ))}
            </div>
          )}

          {inSearchOpen && (
            <div className="in-search">
              <input autoFocus placeholder="Search messages…" value={inSearch} onChange={(e) => setInSearch(e.target.value)} />
              <button className="btn btn-ghost btn-sm" aria-label="Close search" onClick={() => { setInSearch(''); setInSearchOpen(false) }}>✕</button>
            </div>
          )}

          <div className="chat-log" ref={logRef}>
            {/* The New chat button is offered whether or not there are existing
                chats. Gating it on an empty list meant the one screen with room
                for it lost the button the moment you had a single conversation,
                leaving this panel blank with nothing to act on. */}
            {!active && (
              <div style={{ margin: 'auto' }}>
                <EmptyState
                  icon={<Ic name="chat" size={40} />}
                  title={convos.length ? 'Select a conversation' : 'No conversations yet'}
                  hint={convos.length
                    ? 'Choose a chat from the list to read and reply to messages — or start a new one.'
                    : 'Start a new chat with a teammate or create a group to begin messaging.'}
                  action={<button className="btn btn-primary btn-sm row" style={{ gap: 5 }} onClick={() => setShowNew(true)}><Ic name="plus" size={15} /> New chat</button>}
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
              // A message that names me gets an accent stripe — in a busy group,
              // scrolling back for the one line that was actually aimed at you is
              // the whole reason mentions exist.
              const mentionsMe = !mine && ((m.mentions || []).some((x) => x.id === user!.id)
                || new RegExp(`@(${ALL_TOKENS.join('|')})\\b`, 'i').test(m.body || ''))
              // aggregate reactions by emoji
              const agg: Record<string, { count: number; mine: boolean }> = {}
              for (const rx of m.reactions || []) { (agg[rx.emoji] ||= { count: 0, mine: false }); agg[rx.emoji].count++; if (rx.user_id === user!.id) agg[rx.emoji].mine = true }
              return (
                <div key={m.id} data-msg={m.id} className={'msg-wrap' + (flashId === m.id ? ' flash' : '')} style={{ alignItems: m.call ? 'center' : mine ? 'flex-end' : 'flex-start' }}>
                  {m.call ? (
                    <div className="call-line">
                      <Ic name={m.call.kind === 'video' ? 'video' : 'phone'} size={14} />
                      <span>{m.body}</span>
                      <button className="call-line-back" onClick={() => startCall(active!.id, m.call!.kind, active!.name)}>Call back</button>
                    </div>
                  ) : (
                  <div className={'msg-line' + (mine ? ' mine' : '')}>
                    <div className="msg-body">
                      {showSender && <div className="msg-sender" style={{ color: senderColor(m.sender_id) }}>{senderName(m.sender_id)}</div>}
                      {m.deleted ? (
                        <div className="bubble deleted row" style={{ gap: 6 }}><Ic name="block" size={13} /> This message was deleted<span className="bubble-foot"><span className="bubble-time">{fmtTime(m.created_at)}</span></span></div>
                      ) : (
                        <div className={'bubble ' + (mine ? 'user' : 'ai') + (m.file ? ' file-bubble' : '') + (mentionsMe ? ' mentions-me' : '')}>
                          {m.forwarded && <div className="forwarded-tag row" style={{ gap: 5 }}><Ic name="forward" size={12} /> Forwarded</div>}
                          {m.reply && (
                            <div className="reply-quote"><span className="reply-quote-name">{m.reply.sender_id === user!.id ? 'You' : m.reply.sender_name}</span><span className="reply-quote-text">{m.reply.text}</span></div>
                          )}
                          {m.file && isAudio(m.file) && !m.uploading ? (
                            <div className="voice-note">
                              <VoicePlayer src={fileUrl(m)} id={m.id} mine={mine} />
                              {m.transcript
                                ? <div className="voice-text">{m.transcript}</div>
                                : (
                                  <button className="voice-transcribe" disabled={transcribing === m.id} onClick={() => transcribeNote(m)}>
                                    {transcribing === m.id ? <><span className="spinner" /> Transcribing…</> : <><Ic name="ai" size={12} /> Read it as text</>}
                                  </button>
                                )}
                            </div>
                          ) : m.file && (isImage && !m.uploading
                            ? <a href={fileUrl(m)} target="_blank" rel="noreferrer"><img className="chat-image" src={fileUrl(m)} alt={m.file.name} /></a>
                            : <div className="chat-file">
                                <span className="chat-file-icon">{m.uploading ? <Ic name="clock" size={18} /> : <Ic name="attach" size={18} />}</span>
                                <span className="chat-file-meta"><span className="chat-file-name">{m.file?.name}</span><span className="chat-file-size">{m.uploading ? 'Sending…' : fmtSize(m.file?.size)}</span></span>
                                {!m.uploading && <button className="chat-file-dl" title="Download" aria-label="Download" onClick={() => download(m)}><Ic name="download" size={14} /></button>}
                              </div>)}
                          {m.body && <MessageText body={m.body} mentions={m.mentions} meId={user!.id} fromMe={mine} />}
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
                        <button className="msg-tool-btn task-tool" title="Assign as task" aria-label="Assign as task" onClick={(e) => { e.stopPropagation(); toTask({ messageId: m.id }) }}><Ic name="taskAdd" size={16} /></button>
                        <div className="msg-menu-wrap">
                          <button className="msg-tool-btn" title="More" onClick={(e) => { e.stopPropagation(); setMenuId(menuId === m.id ? null : m.id); setReactFor(null) }}>⋯</button>
                          {menuId === m.id && (
                            <div className={'msg-menu' + (mine ? ' mine' : '')} onClick={(e) => e.stopPropagation()}>
                              <button onClick={() => { setMenuId(null); startReply(m) }}>Reply</button>
                              <button onClick={() => toTask({ messageId: m.id })}>Assign as task</button>
                              <button onClick={() => { setMenuId(null); setRemindFor(m) }}>Remind me</button>
                              <button onClick={() => togglePin(m)}>{m.pinned_at ? 'Unpin' : 'Pin to top'}</button>
                              {isManager && <button onClick={() => { setMenuId(null); setForkFrom(m) }}>Fork to new chat</button>}
                              <button onClick={() => markUnread(m)}>Mark unread</button>
                              <button onClick={() => { setMenuId(null); setForwardMsg(m) }}>Forward</button>
                              <button onClick={() => copyLink(m)}>Copy link</button>
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
                            <button className="react-more" title="More emoji" aria-label="More emoji" onClick={() => { setReactFor(null); setEmojiFor(m.id) }}>＋</button>
                          </div>
                        )}
                        {emojiFor === m.id && (
                          <EmojiPicker align={mine ? 'right' : 'left'} onClose={() => setEmojiFor(null)} onPick={(e) => { setEmojiFor(null); react(m, e) }} />
                        )}
                      </div>
                    )}
                  </div>
                  )}
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
                {slashQ !== null && slashOptions.length > 0 && (
                  <div className="mention-pop slash-pop" onMouseDown={(e) => e.preventDefault()}>
                    {slashOptions.map((c, i) => (
                      <button key={c.name} className={'mention-opt' + (i === slashIdx ? ' active' : '')} onMouseEnter={() => setSlashIdx(i)} onClick={() => pickSlash(c)}>
                        <span className="slash-name">/{c.name}{c.args ? ' ' + c.args : ''}</span>
                        <span className="slash-help">{c.help}</span>
                      </button>
                    ))}
                  </div>
                )}
                {mentionQ && mentionOptions.length > 0 && (
                  <div className="mention-pop" onMouseDown={(e) => e.preventDefault()}>
                    {mentionOptions.map((opt, i) => (
                      <button
                        key={opt.id}
                        className={'mention-opt' + (i === mentionIdx ? ' active' : '')}
                        onMouseEnter={() => setMentionIdx(i)}
                        onClick={() => applyMention(opt)}
                      >
                        {opt.id === '__all__'
                          ? <span className="mention-all"><Ic name="at" size={14} /></span>
                          : <Avatar name={opt.name} color={active.members.find((mm) => mm.id === opt.id)?.avatar_color} size={24} src={(() => { const mm = active.members.find((x) => x.id === opt.id); return mm?.avatar_file ? userAvatarUrl(mm.id, mm.avatar_file) : undefined })()} />}
                        <span className="mention-opt-name">{opt.name}</span>
                        {opt.id === '__all__'
                          ? <span className="muted" style={{ fontSize: 11.5 }}>Notify everyone here</span>
                          : <LoadChip load={workload[opt.id]} compact />}
                      </button>
                    ))}
                  </div>
                )}
                <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onPickFile} />
                <button className="btn btn-ghost attach-btn" title="Attach a file" aria-label="Attach a file" disabled={busy || !!editing} onClick={() => fileRef.current?.click()}>＋</button>
                {/* Turn what you're typing into a task without sending it first —
                    the common case is realising mid-sentence that this is work. */}
                <button className="btn btn-ghost task-btn" title="Create a task from this text" aria-label="Create a task from this text" disabled={busy || !input.trim()} onClick={draftFromComposer}><Ic name="taskAdd" size={18} /></button>
                <div className="emoji-wrap">
                  <button className="btn btn-ghost emoji-btn" title="Emoji" aria-label="Insert an emoji" disabled={busy} onClick={(e) => { e.stopPropagation(); setEmojiFor(emojiFor === '__composer__' ? null : '__composer__') }}>
                    <Ic name="smile" size={18} />
                  </button>
                  {emojiFor === '__composer__' && (
                    <EmojiPicker
                      onClose={() => setEmojiFor(null)}
                      onPick={(e) => {
                        // Insert at the caret, not at the end — people reach for
                        // the picker mid-sentence as often as at the finish.
                        const el = inputRef.current
                        const at = el?.selectionStart ?? input.length
                        const next = input.slice(0, at) + e + input.slice(at)
                        setInput(next)
                        rememberEmoji(e)
                        requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + e.length, at + e.length) })
                      }}
                    />
                  )}
                </div>
                {recording ? (
                  <div className="voice-recording">
                    <span className="voice-rec-dot" />
                    <span className="voice-rec-time">{Math.floor(recSecs / 60)}:{String(recSecs % 60).padStart(2, '0')}</span>
                    <span className="muted" style={{ fontSize: 12 }}>Recording…</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => finishVoiceNote(true)}>Cancel</button>
                    <button className="btn btn-primary btn-sm" onClick={() => finishVoiceNote(false)}>Send</button>
                  </div>
                ) : (
                <textarea
                  ref={inputRef}
                  className="composer-input"
                  data-va="chats.composer"
                  rows={1}
                  placeholder={editing ? 'Edit your message…' : (roomForHint ? 'Message…  @ to mention  ·  Shift+Enter for a new line' : 'Message…')}
                  value={input}
                  onChange={onComposerChange}
                  onKeyDown={onComposerKey}
                  onBlur={() => { sendTyping(false); setTimeout(() => setMentionQ(null), 120) }}
                  autoFocus
                />
                )}
                {/* Mic when there is nothing typed, Send once there is — the same
                    swap every messaging app makes, and it keeps the row one
                    button narrower on a phone. */}
                {!editing && !recording && !input.trim() && (
                  <button className="btn btn-ghost voice-btn" title="Record a voice note" aria-label="Record a voice note" disabled={busy} onClick={startVoiceNote}>
                    <Ic name="mic" size={18} />
                  </button>
                )}
                {!editing && !recording && input.trim() && (
                  <button className="btn btn-ghost sched-btn" title="Send later" aria-label="Send later" disabled={busy || !input.trim()} onClick={() => setScheduleOpen(true)}>
                    <Ic name="clock" size={17} />
                  </button>
                )}
                {!recording && <button data-va="chats.send" className="btn btn-primary" onClick={send} disabled={busy || !input.trim()}>{editing ? 'Save' : 'Send'}</button>}
              </div>
            </div>
          )}
        </div>
      </div>

      {showNew && <NewChatModal user={user!} convos={convos} onClose={() => setShowNew(false)} onOpen={(cid) => { setShowNew(false); setActiveId(cid); loadConvos() }} />}
      {showInfo && active && active.type === 'group' && <GroupInfo conv={active} user={user!} onClose={() => setShowInfo(false)} onChanged={() => { loadConvos(); loadThread(active.id) }} onLeft={() => { setShowInfo(false); setActiveId(''); loadConvos() }} />}
      {forwardMsg && <ForwardModal message={forwardMsg} convos={convos} onClose={() => setForwardMsg(null)} onDone={() => { setForwardMsg(null); loadConvos() }} />}
      {showStarred && <StarredModal onClose={() => setShowStarred(false)} onOpen={(cid, mid) => { setShowStarred(false); openMessage(cid, mid) }} />}
      {remindFor && <RemindModal message={remindFor} onClose={() => setRemindFor(null)} />}
      {showChannels && <ChannelsModal onClose={() => setShowChannels(false)} onOpen={(cid) => { setShowChannels(false); loadConvos(); setActiveId(cid) }} />}
      {showFiles && active && <FilesModal conv={active} onClose={() => setShowFiles(false)} onOpen={(mid) => { setShowFiles(false); scrollToMessage(mid) }} />}
      {forkFrom && active && (
        <ForkModal
          message={forkFrom}
          members={active.members}
          senderName={senderName(forkFrom.sender_id)}
          onClose={() => setForkFrom(null)}
          onDone={(cid) => { setForkFrom(null); loadConvos(); setActiveId(cid) }}
        />
      )}
      {showLater && <LaterModal onClose={() => setShowLater(false)} onOpen={(cid, mid) => { setShowLater(false); openMessage(cid, mid) }} />}
      {showStatus && <StatusModal current={myStatus} onClose={() => setShowStatus(false)} onSaved={setMyStatus} />}
      {muteFor && <MuteModal conv={muteFor} onClose={() => setMuteFor(null)} onPick={(mins) => muteConversation(muteFor, mins)} />}
      {scheduleOpen && active && (
        <ScheduleModal
          conversationId={active.id}
          body={input.trim()}
          mentions={resolveMentions(input.trim(), picked, active.members, user!.id)}
          onClose={() => setScheduleOpen(false)}
          onDone={() => { setScheduleOpen(false); setInput(''); setPicked([]) }}
        />
      )}
      {showMentions && <MentionsModal meId={user!.id} onClose={() => setShowMentions(false)} onOpen={(cid, mid) => { setShowMentions(false); openMessage(cid, mid) }} onTask={(mid) => { setShowMentions(false); toTask({ messageId: mid }) }} />}
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
function StarredModal({ onClose, onOpen }: { onClose: () => void; onOpen: (convId: string, messageId?: string) => void }) {
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
            <div key={m.id} className="starred-item" onClick={() => onOpen(m.conversation_id, m.id)}>
              <div className="starred-body row" style={{ gap: 6 }}>{m.file ? <><Ic name="attach" size={13} /> {m.file.name}</> : m.body}</div>
              <div className="muted" style={{ fontSize: 11 }}>{fmtTime(m.created_at)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------- browse + join public channels ----------
// The body is its own component because it appears in two places: as a tab under
// "New", and as the standalone drawer a slash command or deep link can open.
function ChannelList({ onOpen }: { onOpen: (convId: string) => void }) {
  const [items, setItems] = useState<any[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [q, setQ] = useState('')
  useEffect(() => { api.get('/chat/channels').then((d) => setItems(d.channels)).catch(() => {}).finally(() => setLoaded(true)) }, [])

  const join = async (id: string) => {
    setBusy(id)
    try { const c: any = await api.post(`/chat/channels/${id}/join`); onOpen(c.id) }
    catch (e: any) { toast.error(e.message); setBusy(null) }
  }
  const list = items.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))

  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Open to everyone in your workspace — join without an invitation.</div>
      <input className="chat-contact-search" placeholder="Search channels…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="modal-list">
        {loaded && list.length === 0 && (
          <div className="empty" style={{ padding: 20 }}>
            {items.length ? 'No channel matched' : 'No channels yet. A manager can make one from the Group tab.'}
          </div>
        )}
        {list.map((c) => (
          <div key={c.id} className="modal-user">
            <span className="avatar group-avatar" style={{ background: c.avatar_color, width: 34, height: 34 }}>#</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{c.name}</div>
              <div className="muted" style={{ fontSize: 11.5 }}>{c.member_count} member{c.member_count === 1 ? '' : 's'}</div>
            </div>
            {c.joined
              ? <button className="btn btn-ghost btn-sm" onClick={() => onOpen(c.id)}>Open</button>
              : <button className="btn btn-primary btn-sm" disabled={busy === c.id} onClick={() => join(c.id)}>Join</button>}
          </div>
        ))}
      </div>
    </>
  )
}

function ChannelsModal({ onClose, onOpen }: { onClose: () => void; onOpen: (convId: string) => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="hash" size={16} /> Channels</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <ChannelList onOpen={onOpen} />
      </div>
    </div>
  )
}

// ---------- everything shared in this conversation ----------
function FilesModal({ conv, onClose, onOpen }: { conv: Conversation; onClose: () => void; onOpen: (messageId: string) => void }) {
  const [items, setItems] = useState<any[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { api.get(`/chat/conversations/${conv.id}/media`).then((d) => setItems(d.items)).catch(() => {}).finally(() => setLoaded(true)) }, [conv.id])
  const images = items.filter((m) => (m.file?.type || '').startsWith('image/'))
  const rest = items.filter((m) => !(m.file?.type || '').startsWith('image/'))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="attach" size={16} /> Shared files</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="modal-list">
          {loaded && items.length === 0 && <div className="empty" style={{ padding: 20 }}>Nothing has been shared here yet</div>}
          {images.length > 0 && (
            <div className="files-grid">
              {images.map((m) => (
                <button key={m.id} className="files-thumb" onClick={() => onOpen(m.id)} title={m.file.name}>
                  <img src={fileUrl(m)} alt={m.file.name} loading="lazy" />
                </button>
              ))}
            </div>
          )}
          {rest.map((m) => (
            <div key={m.id} className="starred-item mention-row">
              <button style={{ flex: 1, minWidth: 0, textAlign: 'left', border: 0, background: 'transparent', cursor: 'pointer', padding: 0 }} onClick={() => onOpen(m.id)}>
                <div className="starred-body row" style={{ gap: 6 }}>
                  <Ic name={isAudio(m.file) ? 'mic' : 'file'} size={13} /> {m.file?.name}
                </div>
                <div className="muted" style={{ fontSize: 11 }}>{m.sender_name} · {fmtSize(m.file?.size)} · {dayLabel(m.created_at)}</div>
              </button>
              <a className="btn btn-ghost btn-sm" href={fileUrl(m, true)} download aria-label={`Download ${m.file?.name}`}><Ic name="download" size={14} /></a>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------- fork a message into its own thread ----------
// Cliq calls this forking. The useful part is not the new room, it is that the
// room OPENS with the message that caused it — so the people pulled in do not
// arrive at a blank screen asking what this is about.
function ForkModal({ message, members, senderName, onClose, onDone }: { message: Msg; members: Member[]; senderName: string; onClose: () => void; onDone: (convId: string) => void }) {
  const [name, setName] = useState((message.body || message.file?.name || 'Side thread').slice(0, 40))
  const [sel, setSel] = useState<Set<string>>(new Set(members.map((m) => m.id)))
  const [busy, setBusy] = useState(false)
  const toggle = (id: string) => setSel((x) => { const n = new Set(x); n.has(id) ? n.delete(id) : n.add(id); return n })

  const go = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      const conv: any = await api.post(`/chat/message/${message.id}/fork`, { name: name.trim(), memberIds: [...sel] })
      onDone(conv.id)
    } catch (e: any) { toast.error(e.message); setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="thread" size={16} /> Fork to a new chat</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="remind-quote"><b>{senderName}:</b> {message.body || message.file?.name}</div>
        <label style={{ fontSize: 12, fontWeight: 600 }}>Name this thread</label>
        <input className="chat-contact-search" style={{ marginBottom: 10 }} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <div className="spread row" style={{ marginBottom: 6 }}>
          <span className="ch-title">Who comes along</span>
          <span className="muted" style={{ fontSize: 11.5 }}>{sel.size} selected</span>
        </div>
        <div className="modal-list">
          {members.map((m) => (
            <div key={m.id} className="modal-user" onClick={() => toggle(m.id)}>
              <Avatar name={m.name} color={m.avatar_color} size={32} src={m.avatar_file ? userAvatarUrl(m.id, m.avatar_file) : undefined} />
              <div style={{ flex: 1, minWidth: 0 }}>{m.name}</div>
              <input type="checkbox" readOnly checked={sel.has(m.id)} />
            </div>
          ))}
        </div>
        <button className="btn btn-primary" style={{ width: '100%', marginTop: 10 }} disabled={busy || !name.trim() || sel.size === 0} onClick={go}>
          Create thread ({sel.size})
        </button>
      </div>
    </div>
  )
}

// ---------- Reminders + scheduled messages ----------
// One drawer for "things I set for later", because they are the same thought:
// something I chose not to deal with now.
function LaterModal({ onClose, onOpen }: { onClose: () => void; onOpen: (convId: string, messageId?: string) => void }) {
  const [tab, setTab] = useState<'reminders' | 'scheduled'>('reminders')
  const [reminders, setReminders] = useState<any[]>([])
  const [scheduled, setScheduled] = useState<any[]>([])
  const [loaded, setLoaded] = useState(false)
  const load = () => Promise.all([
    api.get('/chat/reminders').then((d) => setReminders(d.items)).catch(() => {}),
    api.get('/chat/scheduled').then((d) => setScheduled(d.items)).catch(() => {}),
  ]).finally(() => setLoaded(true))
  useEffect(() => { load() }, [])

  const when = (iso: string) => `${dayLabel(iso)} · ${fmtTime(iso)}`
  const drop = async (kind: 'reminders' | 'scheduled', id: string) => {
    try { await api.del(`/chat/${kind}/${id}`); load() } catch (e: any) { toast.error(e.message) }
  }
  const rowBtn: React.CSSProperties = { flex: 1, minWidth: 0, textAlign: 'left', border: 0, background: 'transparent', cursor: 'pointer', padding: 0 }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="clock" size={16} /> For later</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="modal-tabs">
          <button className={tab === 'reminders' ? 'active' : ''} onClick={() => setTab('reminders')}>Reminders ({reminders.length})</button>
          <button className={tab === 'scheduled' ? 'active' : ''} onClick={() => setTab('scheduled')}>Scheduled ({scheduled.length})</button>
        </div>
        <div className="modal-list">
          {tab === 'reminders' ? (
            <>
              {loaded && reminders.length === 0 && <div className="empty" style={{ padding: 20 }}>No reminders set</div>}
              {reminders.map((r) => (
                <div key={r.id} className="starred-item mention-row">
                  <button style={rowBtn} onClick={() => onOpen(r.conversation_id, r.message_id)}>
                    <div className="muted" style={{ fontSize: 11.5 }}>{when(r.remind_at)}</div>
                    <div className="starred-body">{r.preview || '(message)'}</div>
                  </button>
                  <button className="btn btn-ghost btn-sm danger" onClick={() => drop('reminders', r.id)} aria-label="Cancel reminder">✕</button>
                </div>
              ))}
            </>
          ) : (
            <>
              {loaded && scheduled.length === 0 && <div className="empty" style={{ padding: 20 }}>Nothing scheduled</div>}
              {scheduled.map((x) => (
                <div key={x.id} className="starred-item mention-row">
                  <button style={rowBtn} onClick={() => onOpen(x.conversation_id)}>
                    <div className="muted" style={{ fontSize: 11.5 }}>To {x.conversation_name} · {when(x.send_at)}</div>
                    <div className="starred-body">{x.body}</div>
                  </button>
                  <button className="btn btn-ghost btn-sm danger" onClick={() => drop('scheduled', x.id)} aria-label="Cancel scheduled message">✕</button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- custom status / do not disturb ----------
function StatusModal({ current, onClose, onSaved }: { current: any; onClose: () => void; onSaved: (s: any) => void }) {
  const [text, setText] = useState(current.status_text || '')
  const [emoji, setEmoji] = useState(current.status_emoji || '')
  const [busy, setBusy] = useState(false)
  const minutesLeft = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000))
  const dndOn = !!current.dnd_until && current.dnd_until > new Date().toISOString()

  const save = async (dndMinutes?: number) => {
    setBusy(true)
    try {
      const keep = dndOn ? minutesLeft(current.dnd_until) : 0
      const saved = await api.post('/chat/status', { status_text: text, status_emoji: emoji, dnd_minutes: dndMinutes === undefined ? keep : dndMinutes })
      onSaved(saved)
      onClose()
    } catch (e: any) { toast.error(e.message); setBusy(false) }
  }

  const PRESETS: [string, string][] = [
    ['💬', 'Available'], ['📅', 'In a meeting'], ['🍽️', 'At lunch'],
    ['🏠', 'Working from home'], ['✈️', 'Travelling'], ['🎯', 'Focusing'],
  ]
  const DND: [string, number][] = [['30 min', 30], ['1 hour', 60], ['4 hours', 240], ['Rest of day', 600]]

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 style={{ margin: 0, fontSize: 16 }}>Your status</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input className="chat-contact-search" style={{ width: 54, textAlign: 'center' }} value={emoji} maxLength={2} placeholder="🙂" onChange={(e) => setEmoji(e.target.value)} aria-label="Status emoji" />
          <input className="chat-contact-search" style={{ flex: 1 }} value={text} maxLength={80} placeholder="What are you up to?" onChange={(e) => setText(e.target.value)} aria-label="Status message" />
        </div>
        <div className="status-presets">
          {PRESETS.map(([e, t]) => (
            <button key={t} className="btn btn-sm" onClick={() => { setEmoji(e); setText(t) }}>{e} {t}</button>
          ))}
        </div>
        <div className="ch-title" style={{ marginTop: 14 }}>Do not disturb</div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          {dndOn
            ? `On for another ${minutesLeft(current.dnd_until)} min — every notification silenced, mentions included.`
            : 'Silences every notification, including mentions. Messages still arrive in the thread.'}
        </div>
        <div className="status-presets">
          {dndOn
            ? <button className="btn" disabled={busy} onClick={() => save(0)}>Turn DND off</button>
            : DND.map(([l, m]) => <button key={l} className="btn btn-sm" disabled={busy} onClick={() => save(m)}>{l}</button>)}
        </div>
        <button className="btn btn-primary" style={{ width: '100%', marginTop: 14 }} disabled={busy} onClick={() => save()}>Save status</button>
      </div>
    </div>
  )
}

// ---------- mute for a while ----------
function MuteModal({ conv, onClose, onPick }: { conv: Conversation; onClose: () => void; onPick: (minutes: number) => void }) {
  const OPTIONS: [string, number][] = [['1 hour', 60], ['8 hours', 480], ['1 day', 1440], ['1 week', 10080], ['Until I turn it back on', 525600]]
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 320 }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 style={{ margin: 0, fontSize: 16 }}>Mute {conv.name}</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>Messages still arrive — you just will not be notified.</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {OPTIONS.map(([label, mins]) => <button key={label} className="btn" onClick={() => onPick(mins)}>{label}</button>)}
        </div>
      </div>
    </div>
  )
}

// ---------- send this later ----------
function ScheduleModal({ conversationId, body, mentions, onClose, onDone }: { conversationId: string; body: string; mentions: string[]; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [custom, setCustom] = useState('')
  const send = async (at: Date, label: string) => {
    if (busy) return
    setBusy(true)
    try {
      await api.post(`/chat/conversations/${conversationId}/schedule`, { body, send_at: at.toISOString(), mentions })
      toast.success(`Scheduled for ${label}`)
      onDone()
    } catch (e: any) { toast.error(e.message); setBusy(false) }
  }
  const inMins = (m: number) => new Date(Date.now() + m * 60000)
  const tomorrow9 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d }
  const monday9 = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); return d }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="clock" size={16} /> Send later</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="remind-quote">{body}</div>
        <div className="remind-presets">
          <button className="btn" disabled={busy} onClick={() => send(inMins(60), 'in an hour')}>In 1 hour</button>
          <button className="btn" disabled={busy} onClick={() => send(tomorrow9(), 'tomorrow 9 am')}>Tomorrow, 9 am</button>
          <button className="btn" disabled={busy} onClick={() => send(monday9(), 'Monday 9 am')}>Monday, 9 am</button>
        </div>
        <label style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>Or pick a time</label>
        <div className="row" style={{ gap: 8 }}>
          <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} style={{ flex: 1 }} />
          <button className="btn btn-primary" disabled={busy || !custom} onClick={() => send(new Date(custom), 'then')}>Schedule</button>
        </div>
      </div>
    </div>
  )
}

// ---------- Remind me about this message ----------
// Relative presets first, because that is how people actually think about it
// ("in an hour", "tomorrow morning"), with an exact time underneath for the rest.
function RemindModal({ message, onClose }: { message: Msg; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [custom, setCustom] = useState('')

  const set = async (at: Date, label: string) => {
    if (busy) return
    setBusy(true)
    try {
      await api.post(`/chat/message/${message.id}/remind`, { remind_at: at.toISOString() })
      toast.success(`I'll remind you ${label}`)
      onClose()
    } catch (e: any) { toast.error('Could not set the reminder: ' + e.message); setBusy(false) }
  }

  const inMins = (m: number) => new Date(Date.now() + m * 60000)
  const tomorrowMorning = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d }
  const presets: [string, () => Date][] = [
    ['In 30 minutes', () => inMins(30)],
    ['In 1 hour', () => inMins(60)],
    ['In 3 hours', () => inMins(180)],
    ['Tomorrow, 9 am', tomorrowMorning],
  ]

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="clock" size={16} /> Remind me</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="remind-quote">{message.body || message.file?.name || 'this message'}</div>
        <div className="remind-presets">
          {presets.map(([label, make]) => (
            <button key={label} className="btn" disabled={busy} onClick={() => set(make(), label.toLowerCase())}>{label}</button>
          ))}
        </div>
        <label style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>Or pick a time</label>
        <div className="row" style={{ gap: 8 }}>
          <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} style={{ flex: 1 }} />
          <button className="btn btn-primary" disabled={busy || !custom} onClick={() => set(new Date(custom), 'then')}>Set</button>
        </div>
      </div>
    </div>
  )
}

// ---------- Jump to date ----------
// Cliq's date navigator: the days this conversation actually has, plus a free
// date picker for anything older. Listing the real days matters more than the
// picker — on a quiet thread most dates are empty, and a calendar that lets you
// choose sixty blank days is worse than a list of the nine that have messages.
function JumpToDate({ days, onPick, onClose }: { days: { iso: string; label: string; count: number }[]; onPick: (iso: string) => void; onClose: () => void }) {
  const [custom, setCustom] = useState('')
  return (
    <div className="jump-pop" onClick={(e) => e.stopPropagation()}>
      <div className="jump-head">
        <span>Jump to date</span>
        <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="jump-pick">
        <input
          type="date"
          value={custom}
          max={isoDay(new Date())}
          onChange={(e) => { setCustom(e.target.value); if (e.target.value) onPick(e.target.value) }}
          aria-label="Pick a date"
        />
      </div>
      <div className="jump-list">
        {days.length === 0 && <div className="empty" style={{ padding: 14, fontSize: 12.5 }}>No messages yet</div>}
        {days.map((d) => (
          <button key={d.iso} className="jump-day" onClick={() => onPick(d.iso)}>
            <span>{d.label}</span>
            <span className="jump-count">{d.count}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------- @ Mentions inbox ----------
// Every message that named me, newest first. A mention in a group that moves fast
// is otherwise indistinguishable from the rest of the unread count.
function MentionsModal({ meId, onClose, onOpen, onTask }: { meId: string; onClose: () => void; onOpen: (convId: string, messageId?: string) => void; onTask: (messageId: string) => void }) {
  const [items, setItems] = useState<(Msg & { sender_name: string; conversation_name: string })[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { api.get('/chat/mentions').then((d) => setItems(d.items)).catch(() => {}).finally(() => setLoaded(true)) }, [])
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="at" size={16} /> Mentions</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="modal-list">
          {loaded && items.length === 0 && <div className="empty" style={{ padding: 20 }}>No one has mentioned you yet</div>}
          {items.map((m) => (
            <div key={m.id} className="starred-item mention-row">
              <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => onOpen(m.conversation_id, m.id)}>
                <div className="muted" style={{ fontSize: 11.5, marginBottom: 2 }}>{m.sender_name} · {m.conversation_name}</div>
                <div className="starred-body row" style={{ gap: 6 }}>
                  {m.file ? <><Ic name="attach" size={13} /> {m.file.name}</> : <MessageText body={m.body} mentions={m.mentions} meId={meId} fromMe={false} />}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" title="Assign as task" aria-label="Assign as task" onClick={() => onTask(m.id)}><Ic name="taskAdd" size={15} /></button>
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
  const [mode, setMode] = useState<'pick' | 'group' | 'channels'>('pick')
  const [q, setQ] = useState('')
  const [groupName, setGroupName] = useState('')
  const [isPublic, setIsPublic] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  // Mirrors the check on POST /chat/conversations. Employees still see the tab —
  // hiding it entirely just makes people ask where groups come from — but it
  // explains who to ask instead of failing at the Create button.
  const canCreateGroup = user.role === 'manager' || user.role === 'admin'
  useEffect(() => { api.get('/chat/users').then((d) => setUsers(d.users)).catch(() => {}) }, [])
  const list = users.filter((u) => u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const startDirect = async (uid: string) => {
    setBusy(true)
    try { const c = await api.post('/chat/conversations', { type: 'direct', userId: uid }); onOpen(c.id) } catch (e: any) { toast.error(e.message); setBusy(false) }
  }
  const createGroup = async () => {
    // A public channel may open empty — anyone can walk in. A private one needs
    // at least one other person or it is a note to self.
    if (!groupName.trim() || (sel.size === 0 && !isPublic)) return
    setBusy(true)
    try { const c = await api.post('/chat/conversations', { type: 'group', name: groupName.trim(), memberIds: [...sel], visibility: isPublic ? 'public' : 'private' }); onOpen(c.id) } catch (e: any) { toast.error(e.message); setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 style={{ margin: 0, fontSize: 16 }}>{mode === 'pick' ? 'New chat' : mode === 'group' ? 'New group' : 'Channels'}</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>
        <div className="modal-tabs">
          <button className={mode === 'pick' ? 'active' : ''} onClick={() => setMode('pick')}>Direct</button>
          <button className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')}>Group</button>
          <button className={mode === 'channels' ? 'active' : ''} onClick={() => setMode('channels')}>Channels</button>
        </div>
        {mode === 'channels' && <ChannelList onOpen={onOpen} />}
        {mode === 'group' && !canCreateGroup && (
          <div className="notice-inline row" style={{ gap: 7 }}><Ic name="lock" size={14} /> Only managers can create groups. Ask your manager to set one up and add you.</div>
        )}
        {mode === 'group' && canCreateGroup && (
          <>
            <input className="chat-contact-search" style={{ marginBottom: 8 }} placeholder="Group name…" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
            <div className="vis-pick">
              <button className={!isPublic ? 'active' : ''} onClick={() => setIsPublic(false)}>
                <Ic name="lock" size={13} /> Private
                <span>Invite only</span>
              </button>
              <button className={isPublic ? 'active' : ''} onClick={() => setIsPublic(true)}>
                <Ic name="hash" size={13} /> Channel
                <span>Anyone can join</span>
              </button>
            </div>
          </>
        )}
        {mode !== 'channels' && (mode === 'pick' || canCreateGroup) && <input className="chat-contact-search" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} />}
        <div className="modal-list">
          {mode === 'channels' || (mode === 'group' && !canCreateGroup) ? null : list.map((u) => (
            <div key={u.id} className="modal-user" onClick={() => mode === 'pick' ? startDirect(u.id) : toggle(u.id)}>
              <Avatar name={u.name} color={u.avatar_color} size={34} src={u.avatar_file ? userAvatarUrl(u.id, u.avatar_file) : undefined} />
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{u.name}</div><div className="muted" style={{ fontSize: 11.5, textTransform: 'capitalize' }}>{u.role}</div></div>
              {mode === 'group' && <input type="checkbox" readOnly checked={sel.has(u.id)} />}
            </div>
          ))}
          {mode !== 'channels' && list.length === 0 && (mode === 'pick' || canCreateGroup) && <div className="empty" style={{ padding: 16 }}>No people found</div>}
        </div>
        {mode === 'group' && canCreateGroup && (
          <button className="btn btn-primary" style={{ width: '100%', marginTop: 10 }} disabled={busy || !groupName.trim() || (sel.size === 0 && !isPublic)} onClick={createGroup}>
            {isPublic ? `Create channel${sel.size ? ` (${sel.size})` : ''}` : `Create group (${sel.size})`}
          </button>
        )}
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

  const toggleVisibility = async () => {
    const next = conv.visibility === 'public' ? 'private' : 'public'
    if (next === 'public' && !(await confirmDialog({
      title: 'Open this to everyone?',
      message: `Anyone in the workspace will be able to find "${conv.name}" and read everything in it, including what was said before they joined.`,
      confirmText: 'Open it',
    }))) return
    try { await api.post(`/chat/conversations/${conv.id}/visibility`, { visibility: next }); onChanged() }
    catch (e: any) { toast.error(e.message) }
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
        {isAdmin && (
          <div className="vis-row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>{conv.visibility === 'public' ? 'Open channel' : 'Private group'}</div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                {conv.visibility === 'public' ? 'Anyone in the workspace can find and join this.' : 'Only people added here can see it.'}
              </div>
            </div>
            <button className="btn btn-sm" onClick={toggleVisibility}>{conv.visibility === 'public' ? 'Make private' : 'Open to everyone'}</button>
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
