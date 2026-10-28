// Data layer for the chat info panel (WhatsApp-style "Group info" / "Contact
// info"): the shapes the server sends, the four read endpoints, and the small
// formatters the panel's views share.
//
// The panel is three sibling components — ChatInfoPanel (the shell, the info
// page and the member list), ChatMedia (media, links and docs) and ChatMeetings
// (calls and meeting summaries) — built against this one file. The interfaces
// here are the contract with server/src/routes/chat.js: change a shape on one
// side and change it on the other in the same commit.
import { api, API_BASE, getToken, Suggestion } from '../api'

// ---------------------------------------------------------------- navigation

export type MediaKind = 'images' | 'videos' | 'audio' | 'files' | 'links'

// Tab order follows how people look for things: by sight first, then sound,
// then documents, then links.
export const MEDIA_TABS: { key: MediaKind; label: string; icon: 'image' | 'video' | 'music' | 'file' | 'link' }[] = [
  { key: 'images', label: 'Images', icon: 'image' },
  { key: 'videos', label: 'Videos', icon: 'video' },
  { key: 'audio', label: 'Audio', icon: 'music' },
  { key: 'files', label: 'Files', icon: 'file' },
  { key: 'links', label: 'Links', icon: 'link' },
]

// Where the panel is. A small stack rather than routes: the panel lives inside
// the chat page, and Back (the header arrow, Escape, Android's back button)
// walks it before it closes the panel.
export type InfoView =
  | { view: 'info' }
  | { view: 'media'; tab?: MediaKind }
  | { view: 'meetings' }
  | { view: 'summaries' }
  | { view: 'summary'; meetingId: string; review?: boolean }

// ------------------------------------------------------------------- people

// The slice of the Chats page's Conversation the panel reads. Structural on
// purpose, so Chats passes its own object and neither type has to own the other.
export interface ChatConvLite {
  id: string
  type: 'direct' | 'group'
  name: string
  avatar_color?: string
  avatar_file?: string | null
  other_user_id?: string | null
  member_count: number
  members: { id: string; name: string; avatar_color?: string; avatar_file?: string | null; role: string; status_text?: string; status_emoji?: string; dnd_until?: string | null }[]
  // The viewer's CHAT role ('admin' | 'member'). Group management (rename,
  // photo, description, add/remove, admins, visibility, delete) is gated on
  // this, not the org role.
  role: string
  visibility?: 'private' | 'public'
  muted?: boolean
  muted_until?: string | null
  description?: string
  // "Send messages: only admins".
  admins_only?: boolean
}

// The signed-in user. `role` is the ORG role ('admin' | 'manager' | 'employee').
export interface Me { id: string; name: string; role: string }

// Reviewing and assigning a meeting's tasks is manager/admin on the server
// (requireRole); hiding the controls for everyone else is courtesy, not security.
export const canReview = (me: Me) => me.role === 'manager' || me.role === 'admin'
// May I review THIS meeting's tasks? A manager may review any; anyone else the
// meetings they were in — a call they joined (server: canReviewMeeting, sent
// as `can_review`). An older server sends nothing, and then only managers.
export const mayReview = (me: Me, m?: { can_review?: boolean } | null) => m?.can_review ?? canReview(me)

export interface Workload { open: number; overdue: number }

export interface PersonLite { id: string; name: string; avatar_color?: string; avatar_file?: string | null }

export interface InfoMember extends PersonLite {
  email: string
  org_role: string
  chat_role: 'admin' | 'member'
  status_text?: string
  status_emoji?: string
  dnd_until?: string | null
  last_seen?: string | null
  joined_at?: string | null
  department?: string | null
  is_me: boolean
  workload: Workload
}

export interface ContactInfo extends PersonLite {
  email: string
  org_role: string
  department?: string | null
  last_seen?: string | null
  status_text?: string
  status_emoji?: string
  dnd_until?: string | null
  workload: Workload
}

export interface CommonGroup { id: string; name: string; avatar_color?: string; avatar_file?: string | null; member_count: number }

// --------------------------------------------------------------------- info

export interface MediaCounts { images: number; videos: number; audio: number; files: number; links: number }

export interface InfoCounts extends MediaCounts {
  calls: number
  summaries: number
  // Suggested tasks from this conversation's meetings still awaiting review
  // by this reader (the server counts only meetings they may review).
  pending_review: number
}

export interface RecentMedia { id: string; kind: 'images' | 'videos'; name: string; type: string; created_at: string }

export interface ChatInfo {
  conversation: ChatConvLite & { created_at: string; created_by: { id: string; name: string } | null }
  // Sorted by the server: you first, then group admins, then everyone else in
  // natural name order (Employee 2 before Employee 10).
  members: InfoMember[]
  counts: InfoCounts
  // The newest images and videos, for the strip under "Media, links and docs".
  recent_media: RecentMedia[]
  last_call_at: string | null
  // Direct chats only (null / [] in a group).
  contact: ContactInfo | null
  common_groups: CommonGroup[]
}

// -------------------------------------------------------------------- media

export interface MediaFileItem {
  // The chat message id — also what chatFileUrl() and "Show in chat" take.
  id: string
  kind: Exclude<MediaKind, 'links'>
  name: string
  type: string
  size: number
  created_at: string
  sender_id: string
  sender_name: string
  caption: string
  transcript: string | null
  meeting_id: string | null
  // Audio only. Voice notes and call recordings are both audio/webm; the server
  // tells them apart by the file name the client gave them when uploading.
  audio_kind?: 'voice-note' | 'call-recording' | 'audio'
}

export interface LinkItem {
  // `${message_id}:${n}` — a message can carry several links.
  id: string
  kind: 'links'
  message_id: string
  url: string
  domain: string
  text: string
  created_at: string
  sender_id: string
  sender_name: string
}

export type MediaItem = MediaFileItem | LinkItem

// `next` is an opaque cursor for the following page, null on the last one.
export interface MediaPage { items: MediaItem[]; next: string | null; counts: MediaCounts }

// ----------------------------------------------------------------- meetings

export type CallStatus = 'ringing' | 'active' | 'ended' | 'missed' | 'declined'

export interface CallRow {
  id: string
  kind: 'audio' | 'video'
  status: CallStatus
  started_at: string
  answered_at: string | null
  ended_at: string | null
  // Talk time: answered → ended (→ now while live). 0 for a call nobody answered.
  duration_sec: number
  started_by: PersonLite | null
  // Who actually joined. Who was rung is never stored, so an unanswered call
  // lists only the caller.
  participants: PersonLite[]
  // Meetings filed from this call. Usually zero or one; stopping a recording
  // mid-call and recording again files a second.
  meeting_ids: string[]
}

export interface TaskCounts { pending: number; approved: number; rejected: number; merged: number; total: number }

export interface MeetingRow {
  id: string
  title: string
  call_kind: 'audio' | 'video' | null
  source_type: string
  call_id: string | null
  created_at: string
  meeting_date: string
  engine: string
  executive_summary: string
  counts: { decisions: number; action_items: number; risks: number; blockers: number; follow_ups: number }
  tasks: TaskCounts
  participants: PersonLite[]
  uploaded_by: { id: string; name: string } | null
  // Whether this reader may review its tasks (see mayReview).
  can_review?: boolean
}

export interface MeetingsPayload {
  calls: CallRow[]
  meetings: MeetingRow[]
  // True when the conversation has more calls than the server returns at once.
  calls_truncated?: boolean
}

// One meeting, shaped like GET /api/meetings/:id so it can be handed straight
// to MeetingDetail's ReviewAssignModal. `transcript` is the text for people who
// were on the call (and managers), null for a member who was not — they get
// the summary, not every word.
export interface MeetingDetailPayload {
  id: string
  title: string
  call_kind: 'audio' | 'video' | null
  source_type: string
  call_id: string | null
  conversation_id: string
  created_at: string
  meeting_date: string
  engine: string
  description: string
  uploaded_by: string | null
  uploaded_by_name: string | null
  summary: {
    executive_summary?: string
    key_decisions?: unknown[]
    action_items?: unknown[]
    risks?: unknown[]
    blockers?: unknown[]
    follow_ups?: unknown[]
  }
  participants: (PersonLite & { role?: string })[]
  suggestions: Suggestion[]
  tasks: {
    id: string
    title: string
    status: string
    priority: string
    due_date: string | null
    assignee_id: string | null
    assignee_name: string | null
    assigned_by_name: string | null
  }[]
  call: { id: string; kind: 'audio' | 'video'; status: CallStatus; started_at: string; ended_at: string | null; duration_sec: number } | null
  transcript?: string | null
  can_review?: boolean
}

// ---------------------------------------------------------------- endpoints

export const chatInfoApi = {
  info: (convId: string): Promise<ChatInfo> => api.get(`/chat/conversations/${convId}/info`),
  media: (convId: string, kind: MediaKind, before?: string | null, limit = 60): Promise<MediaPage> =>
    api.get(`/chat/conversations/${convId}/media?kind=${kind}&limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`),
  meetings: (convId: string): Promise<MeetingsPayload> => api.get(`/chat/conversations/${convId}/meetings`),
  meeting: (convId: string, meetingId: string): Promise<MeetingDetailPayload> =>
    api.get(`/chat/conversations/${convId}/meetings/${meetingId}`),
}

// A file's bytes. <img>, <video> and <audio> cannot send an Authorization
// header, so the token rides in the query string, as everywhere else in the
// app. Unlike Chats' local fileUrl this includes API_BASE, which is what makes
// it work in the Android build, where the page is served from http://localhost
// and the API lives elsewhere. Never copy this URL anywhere a person could
// share it: it carries their session.
export const chatFileUrl = (messageId: string, download = false) =>
  `${API_BASE}/api/chat/file/${messageId}?token=${encodeURIComponent(getToken() || '')}${download ? '&download=1' : ''}`

// --------------------------------------------------------------- formatting

// 'Today' / 'Yesterday' / '29 Sep 2026', in the viewer's own calendar.
export function fmtDay(iso: string) {
  const d = new Date(iso), today = new Date(), yest = new Date()
  yest.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yest.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function fmtClock(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

// Talk time the way a person says it: '45s', '4 min', '1 h 5 min'.
export function fmtDuration(sec: number) {
  if (!sec || sec < 1) return ''
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}

// Section headers for media and call lists, the way WhatsApp groups them.
export function periodLabel(iso: string, now = new Date()) {
  const d = new Date(iso)
  const days = (now.getTime() - d.getTime()) / 86400000
  if (days < 7 && d <= now) return 'This week'
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 'This month'
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

// Consecutive runs with the same label, order preserved — the input is already
// newest-first, so this never has to sort.
export function groupRuns<T>(items: T[], label: (t: T) => string): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = []
  for (const it of items) {
    const l = label(it)
    const last = out[out.length - 1]
    if (last && last.label === l) last.items.push(it)
    else out.push({ label: l, items: [it] })
  }
  return out
}

// 'Employee 2' before 'Employee 10'.
export const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare

// The extension as a short badge ('PDF', 'XLSX'); 'FILE' when there is none.
export function fileExt(name: string) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '')
  return m ? m[1].toUpperCase() : 'FILE'
}

export function lastSeenText(iso?: string | null) {
  if (!iso) return ''
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'last seen just now'
  if (s < 3600) return `last seen ${Math.floor(s / 60)} min ago`
  const day = fmtDay(iso)
  return `last seen ${day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : day} at ${fmtClock(iso)}`
}
