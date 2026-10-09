import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom'
import { api, getToken, userAvatarUrl, groupAvatarUrl, API_BASE, wsUrl } from '../api'
import { useAuth } from '../auth'
import { Avatar, EmptyState, Ic } from '../ui'
import { pushBackHandler } from '../back'
import { toast } from '../lib/toast'
import { confirmDialog } from '../lib/confirm'
import { useDialog } from '../lib/useDialog'
import { clipboardFiles, droppedFiles, dragHasFiles, canReadClipboardImages, readClipboardImages } from '../lib/pasteFiles'
import { stashTaskDraft } from '../lib/taskDraft'
import { startCall } from '../lib/call'
import EmojiPicker, { rememberEmoji } from '../components/EmojiPicker'
import VoicePlayer from '../components/VoicePlayer'
import { audioFilename } from '../lib/audioFile'
import { startLiveSpeech, isSupported as speechSupported, LiveSpeech } from '../lib/liveSpeech'
import { useSurface } from '../voice/uiRegistry'
import { typeInto, flashPress, pause, settle, findVaEl } from '../voice/uiController'

// `role` is the person's role in this chat (admin / member); `job_role` is who
// they are in the workspace (manager / employee), which is what a contact's
// subtitle should say.
interface Member { id: string; name: string; avatar_color?: string; avatar_file?: string | null; role: string; job_role?: string; status_text?: string; status_emoji?: string; dnd_until?: string | null }
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
  pinned_at?: string | null; call?: CallInfo | null; transcript?: string | null; meeting?: MeetingCard | null
}
// A finished call leaves a line in the thread instead of a chat bubble.
interface CallInfo { id: string; kind: 'audio' | 'video'; status: string; started_by: string; duration_sec: number; joined: number }
// The audit a transcribed call leaves behind, shown where the call happened.
interface MeetingCard { id: string; title: string; summary: string; engine?: string; tasks: number; decisions: number; risks: number; blockers: number }
interface OrgUser { id: string; name: string; email: string; role: string; avatar_color?: string; avatar_file?: string | null }

const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏']
const MAX_FILE = 15 * 1024 * 1024

// ---- selecting a message on a touch screen (see selectMessage) ----
// How long a finger has to stay put for a press to become a long-press. Under
// half a second, like the platforms' own (Android's is 400ms).
const LONG_PRESS_MS = 420
// Room the floating reactions need inside the thread: the 52px tray, its 6px
// gap, and the 3px the selected row's tint reaches past the message.
const TRAY_ROOM = 62
// What inside a bubble keeps its own taps (TAP_SKIP) and its own presses
// (PRESS_SKIP). Links, images, the voice player and buttons open or play on a
// tap, but a long-press on any of them still selects the message, as in
// WhatsApp — the player row alone is a third of a voice note's bubble. Only
// fields (and native media controls) keep their presses.
const PRESS_SKIP = 'audio, video, input, textarea'
const TAP_SKIP = 'a, button, .vp, ' + PRESS_SKIP
// menuId's value while the action bar's own ⋮ menu is open (not a message id).
const SEL_MENU = '__selection__'
// One action a message offers — shared by the desktop menu and the phone bar.
interface MsgAction { key: string; label: string; icon?: React.ComponentProps<typeof Ic>['name']; bar?: boolean; on?: boolean; danger?: boolean; run: () => void }
// A file waiting above the composer for Send; `url` is a preview for pictures.
interface StagedFile { id: string; file: File; url: string | null }
// How many files can wait for one Send.
const MAX_STAGED = 10
// There is no copy glyph in the shared icon set; this matches its line style.
function CopyGlyph({ size = 19 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  )
}
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
// It names what it counts ("open tasks", "overdue"): the bare "107 open · 104
// late" it used to show under a group's name read as a riddle, not a workload.
// Given onClick it is a button that opens the explanation (see LoadPop).
function LoadChip({ load, compact, onClick }: { load?: { open: number; overdue: number }; compact?: boolean; onClick?: (e: React.MouseEvent) => void }) {
  if (!load || !load.open) return null
  const late = load.overdue > 0
  const tasks = `${load.open} open task${load.open === 1 ? '' : 's'}`
  const title = `${tasks}${late ? `, ${load.overdue} overdue` : ''}`
  const body = (
    <>
      {late ? <Ic name="warning" size={10} /> : <Ic name="check" size={10} />}
      <span className="load-chip-text">
        {compact
          ? `${load.open} open${late ? ` · ${load.overdue} late` : ''}`
          : `${tasks}${late ? ` · ${load.overdue} overdue` : ''}`}
      </span>
    </>
  )
  const cls = 'load-chip' + (late ? ' late' : '')
  return onClick
    ? <button type="button" className={cls + ' load-chip-btn'} title={title} aria-label={`${title}. What does this mean?`} onClick={onClick}>{body}</button>
    : <span className={cls} title={title}>{body}</span>
}

// Tapping the chip says what the numbers are, in a sentence, and (for managers,
// who can open anyone's list) offers the tasks behind them.
function LoadPop({ name, load, canOpen, onOpen }: { name: string; load: { open: number; overdue: number }; canOpen: boolean; onOpen: () => void }) {
  const first = name.split(' ')[0]
  const tasks = `${load.open} open task${load.open === 1 ? '' : 's'}`
  return (
    <div className="load-pop" role="dialog" aria-label={`${first}'s workload`} onClick={(e) => e.stopPropagation()}>
      <div className="load-pop-title"><Ic name="check" size={14} /> {first}'s workload</div>
      <p>
        {first} has <b>{tasks}</b> in VoTask{load.overdue > 0
          ? <>, and <b>{load.overdue} {load.overdue === 1 ? 'is' : 'are'} past the due date</b>.</>
          : '. None are overdue.'}
      </p>
      <p className="muted">Shown here so you can see what someone is already carrying before you hand them more.</p>
      {canOpen && <button className="btn btn-sm" onClick={onOpen}>View {first}'s tasks</button>}
    </div>
  )
}

// The list's three views. "Personal" is the one-to-one chats (type 'direct').
type ListTab = 'all' | 'group' | 'direct'
const LIST_TABS: { id: ListTab; label: string; empty: string }[] = [
  { id: 'all', label: 'All', empty: 'No chats yet' },
  { id: 'group', label: 'Groups', empty: 'No group chats yet' },
  { id: 'direct', label: 'Personal', empty: 'No personal chats yet' },
]
const LIST_TAB_KEY = 'chatsListTab'

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
  const loc = useLocation()
  // The open chat (and whether its info panel is open) as the current history
  // entry records it (see the history effects below). Read first so a Back into
  // Chats lands on the chat it left.
  const navState = loc.state as { chat?: string; info?: boolean; pushed?: boolean } | null
  const navChat = navState?.chat || ''
  const navInfo = !!navChat && !!navState?.info
  // Whether this page pushed the chat's entry onto a /chats list entry (see the
  // history effects): then closing the chat can step Back instead of replacing.
  const navPushed = !!navChat && !!navState?.pushed
  const [convos, setConvos] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState(navChat)
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
  // Starts open when the entry being shown is an info entry (a reload with the
  // panel up, Back from a page opened from it).
  const [showInfo, setShowInfo] = useState(navInfo)
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
  // Files waiting to go with the next Send — pasted (Ctrl+V, or a phone's
  // clipboard), dropped on the thread, or picked with the clip — shown above the
  // box with a preview first, as WhatsApp does before it sends a picture; the
  // text in the box goes with them as the caption. A screenshot pasted by
  // accident is one ✕ away rather than already in front of the whole team.
  const [staged, setStaged] = useState<StagedFile[]>([])
  const stagedRef = useRef<StagedFile[]>([])
  stagedRef.current = staged
  const [dropping, setDropping] = useState(false)
  const dragDepthRef = useRef(0)
  const [attachMenu, setAttachMenu] = useState(false)
  // Press-and-hold on Send opens "Send later", as in Telegram. It is the only way
  // to it on a phone under 400px, where the clock button gives its room to the
  // text. `heldRef` swallows the click that ends the hold, so it doesn't send.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heldRef = useRef(false)
  const endHold = () => { if (holdTimerRef.current) clearTimeout(holdTimerRef.current); holdTimerRef.current = null }
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
  // Which page of the info panel is showing: its main page, "Media, links and
  // docs", or Add members. Kept here rather than in the panel so that Back can
  // step from a sub-page to the main page (the history effects).
  const [infoView, setInfoView] = useState<InfoView>('main')
  const [headMenu, setHeadMenu] = useState(false)
  const [loadOpen, setLoadOpen] = useState(false)
  // WhatsApp's long-press, for touch screens (which have no hover to show the
  // desktop's per-message tools): a tap or a long-press on a bubble selects the
  // message. The selected message is highlighted, the six quick reactions float
  // over it, and the thread header turns into its action bar (reply, task, star,
  // copy, forward, delete, ⋮). One more tap reacts. `trayPlace` is where the
  // reactions fit: above the message, below it, or over its top edge when it is
  // too tall to have room on either side.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [trayPlace, setTrayPlace] = useState<'above' | 'below' | 'inside'>('above')
  // For 'inside' (a message taller than the room left around it): how far down
  // the message the tray sits, so it lands on the part that is on screen.
  const [trayTop, setTrayTop] = useState(8)
  // Touch screen or mouse, by the same test the stylesheet uses for the hover
  // tools — the two must agree, or a phone would get neither the hover row nor
  // the selection.
  const [touchUI, setTouchUI] = useState(() => typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(hover: none)')
    const sync = () => setTouchUI(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  // The press being timed for a long-press, and whether one just fired — the
  // click that ends a long-press must not toggle the selection straight back off.
  const pressRef = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const longPressedRef = useRef(false)
  // The message whose "who reacted" sheet is open.
  const [reactionsOf, setReactionsOf] = useState<string | null>(null)
  const [listTab, setListTab] = useState<ListTab>(() => {
    try { const v = localStorage.getItem(LIST_TAB_KEY); return v === 'group' || v === 'direct' ? v : 'all' } catch { return 'all' }
  })
  useEffect(() => { try { localStorage.setItem(LIST_TAB_KEY, listTab) } catch { /* private mode: just not remembered */ } }, [listTab])
  const [slashQ, setSlashQ] = useState<string | null>(null)
  const [slashIdx, setSlashIdx] = useState(0)
  const [forkFrom, setForkFrom] = useState<Msg | null>(null)
  const [recording, setRecording] = useState(false)
  const [recSecs, setRecSecs] = useState(0)
  const [transcribing, setTranscribing] = useState<string | null>(null)
  const [summarising, setSummarising] = useState<string | null>(null)
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

  // Opening a chat is a step Back should undo, as in WhatsApp: Back from a thread
  // (browser, phone gesture, Android button) lands on the chat list, not on
  // whatever page came before Chats. So an opened chat gets its own history
  // entry, carrying the chat in the entry's state. State, not a query param: the
  // ?c= and ?with= handlers below wipe the query string, and a shared /chats link
  // must never open a chat by itself.
  //
  // Opening from the list pushes; switching straight to another chat (the
  // desktop list sits beside the thread) replaces, so Back is one step to the
  // list however many chats were visited. Closing with the in-app arrow goes
  // Back through the entry it pushed rather than adding a "list" entry on top,
  // or the next Back would land on a second copy of the same list.
  //
  // The info panel is one more step on top, as WhatsApp's Group info is: Back
  // from it lands on the chat, not the list. Closing it in the app goes Back
  // through its entry; leaving the chat from inside it (Exit group) goes Back
  // through both in one move. Moving to another chat from it (Message someone)
  // replaces the panel's entry, so Back from that chat returns to this one.
  //
  // What lies under an entry is recorded IN the entry ({chat, pushed}), not in
  // this page's memory: Chats unmounts on every trip to another page and on a
  // reload, and a ref forgot that the list was under the chat — closing then
  // replaced the entry instead of stepping Back through it, and the next Back
  // did nothing. An info entry is only ever pushed straight onto its chat's
  // entry, so closing one is always one step Back.
  const navRef = useRef({ chat: navChat, info: navInfo, pushed: navPushed })
  navRef.current = { chat: navChat, info: navInfo, pushed: navPushed }
  const wantInfo = !!activeId && showInfo
  useEffect(() => {
    // A move to another page is under way (View tasks, Assign as task…): this
    // page is about to unmount and that page owns history now. Writing here
    // would pop the very entry the move just pushed.
    if (window.location.pathname !== loc.pathname) return
    const cur = navRef.current
    const path = loc.pathname
    if (cur.chat === activeId && cur.info === wantInfo) return
    if (cur.chat === activeId) {
      if (wantInfo) navigate(path, { state: { chat: activeId, info: true, pushed: cur.pushed } })
      else navigate(-1)
      return
    }
    if (activeId && !cur.chat) { navigate(path, { state: { chat: activeId, pushed: true } }); return }
    if (activeId) { navigate(path, { state: { chat: activeId, pushed: cur.pushed }, replace: true }); return }
    // Leaving the chat: Back through what this page put there when the list is
    // underneath it; otherwise just say "no chat".
    if (cur.pushed) navigate(cur.info ? -2 : -1)
    else navigate(path, { state: null, replace: true })
  }, [activeId, wantInfo])
  // ...and Back / Forward moving through those entries moves the chat (and the
  // panel) with them — after two smaller steps that Back takes first, the way
  // the panel's arrow and Android's back button already do: a sub-page of the
  // panel (Media, Add) goes back to its main page, and a selected message (touch)
  // is let go while the chat stays. Neither has an entry of its own (a tap
  // selects, often by accident), so the entry Back just took is put back.
  const navType = useNavigationType()
  const showInfoRef = useRef(showInfo)
  showInfoRef.current = showInfo
  const infoViewRef = useRef(infoView)
  infoViewRef.current = infoView
  const selRef = useRef(selectedId)
  selRef.current = selectedId
  useEffect(() => {
    const was = activeIdRef.current
    if (navType === 'POP' && was) {
      if (!navInfo && showInfoRef.current && navChat === was && infoViewRef.current !== 'main') {
        setInfoView('main')
        navigate(loc.pathname, { state: { chat: was, info: true, pushed: navPushed } })
        return
      }
      if (selRef.current && navChat !== was && !showInfoRef.current) {
        setSelectedId(null); setEmojiFor(null)
        navigate(loc.pathname, { state: { chat: was, pushed: true } })
        return
      }
    }
    if (navChat !== activeIdRef.current) setActiveId(navChat)
    if (navInfo !== showInfoRef.current) { if (navInfo) setInfoView('main'); setShowInfo(navInfo) }
  }, [navChat, navInfo])

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
  // links, the pinned bar and the info panel's "Show in chat" — all of them mean
  // "show me that line". Says whether the line was there to show: the thread
  // loads only part of a long chat, and the info panel lists all of it.
  const scrollToMessage = (id: string): boolean => {
    const el = logRef.current?.querySelector(`[data-msg="${id}"]`) as HTMLElement | null
    if (!el) return false
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlashId(id)
    setTimeout(() => setFlashId((f) => (f === id ? null : f)), 1800)
    return true
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
  useEffect(() => {
    setLoadOpen(false); setSelectedId(null); setReactionsOf(null); setHeadMenu(false); setJumpOpen(false); setAttachMenu(false)
    // Files staged for one chat do not follow you into the next.
    if (stagedRef.current.length) { stagedRef.current.forEach((s) => s.url && URL.revokeObjectURL(s.url)); setStaged([]) }
    if (activeId) {
      loadThread(activeId); loadPins(activeId); setReplyTo(null); setEditing(null); setInSearch(''); setInSearchOpen(false); setPinsOpen(false)
      // A switch closes the info panel — unless the entry being shown is this
      // chat's own info entry (a reload with it open, Back or Forward onto it).
      if (!(navRef.current.chat === activeId && navRef.current.info)) setShowInfo(false)
    } else setPinned([])
  }, [activeId])
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
  useEffect(() => { const h = () => { setMenuId(null); setReactFor(null); setConvoMenu(null); setJumpOpen(false); setEmojiFor(null); setHeadMenu(false); setLoadOpen(false); setSelectedId(null); setAttachMenu(false) }; document.addEventListener('click', h); return () => document.removeEventListener('click', h) }, [])

  // An open thread is a full-screen surface on a phone: the app's top bar (title,
  // bell, profile) and the bottom tab bar both stand down, and the thread covers
  // the screen edge to edge. Measured at 430px the tab bar sat over the composer,
  // and the top bar cost 70px of a thread that already had its own header. The
  // flag goes on <body>, not on this page's root, because both are rendered by
  // Layout in App.tsx — outside this component. The mobile block in styles.css is what acts on it; on desktop it
  // means nothing. Keyed on the chat actually being on screen, not just on
  // activeId: a chat restored from history that no longer exists must leave the
  // list (and the way out) visible.
  const threadOpen = !!active
  useEffect(() => {
    document.body.classList.toggle('chat-thread-open', threadOpen)
    return () => document.body.classList.remove('chat-thread-open')
  }, [threadOpen])
  // Chats is the one page that wants the whole width of a big screen: the list
  // and the thread side by side read better wide than capped at 1240px.
  useEffect(() => {
    document.body.classList.add('chats-page')
    return () => document.body.classList.remove('chats-page')
  }, [])

  // The placeholder says as much as fits on one line. The composer box gets
  // ~250px on a 430px phone, where "@ to mention" fits and the Shift+Enter tip
  // (no use on a phone keyboard anyway) does not; below 400px only "Message…"
  // does. The full hint needs ~360px of box, which only a 1280px window leaves
  // once the sidebar and the chat list have theirs.
  const hintFor = () => typeof window === 'undefined' || window.matchMedia('(min-width: 1280px)').matches ? 2
    : window.matchMedia('(min-width: 400px)').matches ? 1 : 0
  const [hintLevel, setHintLevel] = useState(hintFor)
  useEffect(() => {
    const mqs = [window.matchMedia('(min-width: 1280px)'), window.matchMedia('(min-width: 400px)')]
    const sync = () => setHintLevel(hintFor())
    sync()
    mqs.forEach((mq) => mq.addEventListener('change', sync))
    return () => mqs.forEach((mq) => mq.removeEventListener('change', sync))
  }, [])
  const placeholder = ['Message…', 'Message…  @ to mention', 'Message…  @ to mention  ·  Shift+Enter for a new line'][hintLevel]

  // Android back button: close the top-most open layer (menu → modal → search →
  // conversation list) instead of leaving Chats / quitting the app.
  useEffect(() => pushBackHandler(() => {
    if (emojiFor) { setEmojiFor(null); return true }
    if (attachMenu) { setAttachMenu(false); return true }
    if (recording) { finishVoiceNote(true); return true }
    if (mentionQ) { setMentionQ(null); return true }
    if (reactionsOf) { setReactionsOf(null); return true }
    if (menuId || reactFor || convoMenu || headMenu || jumpOpen || loadOpen) { setMenuId(null); setReactFor(null); setConvoMenu(null); setHeadMenu(false); setJumpOpen(false); setLoadOpen(false); return true }
    if (selectedId) { setSelectedId(null); return true }
    if (forwardMsg) { setForwardMsg(null); return true }
    if (showMentions) { setShowMentions(false); return true }
    if (showStarred) { setShowStarred(false); return true }
    if (showInfo) { setShowInfo(false); return true }
    if (showNew) { setShowNew(false); return true }
    if (inSearchOpen) { setInSearchOpen(false); setInSearch(''); return true }
    if (activeId) { setActiveId(''); return true } // open chat → back to the list
    return false
  }), [emojiFor, attachMenu, recording, mentionQ, reactionsOf, menuId, reactFor, convoMenu, headMenu, jumpOpen, loadOpen, selectedId, forwardMsg, showMentions, showStarred, showInfo, showNew, inSearchOpen, activeId])

  // Escape closes the top-most of this page's own popups — a menu or picker,
  // then the selected message — one layer per press. Dialogs, the emoji picker
  // and the composer's pickers handle Escape themselves, so they are left to it.
  // Focus that was inside a closing menu goes back to the button that opened it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || emojiFor || reactionsOf || showInfo) return
      if (document.querySelector('.confirm-center, .modal-overlay')) return
      if (attachMenu) { setAttachMenu(false); inputRef.current?.focus(); return }
      if (menuId || reactFor || convoMenu || headMenu || jumpOpen || loadOpen) {
        const inPopup = (document.activeElement as HTMLElement | null)?.closest('.msg-menu-wrap, .msg-tools, .convo-menu-wrap')
        setMenuId(null); setReactFor(null); setConvoMenu(null); setHeadMenu(false); setJumpOpen(false); setLoadOpen(false)
        inPopup?.querySelector<HTMLElement>('button')?.focus()
        return
      }
      if (selectedId) setSelectedId(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [emojiFor, attachMenu, reactionsOf, showInfo, menuId, reactFor, convoMenu, headMenu, jumpOpen, loadOpen, selectedId])
  // When a selection ends with focus nowhere (the bar or tray button that had it
  // went away with the selection), hand focus back to the message itself rather
  // than to the top of the page. After the frame, so an action that moves focus
  // on purpose (Reply → the composer) has already done so.
  const lastSelRef = useRef<string | null>(null)
  useEffect(() => {
    const was = lastSelRef.current
    lastSelRef.current = selectedId
    if (!was || selectedId) return
    // The tray's full emoji picker belongs to the selection: it closes with it,
    // or it would still react to a message no longer selected.
    setEmojiFor((f) => (f === was ? null : f))
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return
      // An action opened a dialog (Forward, Remind me, Fork): focus is its.
      if (document.querySelector('.confirm-center, .modal-overlay, .modal-center')) return
      logRef.current?.querySelector<HTMLElement>(`[data-msg="${was}"] .bubble`)?.focus({ preventScroll: true })
    })
  }, [selectedId])

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

  // ---- files: pasted, dropped or picked ----------------------------------
  // Into the tray above the box, never straight to the room (see `staged`).
  const stageFiles = (files: File[]) => {
    if (!files.length || !activeIdRef.current) return
    if (editing) { toast.info('Finish editing the message first'); return }
    const tooBig = files.filter((f) => f.size > MAX_FILE)
    if (tooBig.length) toast.error(tooBig.length === 1 ? `"${tooBig[0].name}" is over 15 MB, too big to send` : `${tooBig.length} files are over 15 MB, too big to send`)
    let ok = files.filter((f) => f.size > 0 && f.size <= MAX_FILE)
    const room = MAX_STAGED - stagedRef.current.length
    if (ok.length > room) { toast.info(`Up to ${MAX_STAGED} files at a time`); ok = ok.slice(0, Math.max(0, room)) }
    if (!ok.length) return
    setStaged((cur) => [...cur, ...ok.map((file) => ({
      id: Math.random().toString(36).slice(2), file,
      url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    }))])
    setAttachMenu(false)
    // Straight back to the box, where the caption goes.
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  const unstage = (id: string) => {
    const gone = stagedRef.current.find((s) => s.id === id)
    if (gone?.url) URL.revokeObjectURL(gone.url)
    setStaged((cur) => cur.filter((s) => s.id !== id))
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  useEffect(() => () => stagedRef.current.forEach((s) => s.url && URL.revokeObjectURL(s.url)), [])

  // One file to the thread, with an optimistic "Sending…" line until it lands.
  const uploadOne = async (conv: Conversation, file: File, caption: string, rep: Msg | null, capMentions: string[]) => {
    const tmpId = 'tmp_' + Date.now() + Math.random().toString(36).slice(2, 6)
    setMessages((m) => [...m, { id: tmpId, conversation_id: conv.id, sender_id: user!.id, body: caption, created_at: new Date().toISOString(), reactions: [], starred: false, seen: false, file: { name: file.name, type: file.type, size: file.size }, uploading: true }])
    try {
      const form = new FormData(); form.append('file', file)
      if (caption) form.append('body', caption)
      if (rep) form.append('replyTo', rep.id)
      if (capMentions.length) form.append('mentions', JSON.stringify(capMentions))
      const headers: Record<string, string> = {}; const t = getToken(); if (t) headers.authorization = `Bearer ${t}`
      const res = await fetch(`${API_BASE}/api/chat/conversations/${conv.id}/upload`, { method: 'POST', headers, body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Upload failed')
      setMessages((prev) => prev.map((x) => (x.id === tmpId ? data : x)))
      return true
    } catch (err: any) {
      setMessages((m) => m.filter((x) => x.id !== tmpId)); toast.error(`Could not send ${file.name}: ${err.message}`)
      return false
    }
  }

  // Send what is staged: one message per file, in order, the caption (and the
  // reply, and its @mentions) on the first. A file that fails goes back into
  // the tray to try again, and the caption with it if it was riding on that one.
  const sendStaged = async () => {
    const conv = active
    if (!conv || busy) return
    const items = stagedRef.current
    const caption = input.trim(); const rep = replyTo
    const capMentions = caption ? resolveMentions(caption, picked, conv.members, user!.id) : []
    setStaged([]); setInput(''); setBusy(true); sendTyping(false); setReplyTo(null); setPicked([]); setMentionQ(null)
    const failed: StagedFile[] = []
    try {
      for (let i = 0; i < items.length; i++) {
        const first = i === 0
        if (await uploadOne(conv, items[i].file, first ? caption : '', first ? rep : null, first ? capMentions : [])) {
          if (items[i].url) URL.revokeObjectURL(items[i].url!)
        } else {
          failed.push(items[i])
          if (first && caption) setInput((cur) => cur || caption)
        }
      }
      loadConvos()
    } finally {
      if (failed.length && activeIdRef.current === conv.id) setStaged((cur) => [...failed, ...cur])
      setBusy(false)
    }
  }

  // Phones have no Ctrl+V: the clip's "Paste from clipboard" reads the picture
  // on request (it has to happen inside the tap). Where the browser will not
  // share the clipboard (some phones, the Android app's web view), say so and
  // open the picker instead, where the latest screenshot is first anyway.
  const pasteFromClipboard = async () => {
    setAttachMenu(false)
    try {
      const files = await readClipboardImages()
      if (files.length) stageFiles(files)
      else toast.info('There is no picture on the clipboard. Copy one, or take a screenshot, first.')
    } catch {
      toast.info('This browser would not share the clipboard. Pick the picture instead.')
      fileRef.current?.click()
    }
  }

  const send = async () => {
    const body = input.trim()
    if (busy || !active) return
    if (editing) { if (body) return saveEdit(); return }
    if (stagedRef.current.length) return sendStaged()
    if (!body) return
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

  // Turn a recording sitting in the thread into a meeting summary with
  // reviewable tasks. This is the path when speech could not be recognised live
  // — and the retry once a transcription provider is configured, so recordings
  // already in the chat are not lost just because the key arrived later.
  const recordingToMeeting = async (m: Msg) => {
    if (summarising) return
    setSummarising(m.id)
    try {
      const d = await api.post(`/chat/message/${m.id}/to-meeting`)
      toast.success(d.existing ? 'Opening the summary' : `${d.suggestion_count || 0} task${d.suggestion_count === 1 ? '' : 's'} found — review and assign`)
      navigate(`/meetings/${d.id}`)
    } catch (e: any) {
      toast.error(/provider|NO_PROVIDER/i.test(e.message)
        ? 'Transcription needs a speech provider key on the server before a recording can be summarised.'
        : 'Could not summarise that recording: ' + e.message)
    } finally { setSummarising(null) }
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
    // Empty, scrollHeight is the placeholder's — a wrapped hint kept the box two
    // or three rows tall after every send. One row is right for an empty box.
    if (el.value) el.style.height = Math.min(el.scrollHeight, 132) + 'px'
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

  // Picked with the clip: into the same tray as a paste, so every way of adding
  // a file ends at one preview and one Send.
  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []); e.target.value = ''
    stageFiles(files)
  }

  // Ctrl+V with the focus anywhere in an open chat — on a message, on the
  // thread, nowhere in particular — is meant for the chat, as on WhatsApp Web.
  // A paste into some other field (the chat search, a dialog's input) stays
  // that field's, and the composer handles its own (onPaste on the textarea).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || !activeIdRef.current) return
      const t = e.target as HTMLElement | null
      if (t?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      if (document.querySelector('.modal-overlay, .modal-center, .ci-overlay')) return
      const files = clipboardFiles(e.clipboardData)
      if (!files.length) return
      e.preventDefault()
      stageFilesRef.current(files)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])
  const stageFilesRef = useRef(stageFiles)
  stageFilesRef.current = stageFiles

  // Drag files onto the thread to attach them (wide screens; harmless on phones).
  // dragenter/leave fire for every child crossed, so a depth count decides when
  // the drag has really left the pane.
  const paneDrop = {
    onDragEnter: (e: React.DragEvent) => {
      if (!active || !dragHasFiles(e.dataTransfer)) return
      e.preventDefault(); dragDepthRef.current++; setDropping(true)
    },
    onDragOver: (e: React.DragEvent) => {
      if (!active || !dragHasFiles(e.dataTransfer)) return
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: () => {
      if (!dropping) return
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (!dragDepthRef.current) setDropping(false)
    },
    onDrop: (e: React.DragEvent) => {
      if (!active || !dragHasFiles(e.dataTransfer)) return
      e.preventDefault(); dragDepthRef.current = 0; setDropping(false)
      stageFiles(droppedFiles(e.dataTransfer))
    },
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
    setReactFor(null); setMenuId(null); setSelectedId(null)
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
    // Said out loud: from the phone's action bar there is nothing else to show
    // that the tap did anything.
    try { await navigator.clipboard.writeText(text); toast.success('Copied') } catch { window.prompt('Copy:', text) }
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

  // Straight into the box with the caret at the end: choosing Edit means typing next.
  const startEdit = (m: Msg) => {
    setMenuId(null); setEditing({ id: m.id, body: m.body }); setInput(m.body); setReplyTo(null)
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(m.body.length, m.body.length) })
  }
  // Straight into the box: choosing Reply means the next thing is typing.
  const startReply = (m: Msg) => { setMenuId(null); setReplyTo(m); setEditing(null); requestAnimationFrame(() => inputRef.current?.focus()) }

  // Every action a message offers, in one list, so the desktop's hover menu and
  // the phone's action bar cannot drift apart. `bar` marks the ones the phone
  // bar shows as icons; its ⋮ lists the rest. The order is the menu's.
  const msgActions = (m: Msg): MsgAction[] => {
    const mine = m.sender_id === user!.id
    const list: (MsgAction | false)[] = [
      { key: 'reply', label: 'Reply', icon: 'reply', bar: true, run: () => startReply(m) },
      { key: 'task', label: 'Assign as task', icon: 'taskAdd', bar: true, run: () => toTask({ messageId: m.id }) },
      { key: 'remind', label: 'Remind me', run: () => setRemindFor(m) },
      { key: 'pin', label: m.pinned_at ? 'Unpin' : 'Pin to top', run: () => togglePin(m) },
      isManager && { key: 'fork', label: 'Fork to new chat', run: () => setForkFrom(m) },
      { key: 'unread', label: 'Mark unread', run: () => markUnread(m) },
      { key: 'forward', label: 'Forward', icon: 'forward', bar: true, run: () => setForwardMsg(m) },
      { key: 'link', label: 'Copy link', run: () => copyLink(m) },
      { key: 'copy', label: 'Copy', bar: true, run: () => copy(m) },
      !!m.file && { key: 'download', label: 'Download', run: () => download(m) },
      { key: 'share', label: 'Share', run: () => share(m) },
      { key: 'star', label: m.starred ? 'Unstar' : 'Star', icon: 'star', bar: true, on: m.starred, run: () => toggleStar(m) },
      mine && !m.file && { key: 'edit', label: 'Edit', run: () => startEdit(m) },
      { key: 'delete', label: mine ? 'Delete' : 'Remove for me', icon: 'trash', bar: true, danger: true, run: () => del(m) },
    ]
    return list.filter(Boolean) as MsgAction[]
  }

  // Select a message (touch screens): highlight it, float the reactions where
  // they fit, and hand the header to its actions. The reactions need ~58px
  // above or below the message inside the scrolling thread, which clips
  // anything that pokes out of it. A message with room on neither side (a long
  // one) is scrolled down to make room above when the thread can scroll that
  // far, and otherwise gets them over its own top edge.
  // `pressY`: where the finger was (a tap or a long-press), so the tray never
  // lands under it — the next tap there means the message (deselect), and a
  // reaction it posted would be a reaction nobody chose.
  const selectMessage = (id: string, bubble: HTMLElement, pressY?: number) => {
    const log = logRef.current
    const wrap = bubble.closest('.msg-wrap') as HTMLElement | null
    let place: 'above' | 'below' | 'inside' = 'above'
    let top = 8
    if (log && wrap) {
      const L = log.getBoundingClientRect()
      const W = wrap.getBoundingClientRect()
      const above = W.top - L.top
      const below = L.bottom - W.bottom
      if (above >= TRAY_ROOM) place = 'above'
      else if (below >= TRAY_ROOM) place = 'below'
      else {
        // A message with no room on either side: over the part of it that is on
        // screen, at the end away from the finger. Never scrolled — that slid the
        // tray under a finger still down, and threw a reader of a long message
        // back to its first line. +3: the selected row's -3px margin lifts the
        // box the tray hangs from.
        place = 'inside'
        const first = Math.max(W.top, L.top) + 8
        const last = Math.max(first, Math.min(W.bottom, L.bottom) - TRAY_ROOM)
        const nearTop = pressY != null && pressY < (first + last) / 2 + TRAY_ROOM / 2
        top = (nearTop ? last : first) - W.top + 3
      }
    }
    setTrayPlace(place); setTrayTop(top)
    setSelectedId(id)
    setMenuId(null); setReactFor(null); setEmojiFor(null); setHeadMenu(false); setJumpOpen(false); setLoadOpen(false)
  }
  // The chat's info panel — from the header's photo or name, or from ⋮. It
  // remembers what opened it, to hand focus back on close; an item in ⋮'s menu
  // goes away with the menu, so for those it is ⋮ itself.
  const infoOpenerRef = useRef<HTMLElement | null>(null)
  const openInfo = (view: InfoView = 'main') => {
    const from = document.activeElement as HTMLElement | null
    infoOpenerRef.current = from?.closest('.head-menu')
      ? document.querySelector<HTMLElement>('.chat-peer-actions [aria-label="More options"]')
      : from
    setInfoView(view); setShowInfo(true)
    setHeadMenu(false); setJumpOpen(false); setLoadOpen(false); setSelectedId(null)
  }
  useEffect(() => {
    if (showInfo) return
    const el = infoOpenerRef.current
    infoOpenerRef.current = null
    if (!el) return
    requestAnimationFrame(() => {
      if ((!document.activeElement || document.activeElement === document.body) && el.isConnected) el.focus()
    })
  }, [showInfo])
  const cancelPress = () => { if (pressRef.current) { clearTimeout(pressRef.current.timer); pressRef.current = null } }
  // A bubble's handlers on a touch screen: a tap selects (or, on the selected
  // message, deselects); holding still for LONG_PRESS_MS selects too, with a
  // buzz, the way WhatsApp does. A finger that moves is scrolling, not
  // pressing. Things inside the bubble with their own job — the voice player,
  // Download, the transcribe buttons — keep their taps. A tap on a link or an
  // image opens it, but a long-press on one selects the message, and the
  // phone's own long-press menu is kept out of the way. Mouse devices get none
  // of this: they have the hover tools.
  const bubbleTouch = (m: Msg) => (!touchUI || m.id.startsWith('tmp_') ? {} : {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      longPressedRef.current = false
      if ((e.target as HTMLElement).closest(PRESS_SKIP)) return
      cancelPress()
      const bubble = e.currentTarget
      const y = e.clientY
      pressRef.current = {
        x: e.clientX, y,
        timer: setTimeout(() => {
          pressRef.current = null
          longPressedRef.current = true
          try { navigator.vibrate?.(12) } catch { /* not allowed here; the highlight says it */ }
          selectMessage(m.id, bubble, y)
        }, LONG_PRESS_MS),
      }
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const p = pressRef.current
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress()
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => e.preventDefault(),
    // The click a long-press ends with (where the browser sends one) is the
    // same gesture: caught on the way down, before a link, the voice player or a
    // button inside the bubble can act on it.
    onClickCapture: (e: React.MouseEvent<HTMLDivElement>) => {
      if (longPressedRef.current) { longPressedRef.current = false; e.preventDefault(); e.stopPropagation() }
    },
    onClick: (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest(TAP_SKIP)) return
      e.stopPropagation()
      if (selectedId === m.id) setSelectedId(null)
      else selectMessage(m.id, e.currentTarget, e.clientY)
    },
    // Without a finger to tap with — a keyboard on a tablet, Switch Access —
    // the bubble takes focus and Enter, Space or the menu key select it, then
    // focus moves into the action bar. Being focusable is also what makes
    // TalkBack announce it as something that can be activated. Not a button
    // role: a bubble can hold links and buttons of its own.
    tabIndex: 0,
    'aria-describedby': 'msg-select-hint',
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return
      if (!(e.key === 'Enter' || e.key === ' ' || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return
      e.preventDefault()
      if (selectedId === m.id) { setSelectedId(null); return }
      selectMessage(m.id, e.currentTarget)
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.sel-bar .chat-peer-actions button')?.focus())
    },
  })

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

  const inTab = (c: Conversation, tab: ListTab) => tab === 'all' || c.type === tab
  const filteredConvos = convos.filter((c) => inTab(c, listTab) && c.name.toLowerCase().includes(search.toLowerCase()))
  // Per tab, how many chats have something unread — the number WhatsApp puts on
  // its filters. Muted chats are left out: muting means "don't call me over".
  const tabUnread = (tab: ListTab) => convos.filter((c) => inTab(c, tab) && c.unread > 0 && !c.muted).length
  const listEmpty = search.trim()
    ? `No ${listTab === 'group' ? 'group ' : listTab === 'direct' ? 'personal ' : ''}chats match “${search.trim()}”`
    : LIST_TABS.find((t) => t.id === listTab)!.empty
  // The person a direct chat is with, and what they are holding (for the header chip).
  const peerLoad = active?.type === 'direct' && active.other_user_id ? workload[active.other_user_id] : undefined
  const reactionsMsg = reactionsOf ? messages.find((x) => x.id === reactionsOf) || null : null
  // The message the header's action bar acts on (touch screens). A message
  // deleted while selected — here or over the socket — ends the selection.
  const selMsg = touchUI && selectedId ? messages.find((x) => x.id === selectedId && !x.deleted) || null : null
  // ...and the selection itself ends then (deleted for everyone, removed for
  // me, chat cleared, touch turned off), or the next Escape or Back would be
  // spent letting go of a message no longer there.
  useEffect(() => { if (selectedId && !selMsg) setSelectedId(null) }, [selectedId, selMsg])
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
    <div className={'assistant-layout chat-layout' + (threadOpen ? ' chat-open' : '')}>
      {/* ---- sidebar: conversations ---- */}
      <aside className="chat-history">
        <div className="chat-history-head">
          <span className="ch-title">Chats</span>
          <div className="row" style={{ gap: 2 }}>
            <button className="ic-btn" onClick={() => setShowMentions(true)} title="Messages that mention me" aria-label="Messages that mention me"><Ic name="at" size={18} /></button>
            <button className="ic-btn" onClick={() => setShowStarred(true)} title="Starred messages" aria-label="Starred messages"><Ic name="star" size={18} /></button>
            <button className="ic-btn" onClick={() => setShowLater(true)} title="Reminders & scheduled messages" aria-label="Reminders and scheduled messages"><Ic name="clock" size={18} /></button>
            <button className="btn btn-primary btn-sm row" style={{ gap: 5, marginLeft: 4 }} onClick={() => setShowNew(true)} title="New chat / group"><Ic name="plus" size={15} /> New</button>
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
        ) : (<>
        {/* All / Groups / Personal: one list, three ways to read it. Sits right
            above the list it filters. */}
        <div className="chat-tabs" role="tablist" aria-label="Which chats to show">
          {LIST_TABS.map((t) => {
            const n = tabUnread(t.id)
            return (
              <button key={t.id} role="tab" aria-selected={listTab === t.id} className={'chat-tab' + (listTab === t.id ? ' active' : '')} onClick={() => setListTab(t.id)}>
                {t.label}
                {n > 0 && <span className="chat-tab-badge" aria-label={`${n} with unread messages`}>{n > 9 ? '9+' : n}</span>}
              </button>
            )
          })}
        </div>
        <div className="convo-list">
          {filteredConvos.length === 0 && <div className="empty" style={{ padding: 16, fontSize: 13 }}>{listEmpty}</div>}
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
        </>)}
      </aside>

      {/* ---- conversation pane ---- */}
      <div className="card chat-pane" {...paneDrop}>
        {dropping && (
          <div className="drop-veil" aria-hidden="true">
            <Ic name="attach" size={28} />
            <span>Drop to attach</span>
            <span className="drop-veil-sub">You can add a caption before it is sent</span>
          </div>
        )}
        <div className="chat">
          {/* Touch screens, a message selected: the header becomes its action
              bar, as in WhatsApp — ✕ to let go, the everyday actions as icons,
              the rest under ⋮. Every action ends the selection. */}
          {active && selMsg && (
            <div className="chat-peer-head sel-bar" role="group" aria-label="Actions for the selected message">
              <button className="ic-btn" title="Cancel" aria-label="Cancel selection" onClick={(e) => { e.stopPropagation(); setSelectedId(null) }}>
                <Ic name="close" size={21} />
              </button>
              <div className="chat-peer-actions">
                {msgActions(selMsg).filter((a) => a.bar).map((a) => (
                  <button
                    key={a.key}
                    className={'ic-btn' + (a.on ? ' on' : '') + (a.danger ? ' danger' : '')}
                    title={a.label}
                    aria-label={a.label}
                    onClick={(e) => { e.stopPropagation(); setSelectedId(null); a.run() }}
                  >
                    {a.key === 'copy' ? <CopyGlyph size={20} /> : <Ic name={a.icon!} size={20} />}
                  </button>
                ))}
                <div className="msg-menu-wrap">
                  <button className="ic-btn" title="More" aria-label="More actions" aria-expanded={menuId === SEL_MENU} onClick={(e) => { e.stopPropagation(); setMenuId(menuId === SEL_MENU ? null : SEL_MENU) }}>
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="12" cy="19" r="1.9" /></svg>
                  </button>
                  {menuId === SEL_MENU && (
                    <div className="msg-menu mine head-menu" onClick={(e) => e.stopPropagation()}>
                      {msgActions(selMsg).filter((a) => !a.bar).map((a) => (
                        <button key={a.key} className={a.danger ? 'danger' : undefined} onClick={() => { setMenuId(null); setSelectedId(null); a.run() }}>{a.label}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {active && !selMsg && (() => { const otherOnline = active.type === 'direct' && !!active.other_user_id && online.has(active.other_user_id); return (
            <div className="chat-peer-head">
              {/* Mobile-only: back to the conversation list (WhatsApp-style). */}
              <button className="chat-list-btn" onClick={() => setActiveId('')} title="Back to chats" aria-label="Back to chats">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
              </button>
              {/* The photo and the name both open the chat's info, as on
                  WhatsApp — for a person as much as for a group. The name is
                  not a <button>: the workload chip inside it is one. */}
              <button className="chat-peer-photo" onClick={() => openInfo()} aria-label={`${active.type === 'group' ? 'Group' : 'Contact'} info for ${active.name}`}>
                {active.type === 'group'
                  ? <GroupAvatar conv={active} size={38} />
                  : <PresenceAvatar name={active.name} color={active.avatar_color} size={38} online={otherOnline} src={active.avatar_file && active.other_user_id ? userAvatarUrl(active.other_user_id, active.avatar_file) : undefined} />}
              </button>
              <div
                className="chat-peer-who"
                role="button"
                tabIndex={0}
                aria-label={`${active.name}. ${active.type === 'group' ? 'Group' : 'Contact'} info`}
                onClick={() => openInfo()}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openInfo() } }}
              >
                <div className="chat-peer-name">{active.name}</div>
                <div className="muted chat-peer-sub">
                  {typingName ? <span className="typing-text">{typingName} is typing…</span>
                    : active.type === 'group' ? <span>{active.members.map((m) => m.name.split(' ')[0]).join(', ')}</span>
                      : otherOnline ? <span className="online-text">online</span>
                        : (active.other_user_id && lastSeen[active.other_user_id]) ? <span>{lastSeenLabel(lastSeen[active.other_user_id])}</span>
                          : (() => {
                              // Not "Member" (their role in this chat, true of everyone in
                              // it): their own status if they set one, else their job role.
                              const peer = active.members.find((m) => m.id !== user!.id)
                              return peer?.status_text
                                ? <span>{`${peer.status_emoji || ''} ${peer.status_text}`.trim()}</span>
                                : <span style={{ textTransform: 'capitalize' }}>{peer?.job_role || ''}</span>
                            })()}
                  {/* What the person you are talking to is already holding, at
                      the moment you might hand them more. One-to-one chats only:
                      summed over a group it was the whole team's backlog ("107
                      open · 104 late"), which says nothing about anyone here. */}
                  <LoadChip load={peerLoad} onClick={(e) => { e.stopPropagation(); setLoadOpen((o) => !o); setHeadMenu(false) }} />
                </div>
              </div>
              <div className="chat-peer-actions">
                <button className="ic-btn" title="Audio call" aria-label="Start an audio call" onClick={() => startCall(active.id, 'audio', active.name)}>
                  <Ic name="phone" size={19} />
                </button>
                <button className="ic-btn" title="Video call" aria-label="Start a video call" onClick={() => startCall(active.id, 'video', active.name)}>
                  <Ic name="video" size={21} />
                </button>
                <button className="ic-btn wide-only" title="Search in chat" aria-label="Search in chat" onClick={() => setInSearchOpen((o) => !o)}>
                  <Ic name="search" size={19} />
                </button>
                {/* Everything else lives behind ⋮. Six boxed buttons in a row left a
                    phone ~120px for the chat's own name. */}
                <div className="msg-menu-wrap jump-wrap">
                  <button className="ic-btn" title="More" aria-label="More options" aria-expanded={headMenu} onClick={(e) => { e.stopPropagation(); setHeadMenu((o) => !o); setJumpOpen(false); setLoadOpen(false) }}>
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="12" cy="19" r="1.9" /></svg>
                  </button>
                  {headMenu && (
                    <div className="msg-menu mine head-menu" onClick={(e) => e.stopPropagation()}>
                      <button className="phone-only" onClick={() => { setHeadMenu(false); setInSearchOpen(true) }}><Ic name="search" size={15} /> Search in chat</button>
                      <button onClick={() => { setHeadMenu(false); setJumpOpen(true) }}><Ic name="calendar" size={15} /> Jump to a date</button>
                      <button onClick={() => openInfo()}><Ic name="user" size={15} /> {active.type === 'group' ? 'Group info' : 'Contact info'}</button>
                      <button onClick={() => openInfo('media')}><Ic name="attach" size={15} /> Media, links and docs</button>
                      <button onClick={() => { setHeadMenu(false); setShowChannels(true) }}><Ic name="hash" size={15} /> Browse channels</button>
                      <button onClick={() => { setHeadMenu(false); printConversation() }}><Ic name="doc" size={15} /> Print conversation</button>
                    </div>
                  )}
                  {jumpOpen && <JumpToDate days={dayIndex} onPick={jumpToDay} onClose={() => setJumpOpen(false)} />}
                </div>
              </div>
              {loadOpen && peerLoad && (
                <LoadPop
                  name={active.name}
                  load={peerLoad}
                  canOpen={isManager}
                  onOpen={() => { setLoadOpen(false); navigate(`/tasks?assignee=${active.other_user_id}`) }}
                />
              )}
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

          {/* For screen readers on touch screens: what activating a message
              does (each bubble points here), and a word when one is selected —
              its actions appear at the top, out of the reader's way. */}
          {touchUI && <span id="msg-select-hint" className="sr-only">Select to react, reply or forward</span>}
          <div className="sr-only" aria-live="polite">{selMsg ? `Message from ${selMsg.sender_id === user!.id ? 'you' : senderName(selMsg.sender_id)} selected. Reactions are next to it; reply, forward and more are at the top.` : ''}</div>

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
              // Reactions fold into one pill under the bubble (the top three
              // emoji and a total), as WhatsApp does; tapping it says who. A
              // chip per emoji that toggled your own reaction on tap left no way
              // to find out who had reacted at all.
              const rxs = m.reactions || []
              const rxCount: Record<string, number> = {}
              for (const rx of rxs) rxCount[rx.emoji] = (rxCount[rx.emoji] || 0) + 1
              const rxTop = Object.keys(rxCount).sort((a, b) => rxCount[b] - rxCount[a]).slice(0, 3)
              const rxMine = rxs.some((rx) => rx.user_id === user!.id)
              const rxWho = rxs.map((rx) => (rx.user_id === user!.id ? 'You' : senderName(rx.user_id))).join(', ')
              return (
                <div key={m.id} data-msg={m.id} className={'msg-wrap' + (flashId === m.id ? ' flash' : '') + (touchUI && selectedId === m.id && !m.deleted ? ' selected' : '')} style={{ alignItems: m.call ? 'center' : mine ? 'flex-end' : 'flex-start' }}>
                  {m.meeting ? (
                    <button className="meeting-card" onClick={() => navigate(`/meetings/${m.meeting!.id}`)}>
                      <div className="meeting-card-head">
                        <Ic name="doc" size={14} /> <span>{m.meeting.title}</span>
                      </div>
                      {m.meeting.summary && <div className="meeting-card-sum">{m.meeting.summary}</div>}
                      <div className="meeting-card-meta">
                        {m.meeting.tasks > 0 && <span className="mc-chip">{m.meeting.tasks} task{m.meeting.tasks === 1 ? '' : 's'} to review</span>}
                        {m.meeting.decisions > 0 && <span className="mc-chip">{m.meeting.decisions} decision{m.meeting.decisions === 1 ? '' : 's'}</span>}
                        {m.meeting.risks > 0 && <span className="mc-chip warn">{m.meeting.risks} risk{m.meeting.risks === 1 ? '' : 's'}</span>}
                        <span className="mc-open">Open summary →</span>
                      </div>
                    </button>
                  ) : m.call ? (
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
                        <div
                          className={'bubble ' + (mine ? 'user' : 'ai') + (m.file ? ' file-bubble' : '') + (isImage && !m.uploading ? ' pic-bubble' : '') + (mentionsMe ? ' mentions-me' : '')}
                          {...bubbleTouch(m)}
                        >
                          {m.forwarded && <div className="forwarded-tag row" style={{ gap: 5 }}><Ic name="forward" size={12} /> Forwarded</div>}
                          {m.reply && (
                            <div className="reply-quote"><span className="reply-quote-name">{m.reply.sender_id === user!.id ? 'You' : m.reply.sender_name}</span><span className="reply-quote-text">{m.reply.text}</span></div>
                          )}
                          {m.file && isAudio(m.file) && !m.uploading ? (
                            <div className="voice-note">
                              <VoicePlayer src={fileUrl(m)} id={m.id} mine={mine} />
                              {m.transcript && <div className="voice-text">{m.transcript}</div>}
                              <div className="voice-actions">
                                {!m.transcript && (
                                  <button className="voice-transcribe" disabled={transcribing === m.id} onClick={() => transcribeNote(m)}>
                                    {transcribing === m.id ? <><span className="spinner" /> Transcribing…</> : <><Ic name="ai" size={12} /> Read it as text</>}
                                  </button>
                                )}
                                {isManager && (
                                  <button className="voice-transcribe" disabled={summarising === m.id} onClick={() => recordingToMeeting(m)}>
                                    {summarising === m.id ? <><span className="spinner" /> Summarising…</> : <><Ic name="doc" size={12} /> Summary &amp; tasks</>}
                                  </button>
                                )}
                              </div>
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
                      {rxs.length > 0 && (
                        <div className={'reactions-row' + (mine ? ' mine' : '')}>
                          <button
                            className={'reaction-chip' + (rxMine ? ' mine' : '')}
                            title={rxWho}
                            aria-label={`Reactions: ${rxs.map((rx) => `${rx.user_id === user!.id ? 'You' : senderName(rx.user_id)} ${rx.emoji}`).join(', ')}. Show who reacted`}
                            onClick={(e) => { e.stopPropagation(); setSelectedId(null); setReactionsOf(m.id) }}
                          >
                            <span className="reaction-emojis">{rxTop.join('')}</span>
                            {rxs.length > 1 && <span className="reaction-count">{rxs.length}</span>}
                          </button>
                        </div>
                      )}
                    </div>
                    {/* Mouse devices: the tools beside the message, shown on hover.
                        Touch screens select the message instead (bubbleTouch). */}
                    {!touchUI && !isTemp && !m.deleted && (
                      <div className={'msg-tools' + (menuId === m.id || reactFor === m.id || emojiFor === m.id ? ' open' : '')}>
                        <button className="msg-tool-btn" title="React" aria-label="React" aria-expanded={reactFor === m.id} onClick={(e) => { e.stopPropagation(); setReactFor(reactFor === m.id ? null : m.id); setMenuId(null) }}><Ic name="smile" size={16} /></button>
                        <button className="msg-tool-btn" title="Reply" aria-label="Reply" onClick={(e) => { e.stopPropagation(); startReply(m) }}><Ic name="reply" size={16} /></button>
                        <button className="msg-tool-btn task-tool" title="Assign as task" aria-label="Assign as task" onClick={(e) => { e.stopPropagation(); toTask({ messageId: m.id }) }}><Ic name="taskAdd" size={16} /></button>
                        <div className="msg-menu-wrap">
                          <button className="msg-tool-btn" title="More" aria-label="More actions" aria-expanded={menuId === m.id} onClick={(e) => { e.stopPropagation(); setMenuId(menuId === m.id ? null : m.id); setReactFor(null) }}>⋯</button>
                          {menuId === m.id && (
                            <div className={'msg-menu' + (mine ? ' mine' : '')} onClick={(e) => e.stopPropagation()}>
                              {msgActions(m).map((a) => (
                                <button key={a.key} className={a.danger ? 'danger' : undefined} onClick={() => { setMenuId(null); a.run() }}>{a.label}</button>
                              ))}
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
                  {/* Touch screens: the selected message's quick reactions, one
                      tap from done. Yours is ringed, and tapping it takes it
                      back; one picked from the full set joins the row so it can
                      be taken back too. ＋ opens every emoji (over the composer,
                      where a phone has the room). */}
                  {touchUI && selectedId === m.id && !m.deleted && !isTemp && !m.call && !m.meeting && emojiFor !== m.id && (() => {
                    const myEmoji = rxs.find((rx) => rx.user_id === user!.id)?.emoji
                    const quick = myEmoji && !EMOJIS.includes(myEmoji) ? [myEmoji, ...EMOJIS] : EMOJIS
                    return (
                      <div className={'react-tray ' + trayPlace + (mine ? ' mine' : '')} style={trayPlace === 'inside' ? { top: trayTop } : undefined} role="group" aria-label="React to this message" onClick={(e) => e.stopPropagation()}>
                        {/* The label names the action ("Take back…"), not a pressed
                            state: reactions are one per person, and a different
                            emoji replaces yours rather than adding to it. */}
                        {quick.map((emo) => (
                          <button key={emo} className={emo === myEmoji ? 'on' : undefined} aria-label={emo === myEmoji ? `Take back your ${emo}` : `React with ${emo}`} onClick={() => react(m, emo)}>{emo}</button>
                        ))}
                        <button className="react-tray-more" aria-label="More emoji" onClick={() => setEmojiFor(m.id)}><Ic name="plus" size={18} /></button>
                      </div>
                    )
                  })()}
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
              {/* What will go with the next Send: pictures as thumbnails, other
                  files by name. ✕ takes one back out. */}
              {staged.length > 0 && (
                <div className="stage-strip" role="group" aria-label={`${staged.length} file${staged.length === 1 ? '' : 's'} ready to send`}>
                  {staged.map((s) => (
                    <div key={s.id} className={'stage-item' + (s.url ? ' pic' : '')} title={s.file.name}>
                      {s.url ? <img src={s.url} alt={s.file.name} />
                        : (<>
                          <span className={'stage-ic' + (isAudio({ name: s.file.name, type: s.file.type }) ? ' audio' : '')}>
                            {isAudio({ name: s.file.name, type: s.file.type }) ? <Ic name="mic" size={16} /> : (/\.([a-z0-9]{1,5})$/i.exec(s.file.name)?.[1] || 'FILE').toUpperCase()}
                          </span>
                          <span className="stage-meta"><span className="stage-name">{s.file.name}</span><span className="stage-size">{fmtSize(s.file.size)}</span></span>
                        </>)}
                      <button className="stage-x" aria-label={`Remove ${s.file.name}`} title="Remove" onClick={() => unstage(s.id)}><Ic name="close" size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
              <div className="chat-input chat-compose">
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
                {/* Touch screens: every emoji, for reacting to the selected
                    message — the tray's ＋. It opens over the composer, the full
                    width of the screen, rather than squeezed beside the message. */}
                {touchUI && emojiFor && emojiFor !== '__composer__' && (() => {
                  const target = messages.find((x) => x.id === emojiFor)
                  return target ? <EmojiPicker autoFocus={false} onClose={() => setEmojiFor(null)} onPick={(e) => { setEmojiFor(null); react(target, e) }} /> : null
                })()}
                <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={onPickFile} />
                {attachMenu && (
                  <div className="attach-pop" role="menu" aria-label="Attach" onClick={(e) => e.stopPropagation()}>
                    <button role="menuitem" onClick={() => { setAttachMenu(false); fileRef.current?.click() }}><Ic name="image" size={17} /> Photo or file</button>
                    <button role="menuitem" onClick={pasteFromClipboard}>
                      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></svg>
                      Paste from clipboard
                    </button>
                  </div>
                )}
                {/* One box holds everything: emoji on the left, the text in the
                    middle, and on the right the attach clip and the round button
                    that is the mic while the box is empty and Send once there is
                    text — the swap every messaging app makes. Six separate round
                    buttons used to share the row, which left a phone ~110px to
                    type in. The task and send-later buttons only appear once
                    there is text for them to act on. */}
                <div className={'composer-box' + (recording ? ' recording' : '')}>
                  {recording ? (
                    <div className="voice-recording">
                      <span className="voice-rec-dot" />
                      <span className="voice-rec-time">{Math.floor(recSecs / 60)}:{String(recSecs % 60).padStart(2, '0')}</span>
                      <span className="muted" style={{ fontSize: 12.5 }}>Recording…</span>
                      <button className="ic-btn cb-discard" title="Discard" aria-label="Discard the voice note" onClick={() => finishVoiceNote(true)}><Ic name="trash" size={18} /></button>
                    </div>
                  ) : (<>
                    <div className="emoji-wrap">
                      <button className="ic-btn cb-ic" title="Emoji" aria-label="Insert an emoji" disabled={busy} onClick={(e) => { e.stopPropagation(); setEmojiFor(emojiFor === '__composer__' ? null : '__composer__') }}>
                        <Ic name="smile" size={21} />
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
                    <textarea
                      ref={inputRef}
                      className="composer-input"
                      data-va="chats.composer"
                      rows={1}
                      placeholder={editing ? 'Edit your message…' : staged.length ? 'Add a caption…' : placeholder}
                      value={input}
                      onChange={onComposerChange}
                      onKeyDown={onComposerKey}
                      // A screenshot (or any copied file) pasted here goes into the
                      // tray above; a paste of words is still just words.
                      onPaste={(e) => {
                        const files = clipboardFiles(e.clipboardData)
                        if (!files.length) return
                        e.preventDefault()
                        stageFiles(files)
                      }}
                      onBlur={() => { sendTyping(false); setTimeout(() => setMentionQ(null), 120) }}
                      autoFocus
                    />
                    {/* Turn what you're typing into a task without sending it first —
                        the common case is realising mid-sentence that this is work. */}
                    {!editing && input.trim() && (
                      <button className="ic-btn cb-ic" title="Create a task from this text" aria-label="Create a task from this text" disabled={busy} onClick={draftFromComposer}><Ic name="taskAdd" size={19} /></button>
                    )}
                    {/* Send later carries words only — not offered while files wait. */}
                    {!editing && input.trim() && !staged.length && (
                      <button className="ic-btn cb-ic cb-later" title="Send later" aria-label="Send later" disabled={busy} onClick={() => setScheduleOpen(true)}><Ic name="clock" size={18} /></button>
                    )}
                    {/* On a touch screen the clip also offers the clipboard, there
                        being no Ctrl+V; with a mouse it goes straight to the files. */}
                    {!editing && (
                      <button
                        className="ic-btn cb-ic"
                        title="Attach (or paste a screenshot with Ctrl+V)"
                        aria-label="Attach a file"
                        aria-haspopup={touchUI && canReadClipboardImages() ? 'menu' : undefined}
                        aria-expanded={touchUI && canReadClipboardImages() ? attachMenu : undefined}
                        disabled={busy}
                        onClick={(e) => {
                          if (touchUI && canReadClipboardImages()) { e.stopPropagation(); setAttachMenu((o) => !o) }
                          else fileRef.current?.click()
                        }}
                      ><Ic name="attach" size={19} /></button>
                    )}
                  </>)}
                  {recording
                    ? <button className="send-btn" title="Send voice note" aria-label="Send the voice note" onClick={() => finishVoiceNote(false)}><Ic name="send" size={18} /></button>
                    : !editing && !input.trim() && !staged.length
                      ? <button className="send-btn mic" title="Record a voice note" aria-label="Record a voice note" disabled={busy} onClick={startVoiceNote}><Ic name="mic" size={20} /></button>
                      : <button
                          data-va="chats.send"
                          className="send-btn"
                          title={editing ? 'Save' : staged.length ? `Send ${staged.length === 1 ? 'it' : `all ${staged.length}`}` : 'Send (hold to send later)'}
                          aria-label={editing ? 'Save the edit' : staged.length ? `Send ${staged.length} file${staged.length === 1 ? '' : 's'}` : 'Send'}
                          disabled={busy || (!input.trim() && !staged.length)}
                          onClick={() => { if (heldRef.current) { heldRef.current = false; return } send() }}
                          onPointerDown={() => {
                            heldRef.current = false
                            if (editing || stagedRef.current.length) return
                            holdTimerRef.current = setTimeout(() => { heldRef.current = true; setScheduleOpen(true) }, 550)
                          }}
                          onPointerUp={endHold}
                          onPointerLeave={endHold}
                          onPointerCancel={endHold}
                          // The phone's own long-press menu would open over ours.
                          onContextMenu={(e) => e.preventDefault()}
                        >{editing ? <Ic name="check" size={20} /> : <Ic name="send" size={18} />}</button>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {reactionsMsg && active && (
        <ReactionsSheet
          message={reactionsMsg}
          members={active.members}
          meId={user!.id}
          onRemoveMine={(emoji) => react(reactionsMsg, emoji)}
          onClose={() => setReactionsOf(null)}
        />
      )}
      {showNew && <NewChatModal user={user!} convos={convos} onClose={() => setShowNew(false)} onOpen={(cid) => { setShowNew(false); setActiveId(cid); loadConvos() }} />}
      {showInfo && active && (
        <InfoPanel
          key={active.id}
          conv={active}
          user={user!}
          view={infoView}
          setView={setInfoView}
          online={online}
          lastSeen={lastSeen}
          load={peerLoad}
          isManager={isManager}
          onClose={() => setShowInfo(false)}
          onChanged={() => { loadConvos(); loadThread(active.id) }}
          onLeft={() => { setShowInfo(false); setActiveId(''); loadConvos() }}
          onCall={(kind) => { setShowInfo(false); startCall(active.id, kind, active.name) }}
          // Focus the search box once the panel has handed focus back to its opener.
          onSearch={() => { setShowInfo(false); setInSearchOpen(true); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.in-search input')?.focus()) }}
          onShowMessage={(id) => {
            setShowInfo(false)
            // A search leaves non-matching lines out of the thread; "show me that
            // line" needs the whole of it (as Jump to a date does).
            if (inSearch) { setInSearch(''); setInSearchOpen(false) }
            requestAnimationFrame(() => { if (!scrollToMessage(id)) toast.info('That message is further back than this chat has loaded') })
          }}
          onMessageUser={(uid) => {
            api.post('/chat/conversations', { type: 'direct', userId: uid })
              .then((conv: any) => { setShowInfo(false); loadConvos(); setActiveId(conv.id) })
              .catch(() => toast.error("I couldn't open that conversation."))
          }}
          onMute={() => { if (active.muted) muteConversation(active, 0); else setMuteFor(active) }}
          onClear={() => { setShowInfo(false); clearChat(active) }}
          // No setShowInfo(false): the move to Tasks unmounts the panel anyway, and
          // Back from Tasks should find it open again.
          onViewTasks={() => navigate(`/tasks?assignee=${active.other_user_id}`)}
        />
      )}
      {forwardMsg && <ForwardModal message={forwardMsg} convos={convos} onClose={() => setForwardMsg(null)} onDone={() => { setForwardMsg(null); loadConvos() }} />}
      {showStarred && <StarredModal onClose={() => setShowStarred(false)} onOpen={(cid, mid) => { setShowStarred(false); openMessage(cid, mid) }} />}
      {remindFor && <RemindModal message={remindFor} onClose={() => setRemindFor(null)} />}
      {showChannels && <ChannelsModal onClose={() => setShowChannels(false)} onOpen={(cid) => { setShowChannels(false); loadConvos(); setActiveId(cid) }} />}
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
  // A dialog: focus moves into it, Tab stays inside, Escape closes it, and
  // focus goes back to what opened it (lib/useDialog).
  const cardRef = useDialog<HTMLDivElement>(onClose)
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
      <div className="modal-card" ref={cardRef} role="dialog" aria-modal="true" aria-label="Forward message" onClick={(e) => e.stopPropagation()}>
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

// ---------- fork a message into its own thread ----------
// Cliq calls this forking. The useful part is not the new room, it is that the
// room OPENS with the message that caused it — so the people pulled in do not
// arrive at a blank screen asking what this is about.
function ForkModal({ message, members, senderName, onClose, onDone }: { message: Msg; members: Member[]; senderName: string; onClose: () => void; onDone: (convId: string) => void }) {
  // A dialog: focus moves into it, Tab stays inside, Escape closes it, and
  // focus goes back to what opened it (lib/useDialog).
  const cardRef = useDialog<HTMLDivElement>(onClose)
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
      <div className="modal-card" ref={cardRef} role="dialog" aria-modal="true" aria-label="Fork to a new chat" onClick={(e) => e.stopPropagation()}>
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

// ---------- who reacted ----------
// WhatsApp's reaction sheet: everyone who reacted, filterable by emoji, with
// your own row first and removable from here. A bottom sheet on a phone, a
// small card on desktop. Reads the live message, so a reaction arriving over the
// socket while it is open shows up in it; it closes itself once the last one is
// gone, since an empty "who reacted" list answers nothing.
function ReactionsSheet({ message, members, meId, onRemoveMine, onClose }: {
  message: Msg; members: Member[]; meId: string; onRemoveMine: (emoji: string) => void; onClose: () => void
}) {
  const [tab, setTab] = useState<string>('all')
  const rxs = message.reactions || []
  useEffect(() => { if (!rxs.length) onClose() }, [rxs.length])
  // A modal: focus moves into it (it is where you take your reaction back),
  // Tab stays inside, Escape closes, focus returns to the pill that opened it.
  const sheetRef = useDialog<HTMLDivElement>(onClose)
  const counts: Record<string, number> = {}
  for (const rx of rxs) counts[rx.emoji] = (counts[rx.emoji] || 0) + 1
  const emojis = Object.keys(counts).sort((a, b) => counts[b] - counts[a])
  // A tab whose last reaction was just withdrawn falls back to All.
  const shownTab = tab === 'all' || counts[tab] ? tab : 'all'
  const rows = rxs
    .filter((rx) => shownTab === 'all' || rx.emoji === shownTab)
    .sort((a, b) => (a.user_id === meId ? -1 : b.user_id === meId ? 1 : 0))
  return (
    <div className="modal-overlay rx-overlay" onClick={onClose}>
      <div className="modal-card rx-sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-label="Who reacted" onClick={(e) => e.stopPropagation()}>
        <div className="rx-head">
          <div className="rx-tabs" role="tablist" aria-label="Filter by reaction">
            <button role="tab" aria-selected={shownTab === 'all'} className={'rx-tab' + (shownTab === 'all' ? ' active' : '')} onClick={() => setTab('all')}>All {rxs.length}</button>
            {emojis.map((emo) => (
              <button key={emo} role="tab" aria-selected={shownTab === emo} className={'rx-tab' + (shownTab === emo ? ' active' : '')} onClick={() => setTab(emo)}>{emo} {counts[emo]}</button>
            ))}
          </div>
          <button className="ic-btn" onClick={onClose} aria-label="Close"><Ic name="close" size={17} /></button>
        </div>
        <div className="rx-list">
          {rows.map((rx) => {
            const mine = rx.user_id === meId
            const mem = members.find((x) => x.id === rx.user_id)
            const name = mine ? 'You' : mem?.name || 'Former member'
            const inner = (
              <>
                <Avatar name={mem?.name || name} color={mem?.avatar_color} size={36} src={mem?.avatar_file ? userAvatarUrl(mem.id, mem.avatar_file) : undefined} />
                <span className="rx-who">
                  <span className="rx-name">{name}</span>
                  {mine && <span className="rx-sub">Tap to remove</span>}
                </span>
                <span className="rx-emoji" aria-hidden="true">{rx.emoji}</span>
              </>
            )
            return mine
              ? <button key={rx.user_id} className="rx-row mine" onClick={() => onRemoveMine(rx.emoji)} aria-label={`Your reaction ${rx.emoji}. Remove it`}>{inner}</button>
              : <div key={rx.user_id} className="rx-row" aria-label={`${name} reacted ${rx.emoji}`}>{inner}</div>
          })}
        </div>
      </div>
    </div>
  )
}

// ---------- mute for a while ----------
function MuteModal({ conv, onClose, onPick }: { conv: Conversation; onClose: () => void; onPick: (minutes: number) => void }) {
  // A dialog: focus moves into it, Tab stays inside, Escape closes it, and
  // focus goes back to what opened it (lib/useDialog).
  const cardRef = useDialog<HTMLDivElement>(onClose)
  const OPTIONS: [string, number][] = [['1 hour', 60], ['8 hours', 480], ['1 day', 1440], ['1 week', 10080], ['Until I turn it back on', 525600]]
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" ref={cardRef} role="dialog" aria-modal="true" aria-label={`Mute ${conv.name}`} style={{ maxWidth: 320 }} onClick={(e) => e.stopPropagation()}>
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
  // A dialog: focus moves into it, Tab stays inside, Escape closes it, and
  // focus goes back to what opened it (lib/useDialog).
  const cardRef = useDialog<HTMLDivElement>(onClose)
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
      <div className="modal-card" ref={cardRef} role="dialog" aria-modal="true" aria-label="Remind me about this message" style={{ maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
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

// ---------- chat info: WhatsApp's Group info / Contact info ----------
// Opened from the thread header (the photo or the name) and from ⋮. One page
// that scrolls, in WhatsApp's order: who this is, what has been shared here
// (photos, documents, links — the thing people come to this screen for), the
// members, settings, and the way out. It covers the screen on a phone and
// slides in from the right on a wide one. Confirmations it raises (remove,
// exit, delete) sit above it — see .confirm-center.
type InfoView = 'main' | 'media' | 'add'
type InfoTab = 'media' | 'docs' | 'links'
interface LinkItem { id: string; url: string; host: string; sender_id: string; sender_name: string; created_at: string }
type SharedFile = Msg & { sender_name: string }

const isImageFile = (f?: ChatFile | null) => !!f && (f.type || '').startsWith('image/')
const isVideoFile = (f?: ChatFile | null) => !!f && (f.type || '').startsWith('video/')
const fileExt = (name?: string) => (/\.([a-z0-9]{1,5})$/i.exec(name || '')?.[1] || 'FILE').toUpperCase()
// A link's tile colour, the same for every link to the same site.
const LINK_HUES = ['#2563eb', '#16a34a', '#7c3aed', '#d97706', '#0891b2', '#db2777']
const hueFor = (host: string) => LINK_HUES[[...host].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % LINK_HUES.length]
// WhatsApp's media headings: this week, this month, then month by month.
function periodLabel(iso: string) {
  const d = new Date(iso), today = new Date()
  if (today.getTime() - d.getTime() < 7 * 86400000) return 'This week'
  if (d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear()) return 'This month'
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}
function byPeriod<T>(items: T[], at: (x: T) => string) {
  const out: { label: string; items: T[] }[] = []
  for (const it of items) {
    const label = periodLabel(at(it))
    if (out.length && out[out.length - 1].label === label) out[out.length - 1].items.push(it)
    else out.push({ label, items: [it] })
  }
  return out
}

function InfoPanel({ conv, user, view, setView, online, lastSeen, load, isManager, onClose, onChanged, onLeft, onCall, onSearch, onShowMessage, onMessageUser, onMute, onClear, onViewTasks }: {
  conv: Conversation; user: OrgUser; view: InfoView; setView: (v: InfoView) => void; online: Set<string>; lastSeen: Record<string, string>
  load?: { open: number; overdue: number }; isManager: boolean
  onClose: () => void; onChanged: () => void; onLeft: () => void
  onCall: (kind: 'audio' | 'video') => void; onSearch: () => void; onShowMessage: (messageId: string) => void
  onMessageUser: (userId: string) => void; onMute: () => void; onClear: () => void; onViewTasks: () => void
}) {
  const isGroup = conv.type === 'group'
  const isAdmin = isGroup && conv.role === 'admin'
  const [tab, setTab] = useState<InfoTab>('media')
  const [files, setFiles] = useState<SharedFile[] | null>(null)
  const [links, setLinks] = useState<LinkItem[] | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [name, setName] = useState(conv.name)
  const [memberOpen, setMemberOpen] = useState<string | null>(null)
  const [memberQ, setMemberQ] = useState('')
  const photoInput = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Everything shared here, once per open: files from /media (newest 200, the
  // same list the old Shared files box used) and every URL from /links.
  useEffect(() => {
    let cancel = false
    api.get(`/chat/conversations/${conv.id}/media`).then((d) => { if (!cancel) setFiles(d.items || []) }).catch(() => { if (!cancel) setFiles([]) })
    api.get(`/chat/conversations/${conv.id}/links`).then((d) => { if (!cancel) setLinks(d.items || []) }).catch(() => { if (!cancel) setLinks([]) })
    return () => { cancel = true }
  }, [conv.id])
  useEffect(() => { if (!editingName) setName(conv.name) }, [conv.name, editingName])
  // Back steps out of a sub-page before it closes the panel — Escape, the
  // panel's own arrow, and Android's back button (registered after the Chats
  // page's handler, so it runs first).
  const back = () => { if (view !== 'main') setView('main'); else onClose() }
  useEffect(() => pushBackHandler(() => { back(); return true }), [view])
  // The shared dialog behaviour (lib/useDialog): focus moves into the panel,
  // Tab stays inside it, Escape is `back`, and focus returns to what opened it.
  // It stands aside for a confirmation the panel raises; a dialog it opens over
  // itself (Mute) keeps Escape from closing the panel underneath it.
  // Escape while renaming cancels the rename, not the whole panel (useDialog's
  // listener runs before the name box's own).
  const panelRef = useDialog<HTMLElement>(() => {
    if (editingName) {
      setEditingName(false); setName(conv.name)
      requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('.ci-name-pen')?.focus())
      return
    }
    back()
  })
  // While it is open the floating voice pill steps left of it instead of
  // sitting on its bottom rows (styles.css, body.chat-info-open).
  useEffect(() => {
    document.body.classList.add('chat-info-open')
    return () => document.body.classList.remove('chat-info-open')
  }, [])
  // A new page starts at its top, with focus on its arrow if the button that
  // led there went away with the old page.
  useEffect(() => {
    bodyRef.current?.scrollTo(0, 0)
    if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.querySelector<HTMLElement>('.ci-head .ic-btn')?.focus()
  }, [view])

  const media = (files || []).filter((m) => isImageFile(m.file) || isVideoFile(m.file))
  const docs = (files || []).filter((m) => !isImageFile(m.file) && !isVideoFile(m.file))
  const linkList = links || []
  const loaded = files !== null && links !== null
  const counts: Record<InfoTab, number> = { media: media.length, docs: docs.length, links: linkList.length }
  const total = counts.media + counts.docs + counts.links
  // The strip on the main page: the newest few of all three kinds together.
  const strip = [
    ...media.map((m) => ({ kind: 'media' as const, at: m.created_at, m })),
    ...docs.map((m) => ({ kind: 'doc' as const, at: m.created_at, m })),
    ...linkList.map((l) => ({ kind: 'link' as const, at: l.created_at, l })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8)

  // You first, then the group's admins, then everyone else by name.
  const members = [...conv.members].sort((a, b) =>
    a.id === user.id ? -1 : b.id === user.id ? 1
      : (a.role === 'admin') !== (b.role === 'admin') ? (a.role === 'admin' ? -1 : 1)
        : a.name.localeCompare(b.name))
  const q = memberQ.trim().toLowerCase()
  const shownMembers = q ? members.filter((m) => m.name.toLowerCase().includes(q)) : members
  const peer = !isGroup ? conv.members.find((m) => m.id !== user.id) : undefined
  const peerOnline = !!conv.other_user_id && online.has(conv.other_user_id)
  const peerSeen = conv.other_user_id ? lastSeen[conv.other_user_id] : undefined

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
  const saveName = async () => {
    const next = name.trim()
    if (!next || next === conv.name) { setEditingName(false); setName(conv.name); return }
    try { await api.patch(`/chat/conversations/${conv.id}`, { name: next }); setEditingName(false); onChanged() }
    catch (e: any) { toast.error(e.message) }
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
  const remove = async (m: Member) => {
    if (!(await confirmDialog({ title: `Remove ${m.name}?`, message: `${m.name.split(' ')[0]} will no longer see new messages in "${conv.name}".`, confirmText: 'Remove', danger: true }))) return
    try { await api.del(`/chat/conversations/${conv.id}/members/${m.id}`); setMemberOpen(null); onChanged() }
    catch (e: any) { toast.error(e.message) }
  }
  const leave = async () => {
    if (!(await confirmDialog({ title: 'Exit group?', message: `You will stop getting messages from "${conv.name}".`, confirmText: 'Exit', danger: true }))) return
    try { await api.del(`/chat/conversations/${conv.id}/members/${user.id}`); onLeft() }
    catch (e: any) { toast.error(e.message) }
  }
  const deleteGroup = async () => {
    if (!(await confirmDialog({ title: 'Delete group?', message: `Delete "${conv.name}" for everyone? This cannot be undone.`, confirmText: 'Delete', danger: true }))) return
    try { await api.del(`/chat/conversations/${conv.id}`); onLeft() }
    catch (e: any) { toast.error(e.message) }
  }

  const title = view === 'media' ? 'Media, links and docs' : view === 'add' ? 'Add members' : isGroup ? 'Group info' : 'Contact info'
  const SEP = ' · '

  const tile = (it: typeof strip[number]) => {
    if (it.kind === 'link') return (
      <a key={'l' + it.l.id + it.l.url} className="ci-tile ci-tile-link" href={it.l.url} target="_blank" rel="noopener noreferrer" title={it.l.url} style={{ background: hueFor(it.l.host) }}>
        <span>{it.l.host.charAt(0).toUpperCase()}</span>
      </a>
    )
    const m = it.m
    return (
      <a key={m.id} className={'ci-tile' + (it.kind === 'doc' ? ' ci-tile-doc' : '')} href={fileUrl(m)} target="_blank" rel="noreferrer" title={m.file?.name}>
        {isImageFile(m.file) ? <img src={fileUrl(m)} alt={m.file?.name || 'Photo'} loading="lazy" />
          : isVideoFile(m.file) ? <span className="ci-tile-play" aria-hidden="true">▶</span>
            : isAudio(m.file) ? <Ic name="mic" size={20} />
              : <span className="ci-tile-ext">{fileExt(m.file?.name)}</span>}
      </a>
    )
  }

  return (
    <div className="ci-overlay" onClick={onClose}>
      <aside className="ci-panel" ref={panelRef} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="ci-head">
          <button className="ic-btn" aria-label={view === 'main' ? 'Close' : 'Back'} title={view === 'main' ? 'Close' : 'Back'} onClick={back}>
            {view === 'main' ? <Ic name="close" size={20} />
              : <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>}
          </button>
          <span className="ci-head-title">{title}</span>
        </div>

        <div className={'ci-body' + (view === 'add' ? ' flush' : '')} ref={bodyRef}>
          {view === 'main' && (<>
            <section className="ci-hero">
              {isGroup ? (
                <>
                  <input ref={photoInput} type="file" accept="image/*" style={{ display: 'none' }} onChange={uploadPhoto} />
                  <button className="ci-photo" disabled={!isAdmin} title={isAdmin ? 'Change group photo' : undefined} aria-label={isAdmin ? 'Change group photo' : 'Group photo'} onClick={() => isAdmin && photoInput.current?.click()}>
                    <GroupAvatar conv={conv} size={96} />
                    {isAdmin && <span className="ci-photo-badge" aria-hidden="true"><Ic name="edit" size={13} /></span>}
                  </button>
                </>
              ) : (
                <span className="ci-photo"><PresenceAvatar name={conv.name} color={conv.avatar_color} size={96} online={peerOnline} src={conv.avatar_file && conv.other_user_id ? userAvatarUrl(conv.other_user_id, conv.avatar_file) : undefined} /></span>
              )}
              {editingName ? (
                <div className="ci-name-edit">
                  <input autoFocus value={name} maxLength={80} aria-label="Group name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { e.stopPropagation(); setEditingName(false); setName(conv.name) } }} />
                  <button className="btn btn-primary btn-sm" onClick={saveName} disabled={!name.trim()}>Save</button>
                  <button className="btn btn-sm" onClick={() => { setEditingName(false); setName(conv.name) }}>Cancel</button>
                </div>
              ) : (
                <div className="ci-name">
                  <span>{conv.name}</span>
                  {isAdmin && <button className="ic-btn ci-name-pen" aria-label="Rename group" title="Rename group" onClick={() => setEditingName(true)}><Ic name="edit" size={15} /></button>}
                </div>
              )}
              <div className="ci-sub">
                {isGroup
                  ? `${conv.visibility === 'public' ? 'Open channel' : 'Group'}${SEP}${conv.members.length} member${conv.members.length === 1 ? '' : 's'}`
                  : peerOnline ? <span className="online-text">online</span>
                    : peerSeen ? lastSeenLabel(peerSeen)
                      : peer?.status_text ? `${peer.status_emoji || ''} ${peer.status_text}`.trim()
                        : <span style={{ textTransform: 'capitalize' }}>{peer?.job_role || ''}</span>}
              </div>
              <div className="ci-quick">
                <button onClick={() => onCall('audio')}><Ic name="phone" size={20} /><span>Audio</span></button>
                <button onClick={() => onCall('video')}><Ic name="video" size={21} /><span>Video</span></button>
                <button onClick={onSearch}><Ic name="search" size={20} /><span>Search</span></button>
                {isAdmin && <button onClick={() => setView('add')}><Ic name="plus" size={21} /><span>Add</span></button>}
              </div>
            </section>

            {!isGroup && load && load.open > 0 && (
              <section className="ci-sec">
                <div className="ci-row ci-static">
                  <span className={'ci-row-ic' + (load.overdue ? ' late' : '')}>{load.overdue ? <Ic name="warning" size={18} /> : <Ic name="check" size={18} />}</span>
                  <span className="ci-row-text">
                    <span>{load.open} open task{load.open === 1 ? '' : 's'}{load.overdue ? `${SEP}${load.overdue} overdue` : ''}</span>
                    <span className="ci-row-sub">What {conv.name.split(' ')[0]} is already carrying</span>
                  </span>
                  {isManager && <button className="btn btn-sm" onClick={onViewTasks}>View tasks</button>}
                </div>
              </section>
            )}

            <section className="ci-sec">
              <button className="ci-row-head" onClick={() => setView('media')}>
                <span>Media, links and docs</span>
                <span className="ci-count">{loaded ? total : ''}<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg></span>
              </button>
              {!loaded && <div className="ci-strip">{[0, 1, 2, 3].map((i) => <span key={i} className="ci-tile ci-tile-skel" />)}</div>}
              {loaded && strip.length === 0 && <div className="ci-empty">Photos, documents and links shared in this chat will show up here.</div>}
              {loaded && strip.length > 0 && <div className="ci-strip">{strip.map(tile)}</div>}
            </section>

            {isGroup && (
              <section className="ci-sec">
                <div className="ci-sec-title">
                  <span>{conv.members.length} member{conv.members.length === 1 ? '' : 's'}</span>
                  {conv.members.length > 8 && <input className="ci-member-search" placeholder="Search members" value={memberQ} onChange={(e) => setMemberQ(e.target.value)} aria-label="Search members" />}
                </div>
                {isAdmin && (
                  <button className="ci-row" onClick={() => setView('add')}>
                    <span className="ci-add-ic" aria-hidden="true"><Ic name="plus" size={20} /></span>
                    <span className="ci-row-text"><span style={{ fontWeight: 600 }}>Add members</span></span>
                  </button>
                )}
                {shownMembers.map((m) => {
                  const me = m.id === user.id
                  const open = memberOpen === m.id
                  const status = m.status_text ? `${m.status_emoji || ''} ${m.status_text}`.trim() : ''
                  return (
                    <div key={m.id} className={'ci-member' + (open ? ' open' : '')}>
                      <button className="ci-row" aria-expanded={me ? undefined : open} disabled={me} onClick={() => setMemberOpen(open ? null : m.id)}>
                        <PresenceAvatar name={m.name} color={m.avatar_color} size={40} online={online.has(m.id)} src={m.avatar_file ? userAvatarUrl(m.id, m.avatar_file) : undefined} />
                        <span className="ci-row-text">
                          <span className="ci-member-name">{me ? 'You' : m.name}</span>
                          {status && <span className="ci-row-sub">{status}</span>}
                        </span>
                        {m.role === 'admin' && <span className="ci-admin">Group admin</span>}
                      </button>
                      {open && (
                        <div className="ci-member-actions">
                          <button className="btn btn-sm" onClick={() => onMessageUser(m.id)}><Ic name="chat" size={14} /> Message {m.name.split(' ')[0]}</button>
                          {isAdmin && <button className="btn btn-sm ci-danger-btn" onClick={() => remove(m)}><Ic name="trash" size={14} /> Remove from group</button>}
                        </div>
                      )}
                    </div>
                  )
                })}
                {q && shownMembers.length === 0 && <div className="ci-empty">Nobody here matches “{memberQ.trim()}”</div>}
              </section>
            )}

            <section className="ci-sec">
              <button className="ci-row" onClick={onMute}>
                <span className="ci-row-ic">{conv.muted ? <Ic name="muteBell" size={18} /> : <Ic name="bell" size={18} />}</span>
                <span className="ci-row-text"><span>Notifications</span><span className="ci-row-sub">{conv.muted ? 'Muted — messages arrive quietly' : 'On'}</span></span>
              </button>
              {isAdmin && (
                <div className="ci-row ci-static">
                  <span className="ci-row-ic"><Ic name={conv.visibility === 'public' ? 'hash' : 'lock'} size={18} /></span>
                  <span className="ci-row-text">
                    <span>{conv.visibility === 'public' ? 'Open channel' : 'Private group'}</span>
                    <span className="ci-row-sub">{conv.visibility === 'public' ? 'Anyone in the workspace can find and join this.' : 'Only people added here can see it.'}</span>
                  </span>
                  <button className="btn btn-sm" onClick={toggleVisibility}>{conv.visibility === 'public' ? 'Make private' : 'Open to all'}</button>
                </div>
              )}
            </section>

            <section className="ci-sec">
              {isGroup ? (<>
                <button className="ci-row ci-danger" onClick={leave}>
                  <span className="ci-row-ic"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg></span>
                  <span className="ci-row-text"><span>Exit group</span></span>
                </button>
                {isAdmin && (
                  <button className="ci-row ci-danger" onClick={deleteGroup}>
                    <span className="ci-row-ic"><Ic name="trash" size={18} /></span>
                    <span className="ci-row-text"><span>Delete group</span></span>
                  </button>
                )}
              </>) : (
                <button className="ci-row ci-danger" onClick={onClear}>
                  <span className="ci-row-ic"><Ic name="trash" size={18} /></span>
                  <span className="ci-row-text"><span>Clear chat</span></span>
                </button>
              )}
            </section>
          </>)}

          {view === 'media' && (<>
            <div className="ci-tabs" role="tablist" aria-label="What to show">
              {(['media', 'docs', 'links'] as InfoTab[]).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={'ci-tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>
                  {t === 'media' ? 'Media' : t === 'docs' ? 'Docs' : 'Links'}{loaded && <> <span>{counts[t]}</span></>}
                </button>
              ))}
            </div>
            {!loaded && <div className="ci-empty"><span className="spinner" /></div>}
            {loaded && tab === 'media' && (media.length === 0
              ? <div className="ci-empty">No photos or videos shared here yet.</div>
              : byPeriod(media, (m) => m.created_at).map((g) => (
                <div key={g.label}>
                  <div className="ci-period">{g.label}</div>
                  <div className="ci-grid">{g.items.map((m) => tile({ kind: 'media', at: m.created_at, m }))}</div>
                </div>
              )))}
            {loaded && tab === 'docs' && (docs.length === 0
              ? <div className="ci-empty">No documents shared here yet.</div>
              : byPeriod(docs, (m) => m.created_at).map((g) => (
                <div key={g.label}>
                  <div className="ci-period">{g.label}</div>
                  {g.items.map((m) => (
                    <div key={m.id} className="ci-item">
                      <a className="ci-item-main" href={fileUrl(m)} target="_blank" rel="noreferrer">
                        <span className={'ci-doc-ic' + (isAudio(m.file) ? ' audio' : '')}>{isAudio(m.file) ? <Ic name="mic" size={18} /> : fileExt(m.file?.name)}</span>
                        <span className="ci-row-text">
                          <span className="ci-item-name">{m.file?.name}</span>
                          <span className="ci-row-sub">{[fmtSize(m.file?.size), m.sender_id === user.id ? 'You' : m.sender_name, dayLabel(m.created_at)].filter(Boolean).join(SEP)}</span>
                        </span>
                      </a>
                      <button className="ic-btn" title="Show in chat" aria-label={`Show ${m.file?.name} in the chat`} onClick={() => onShowMessage(m.id)}><Ic name="chat" size={17} /></button>
                      <a className="ic-btn" href={fileUrl(m, true)} download title="Download" aria-label={`Download ${m.file?.name}`}><Ic name="download" size={17} /></a>
                    </div>
                  ))}
                </div>
              )))}
            {loaded && tab === 'links' && (linkList.length === 0
              ? <div className="ci-empty">No links shared here yet.</div>
              : byPeriod(linkList, (l) => l.created_at).map((g) => (
                <div key={g.label}>
                  <div className="ci-period">{g.label}</div>
                  {g.items.map((l) => (
                    <div key={l.id + l.url} className="ci-item">
                      <a className="ci-item-main" href={l.url} target="_blank" rel="noopener noreferrer">
                        <span className="ci-link-ic" style={{ background: hueFor(l.host) }} aria-hidden="true">{l.host.charAt(0).toUpperCase()}</span>
                        <span className="ci-row-text">
                          <span className="ci-item-name">{l.host}</span>
                          <span className="ci-link-url">{l.url}</span>
                          <span className="ci-row-sub">{[l.sender_id === user.id ? 'You' : l.sender_name, dayLabel(l.created_at)].join(SEP)}</span>
                        </span>
                      </a>
                      <button className="ic-btn" title="Show in chat" aria-label={`Show the message with ${l.host} in the chat`} onClick={() => onShowMessage(l.id)}><Ic name="chat" size={17} /></button>
                    </div>
                  ))}
                </div>
              )))}
          </>)}

          {view === 'add' && <AddMembers conv={conv} onDone={() => { setView('main'); onChanged() }} />}
        </div>
      </aside>
    </div>
  )
}

// Add people to a group: everyone in the workspace not already in it.
function AddMembers({ conv, onDone }: { conv: Conversation; onDone: () => void }) {
  const [users, setUsers] = useState<OrgUser[] | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.get('/chat/users').then((d) => setUsers(d.users.filter((u: OrgUser) => !conv.members.some((m) => m.id === u.id)))).catch(() => setUsers([]))
  }, [conv.id])
  const shown = (users || []).filter((u) => u.name.toLowerCase().includes(q.trim().toLowerCase()))
  const add = async () => {
    if (!sel.size) return
    setBusy(true)
    try { await api.post(`/chat/conversations/${conv.id}/members`, { userIds: [...sel] }); toast.success(`Added ${sel.size} ${sel.size === 1 ? 'person' : 'people'}`); onDone() }
    catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="ci-add">
      <input className="ci-member-search ci-add-search" placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" autoFocus />
      {users === null && <div className="ci-empty"><span className="spinner" /></div>}
      {users !== null && users.length === 0 && <div className="ci-empty">Everyone in the workspace is already here.</div>}
      {shown.map((u) => (
        <label key={u.id} className="ci-row">
          <Avatar name={u.name} color={u.avatar_color} size={40} src={u.avatar_file ? userAvatarUrl(u.id, u.avatar_file) : undefined} />
          <span className="ci-row-text"><span className="ci-member-name">{u.name}</span><span className="ci-row-sub" style={{ textTransform: 'capitalize' }}>{u.role}</span></span>
          <input type="checkbox" checked={sel.has(u.id)} onChange={() => setSel((s) => { const n = new Set(s); n.has(u.id) ? n.delete(u.id) : n.add(u.id); return n })} />
        </label>
      ))}
      {/* Nothing to confirm when nobody can be added. */}
      {!!users?.length && <div className="ci-add-bar">
        <button className="btn btn-primary" disabled={!sel.size || busy} onClick={add}>{busy ? 'Adding…' : sel.size ? `Add ${sel.size} ${sel.size === 1 ? 'person' : 'people'}` : 'Add people'}</button>
      </div>}
    </div>
  )
}
