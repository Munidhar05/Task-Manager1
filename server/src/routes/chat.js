import { Router } from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { db } from '../db.js'
import { authRequired, requireRole, verifyToken } from '../auth.js'
import { id, now, notify, audit } from '../util.js'
import { pushToUser, getOnlineUsers, onUserOnline } from '../ws/chatHub.js'
import { indexChatMessage, removeEmbedding } from '../ai/ragIndex.js'
import { transcribeAudio } from '../ai/transcribe.js'
import { analyzeMeetingTranscript } from '../ai/extractor.js'
import { persistMeeting, attendeesFor, createTaskFromSuggestion } from './meetings.js'
import { parseDueDate } from '../ai/dates.js'
import { detectPriority, restateRuleSummary } from '../ai/rules.js'
import { linkPreview } from '../chatLinkPreview.js'

// Internal team chat (WhatsApp-style): 1:1 + group conversations, file attachments,
// real-time delivery, replies (also privately, from a group), reactions, stars,
// edit, delete for me / for everyone, sent-delivered-read ticks with Message
// info, polls, locations, contacts, group events and admin settings, archive —
// plus the two things WhatsApp cannot do: a message becomes an assigned task
// without leaving the chat, and a call becomes a summary with its tasks
// already assigned.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'chat_uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const MB = 1024 * 1024
// A file sent in a chat can be up to 1 GB. It streams straight to disk, so the
// size costs disk and never memory.
const CHAT_FILE_MAX = 1024 * MB
// That disk also holds the SQLite database. A file that fills it does not just
// fail to send — every later write in the app fails with it — so a file is only
// let in if this much is still free once it lands.
const DISK_HEADROOM = 200 * MB
// Bytes promised to uploads still streaming in, so two big files that each fit
// on their own cannot both be let into room only one of them has.
let reserved = 0

// multer's own diskStorage pipes the part into the file and stops there: a
// sender who drops out mid-file leaves the write stream open and the half-file
// on disk for good. At 1 GB over a phone connection that is the common case,
// not the rare one, so this does the same job and closes and removes the scrap
// when the request goes away unfinished.
const storage = {
  _handleFile(req, file, cb) {
    const filename = id('cf') + path.extname(file.originalname || '').slice(0, 12)
    const abs = path.join(UPLOAD_DIR, filename)
    const out = fs.createWriteStream(abs)
    const abandon = () => { if (!req.complete) out.destroy(new Error('Upload abandoned')) }
    req.once('close', abandon)
    pipeline(file.stream, out, (err) => {
      req.off('close', abandon)
      if (err) { fs.unlink(abs, () => {}); return cb(err) }
      cb(null, { destination: UPLOAD_DIR, filename, path: abs, size: out.bytesWritten })
    })
  },
  _removeFile(req, file, cb) { fs.unlink(file.path, () => cb(null)) },
}
// +1 because busboy counts reaching the limit as going over it, and a file of
// exactly 1 GB is one the app says it takes.
const upload = multer({ storage, limits: { fileSize: CHAT_FILE_MAX + 1 } })
// A group photo and a piece of call audio keep the old ceiling: one is only
// ever a picture, the other is read whole into memory to be transcribed.
const smallUpload = multer({ storage, limits: { fileSize: 15 * MB } })

const freeBytes = () => {
  try { const s = fs.statfsSync(UPLOAD_DIR); return s.bavail * s.bsize } catch { return Infinity }
}

const TOO_BIG = 'File too large (max 1 GB)'
const NO_ROOM = 'The server is out of storage space for a file this size'
// [status, message] if this many bytes cannot come in right now, else null.
// The MB of slack is the multipart wrapping around the file itself.
const refusalFor = (len) => (len > CHAT_FILE_MAX + MB ? [413, TOO_BIG]
  : len && freeBytes() - reserved - len < DISK_HEADROOM ? [507, NO_ROOM] : null)

// The 1 GB route's way in. Content-Length is the whole form, so a file that is
// over the limit, or that the disk has no room for, is turned away before a
// byte of it is written, and the connection closed so the rest is not sent
// for nothing. The sender's browser will not read that answer mid-upload — it
// sees a dropped connection — which is why the app asks GET /upload-room
// first. multer's own errors come back as a status, not the global 500.
function receiveChatFile(req, res, next) {
  const len = Number(req.headers['content-length']) || 0
  const refuse = (status, error) => { if (!res.headersSent) res.status(status).set('Connection', 'close').json({ error }) }
  const no = refusalFor(len)
  if (no) return refuse(...no)
  reserved += len
  let gone = false
  res.once('close', () => { reserved -= len; if (!res.writableFinished) gone = true })
  upload.single('file')(req, res, (err) => {
    if (!err) return next()
    if (gone) return // the sender left; storage has already removed the half-file
    if (err.code === 'LIMIT_FILE_SIZE') return refuse(413, TOO_BIG)
    if (err.code === 'ENOSPC') return refuse(507, NO_ROOM)
    next(err)
  })
}

// Transcription reads the whole recording into memory, and the providers cap
// what they take anyway (Whisper: 25 MB) — the same ceiling as a meeting
// upload. Now that a chat file can be 1 GB, an audio file that size has to be
// turned away here rather than read onto a 512 MB instance.
const TRANSCRIBE_MAX = 25 * MB
function readForTranscription(abs) {
  if (fs.statSync(abs).size > TRANSCRIBE_MAX) {
    const err = new Error('This recording is over 25 MB, too long to turn into text.')
    err.code = 'TOO_LARGE'
    throw err
  }
  return fs.readFileSync(abs)
}

const r = Router()

// ---------- helpers ----------
const member = (convId, userId) => db.prepare('SELECT * FROM chat_participants WHERE conversation_id=? AND user_id=?').get(convId, userId)
const participantsOf = (convId) => db.prepare('SELECT user_id FROM chat_participants WHERE conversation_id=?').all(convId).map((p) => p.user_id)

// Push a payload to every participant of a conversation (optionally excluding one).
function pushToConversation(convId, payload, exceptUserId = null) {
  for (const uid of participantsOf(convId)) if (uid !== exceptUserId) pushToUser(uid, payload)
}

// Touch a conversation's updated_at so it floats to the top of lists.
const touchConvo = (convId) => db.prepare('UPDATE chat_conversations SET updated_at=? WHERE id=?').run(now(), convId)

// Mentions for a set of message ids → { messageId: [{id, name}] }. The join to
// users is what keeps a mention chip reading the CURRENT name after someone is
// renamed, rather than whatever was typed months ago.
function mentionsByMessage(ids) {
  if (!ids.length) return {}
  const rows = db.prepare(`
    SELECT mn.message_id, u.id, u.name FROM chat_mentions mn
    JOIN users u ON u.id=mn.user_id
    WHERE mn.message_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
  const out = {}
  for (const row of rows) (out[row.message_id] ||= []).push({ id: row.id, name: row.name })
  return out
}

// Record the @mentions on a message. Only real participants of the conversation
// count — a mention is a notification, so accepting an arbitrary id from the
// client would let anyone ping a teammate who cannot even see the thread.
function saveMentions(convId, messageId, rawIds, senderId) {
  const ids = [...new Set((Array.isArray(rawIds) ? rawIds : []).map(String))]
  if (!ids.length) return []
  const allowed = new Set(participantsOf(convId))
  const valid = ids.filter((u) => allowed.has(u) && u !== senderId)
  const ts = now()
  for (const uid of valid) {
    db.prepare('INSERT OR IGNORE INTO chat_mentions (message_id, conversation_id, user_id, created_at) VALUES (?,?,?,?)')
      .run(messageId, convId, uid, ts)
  }
  return valid
}

// Reactions for a set of message ids → { messageId: [{emoji, user_id}] }
function reactionsByMessage(ids) {
  if (!ids.length) return {}
  const ph = ids.map(() => '?').join(',')
  const rows = db.prepare(`SELECT message_id, user_id, emoji FROM chat_reactions WHERE message_id IN (${ph})`).all(...ids)
  const out = {}
  for (const row of rows) (out[row.message_id] ||= []).push({ emoji: row.emoji, user_id: row.user_id })
  return out
}

const parseMeta = (row) => { try { return row?.meta ? JSON.parse(row.meta) : {} } catch { return {} } }
const nameOf = (uid) => db.prepare('SELECT name FROM users WHERE id=?').get(uid)?.name || 'Someone'

// A group event line, worded for whoever reads it: "You added Ravi" to Priya,
// "Priya added you" to Ravi — WhatsApp's own wording. Built at read time from
// ids, so a teammate renamed since reads under their current name.
function systemText(meta, viewerId) {
  const who = (uid) => (uid === viewerId ? 'You' : nameOf(uid))
  const whom = (uid) => (uid === viewerId ? 'you' : nameOf(uid))
  const list = (ids = []) => {
    const n = ids.map(whom)
    return n.length <= 1 ? (n[0] || '') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
  }
  const a = who(meta.actor)
  switch (meta.action) {
    case 'created': return `${a} created group "${meta.name || ''}"`
    case 'added': return `${a} added ${list(meta.targets)}`
    case 'removed': return `${a} removed ${list(meta.targets)}`
    case 'left': return `${a} left`
    case 'joined': return `${a} joined`
    case 'renamed': return `${a} changed the group name from "${meta.from || ''}" to "${meta.to || ''}"`
    case 'photo': return `${a} changed this group's icon`
    case 'description': return meta.to ? `${a} changed the group description` : `${a} deleted the group description`
    case 'admins_only': return meta.on
      ? `${a} changed this group's settings to allow only admins to send messages`
      : `${a} changed this group's settings to allow all members to send messages`
    case 'visibility': return meta.to === 'public' ? `${a} opened this group to everyone in the workspace` : `${a} made this group private`
    case 'admin': return meta.on ? `${a} made ${list(meta.targets)} a group admin` : `${a} dismissed ${list(meta.targets)} as admin`
    default: return ''
  }
}

// One-line preview of a message for reply quotes / conversation lists, in
// WhatsApp's words ("📷 Photo", "🎤 Voice message"). viewerId only changes
// whose voice a group event is told in, and "You deleted this message".
function snippet(row, viewerId = null) {
  if (!row) return ''
  if (row.deleted_for_all) return row.sender_id === viewerId ? 'You deleted this message' : 'This message was deleted'
  if (row.kind === 'system') return systemText(parseMeta(row), viewerId)
  if (row.kind === 'poll') return '📊 ' + (row.body || 'Poll')
  if (row.kind === 'task') return '📋 ' + (row.body || 'Task')
  if (row.kind === 'location') return '📍 ' + (row.body || 'Location')
  if (row.kind === 'contact') return '👤 ' + (row.body || 'Contact')
  if (row.meeting_id) return '📝 ' + (row.body || 'Call summary')
  if (row.file_stored || row.file_name) {
    const t = row.file_type || ''
    if (t.startsWith('audio/')) return '🎤 Voice message'
    if (t.startsWith('image/')) return '📷 ' + (row.body || 'Photo')
    if (t.startsWith('video/')) return '🎥 ' + (row.body || 'Video')
    return '📄 ' + (row.file_name || 'Document')
  }
  return row.body || ''
}

// ---------- ticks: sent ✓, delivered ✓✓, read (blue) ✓✓ ----------
// Read position for receipts: read_receipt_at only ever moves forward (see
// db.js); rows from before it existed fall back to last_read_at. Reading
// implies delivery, so the delivered position is never behind the read one.
// Someone added to a group counts as having read everything from before they
// joined (they were never sent it) — without that fallback a new member's
// empty position turned every earlier blue tick in the group grey again.
const readPos = (p) => p.read_receipt_at || p.last_read_at || p.joined_at || null
const deliveredPos = (p) => {
  const r = readPos(p), d = p.last_delivered_at || null
  return !r ? d : !d ? r : (d > r ? d : r)
}
const oldest = (vals) => (!vals.length || vals.some((v) => !v)) ? null : vals.reduce((m, v) => (v < m ? v : m))

// Everyone else's positions, from the viewer's side. A message of mine is
// delivered once it is older than ALL of their delivered positions and read
// once it is older than all of their read ones — WhatsApp's rule in a group:
// blue only when everyone has read it.
function receiptCtx(convId, viewerId) {
  const others = db.prepare('SELECT last_read_at, read_receipt_at, last_delivered_at, joined_at FROM chat_participants WHERE conversation_id=? AND user_id!=?').all(convId, viewerId)
  if (!others.length) return { othersMinRead: null, othersMinDelivered: null }
  return { othersMinRead: oldest(others.map(readPos)), othersMinDelivered: oldest(others.map(deliveredPos)) }
}

// Tell each participant where everyone else now is, so the ticks on their own
// messages change colour without a reload. Each one gets their own numbers —
// "everyone else" is a different set for every reader.
function pushReceipts(convId) {
  for (const uid of participantsOf(convId)) {
    const c = receiptCtx(convId, uid)
    pushToUser(uid, { type: 'receipts', conversationId: convId, read_upto: c.othersMinRead, delivered_upto: c.othersMinDelivered })
  }
}

// Something from someone else newer than `since` — the only case in which a
// position moving forward means anything to a sender, and so the only case
// worth a row in chat_receipt_marks.
const newerFromOthers = (convId, userId, since) =>
  !!db.prepare('SELECT 1 FROM chat_messages WHERE conversation_id=? AND sender_id!=? AND created_at>? LIMIT 1').get(convId, userId, since || '')

function markDelivered(convId, userId, ts = now()) {
  const p = db.prepare('SELECT last_read_at, read_receipt_at, last_delivered_at, joined_at FROM chat_participants WHERE conversation_id=? AND user_id=?').get(convId, userId)
  if (!p || !newerFromOthers(convId, userId, deliveredPos(p))) return false
  db.prepare('UPDATE chat_participants SET last_delivered_at=? WHERE conversation_id=? AND user_id=?').run(ts, convId, userId)
  db.prepare('INSERT INTO chat_receipt_marks (conversation_id, user_id, kind, at) VALUES (?,?,?,?)').run(convId, userId, 'd', ts)
  return true
}

// Reading a conversation: the unread cursor moves (and a manual "unread" flag
// clears) every time, the receipt positions only ever forward.
function markRead(convId, userId, ts = now()) {
  const p = db.prepare('SELECT last_read_at, read_receipt_at, last_delivered_at, joined_at FROM chat_participants WHERE conversation_id=? AND user_id=?').get(convId, userId)
  if (!p) return false
  const fresh = newerFromOthers(convId, userId, readPos(p))
  db.prepare('UPDATE chat_participants SET last_read_at=?, marked_unread=0 WHERE conversation_id=? AND user_id=?').run(ts, convId, userId)
  if (!fresh) return false
  db.prepare('UPDATE chat_participants SET read_receipt_at=?, last_delivered_at=? WHERE conversation_id=? AND user_id=?').run(ts, ts, convId, userId)
  db.prepare('INSERT INTO chat_receipt_marks (conversation_id, user_id, kind, at) VALUES (?,?,?,?)').run(convId, userId, 'r', ts)
  return true
}

// A device of theirs is in touch (a socket opened, or the app polled for its
// badge): everything waiting for them has now been delivered.
function deliverPending(userId) {
  const rows = db.prepare(`
    SELECT p.conversation_id FROM chat_participants p
    WHERE p.user_id=? AND EXISTS (
      SELECT 1 FROM chat_messages m WHERE m.conversation_id=p.conversation_id AND m.sender_id!=?
        AND m.created_at > COALESCE(p.last_delivered_at, p.read_receipt_at, p.last_read_at, p.joined_at, ''))`).all(userId, userId)
  const ts = now()
  for (const r0 of rows) if (markDelivered(r0.conversation_id, userId, ts)) pushReceipts(r0.conversation_id)
}
onUserOnline(deliverPending)

// ---------- polls, task cards, contacts ----------
function pollOf(messageId) {
  const p = db.prepare('SELECT options, multi FROM chat_polls WHERE message_id=?').get(messageId)
  if (!p) return null
  let labels = []
  try { labels = JSON.parse(p.options) } catch {}
  const votes = db.prepare('SELECT user_id, option_idx FROM chat_poll_votes WHERE message_id=? ORDER BY created_at').all(messageId)
  return {
    multi: !!p.multi,
    options: labels.map((text, i) => ({ text, voters: votes.filter((v) => v.option_idx === i).map((v) => v.user_id) })),
  }
}

// A task assigned from the chat, read live from the tasks table so the card
// shows where the work is NOW (In Progress, Done) rather than how it began. A
// task deleted since leaves a card that says so instead of a broken link.
function taskCard(taskId) {
  if (!taskId) return null
  const t = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.due_date, t.assignee_id,
           u.name AS assignee_name, u.avatar_color AS assignee_color, u.avatar_file AS assignee_avatar
    FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.id=?`).get(taskId)
  return t || { id: taskId, deleted: true }
}

function contactCard(userId) {
  const u = userId && db.prepare('SELECT id, name, email, role, avatar_color, avatar_file FROM users WHERE id=?').get(userId)
  return u || null
}

// Shape a message row for the client (viewer-specific: starred, reactions, ticks).
function shapeMessage(row, viewerId, ctx = {}) {
  const base = { id: row.id, conversation_id: row.conversation_id, sender_id: row.sender_id, created_at: row.created_at }
  if (row.deleted_for_all) return { ...base, deleted: true, body: '' }
  const reactions = (ctx.reactions && ctx.reactions[row.id]) || []
  let replyPreview = null
  if (row.reply_to) {
    const rep = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(row.reply_to)
    if (rep) {
      // Quoted from another chat ("Reply privately" to a group message): say which.
      const elsewhere = rep.conversation_id !== row.conversation_id
      const from = elsewhere ? db.prepare('SELECT type, name FROM chat_conversations WHERE id=?').get(rep.conversation_id) : null
      replyPreview = {
        id: rep.id, sender_id: rep.sender_id, sender_name: nameOf(rep.sender_id), text: snippet(rep, viewerId),
        image: !rep.deleted_for_all && !!rep.file_stored && (rep.file_type || '').startsWith('image/'),
        conversation_id: rep.conversation_id,
        from: from && from.type === 'group' ? (from.name || 'Group') : null,
      }
    }
  }
  // My own messages: delivered to / read by everyone else yet?
  let seen = false, delivered = false
  if (row.sender_id === viewerId) {
    if (ctx.othersMinRead !== undefined) seen = ctx.othersMinRead !== null && ctx.othersMinRead >= row.created_at
    if (ctx.othersMinDelivered !== undefined) delivered = seen || (ctx.othersMinDelivered !== null && ctx.othersMinDelivered >= row.created_at)
  }
  const meta = row.kind ? parseMeta(row) : {}
  return {
    ...base,
    body: row.body,
    kind: row.kind || null,
    edited_at: row.edited_at || null,
    forwarded: !!row.forwarded,
    reply_to: row.reply_to || null,
    reply: replyPreview,
    file: row.file_stored ? { name: row.file_name, type: row.file_type, size: row.file_size } : null,
    reactions,
    mentions: ctx.mentions ? (ctx.mentions[row.id] || []) : (mentionsByMessage([row.id])[row.id] || []),
    starred: ctx.stars ? ctx.stars.has(row.id) : false,
    pinned_at: row.pinned_at || null,
    transcript: row.transcript || null,
    call: row.call_id ? callSummary(row.call_id) : null,
    meeting: row.meeting_id ? meetingCard(row.meeting_id) : null,
    system: row.kind === 'system' ? systemText(meta, viewerId) : null,
    poll: row.kind === 'poll' ? pollOf(row.id) : null,
    task: row.kind === 'task' ? taskCard(row.task_id) : null,
    location: row.kind === 'location' ? { lat: meta.lat, lng: meta.lng, label: meta.label || '', accuracy: meta.accuracy || null } : null,
    contact: row.kind === 'contact' ? contactCard(meta.user_id) : null,
    seen,
    delivered,
  }
}

// The summary card a finished, transcribed call leaves in the thread — with
// the tasks it has already handed out, by name, so everyone who was on the
// call can see who walked away with what without opening anything.
function meetingCard(meetingId) {
  const m = db.prepare('SELECT id, title, summary_json, engine FROM meetings WHERE id=?').get(meetingId)
  if (!m) return null
  let exec = ''
  let counts = { decisions: 0, risks: 0, blockers: 0 }
  try {
    const s = JSON.parse(m.summary_json || '{}')
    // Restated as on the Meetings page: an old rule-based summary says
    // "3 assigned" about suggestions nobody had approved.
    exec = restateRuleSummary(String(s.executive_summary || ''))
    counts = {
      decisions: (s.key_decisions || []).length,
      risks: (s.risks || []).length,
      blockers: (s.blockers || []).length,
    }
  } catch {}
  const tasks = db.prepare("SELECT COUNT(*) c FROM suggested_tasks WHERE meeting_id=? AND status='pending'").get(meetingId).c
  const assigned = db.prepare(`
    SELECT s.title, s.created_task_id AS task_id, s.suggested_assignee_id AS assignee_id, u.name AS assignee_name
    FROM suggested_tasks s LEFT JOIN users u ON u.id=s.suggested_assignee_id
    WHERE s.meeting_id=? AND s.status='approved' ORDER BY s.created_at`).all(meetingId)
  return { id: m.id, title: m.title, summary: exec, engine: m.engine, tasks, assigned, ...counts }
}

// The ledger line a finished call leaves in the thread.
function callSummary(callId) {
  const c = db.prepare('SELECT * FROM chat_calls WHERE id=?').get(callId)
  if (!c) return null
  const joined = db.prepare('SELECT COUNT(*) n FROM chat_call_participants WHERE call_id=? AND joined_at IS NOT NULL').get(callId).n
  const secs = c.answered_at && c.ended_at
    ? Math.max(0, Math.round((new Date(c.ended_at) - new Date(c.answered_at)) / 1000))
    : 0
  return { id: c.id, kind: c.kind, status: c.status, started_by: c.started_by, duration_sec: secs, joined }
}

// Find or create the direct conversation between two users in the same org.
function findOrCreateDirect(orgId, a, b) {
  const row = db.prepare(`
    SELECT c.id FROM chat_conversations c
    JOIN chat_participants p1 ON p1.conversation_id=c.id AND p1.user_id=?
    JOIN chat_participants p2 ON p2.conversation_id=c.id AND p2.user_id=?
    WHERE c.type='direct'
      AND (SELECT COUNT(*) FROM chat_participants p WHERE p.conversation_id=c.id)=2
    LIMIT 1`).get(a, b)
  if (row) return row.id
  const cid = id('cv')
  const ts = now()
  db.prepare('INSERT INTO chat_conversations (id, org_id, type, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(cid, orgId, 'direct', a, ts, ts)
  for (const uid of [a, b]) db.prepare('INSERT OR IGNORE INTO chat_participants (conversation_id, user_id, role, last_read_at, joined_at) VALUES (?,?,?,?,?)').run(cid, uid, 'member', ts, ts)
  return cid
}

// Build the client-facing summary of one conversation for the list view.
function summarizeConvo(conv, viewerId) {
  const parts = db.prepare(`
    SELECT u.id, u.name, u.avatar_color, u.avatar_file, u.role, u.last_seen, u.status_text, u.status_emoji, u.dnd_until, p.role AS member_role
    FROM chat_participants p JOIN users u ON u.id=p.user_id WHERE p.conversation_id=?`).all(conv.id)
  const me = db.prepare('SELECT last_read_at, muted, pinned, muted_until, archived, marked_unread, removed_at FROM chat_participants WHERE conversation_id=? AND user_id=?').get(conv.id, viewerId)
  const last = db.prepare(`
    SELECT * FROM chat_messages WHERE conversation_id=?
      AND id NOT IN (SELECT message_id FROM chat_message_hidden WHERE user_id=?)
    ORDER BY created_at DESC LIMIT 1`).get(conv.id, viewerId)
  // Group event lines ("Ravi joined") are not something to catch up on, so
  // they never count as unread — as in WhatsApp.
  const unread = db.prepare(`
    SELECT COUNT(*) c FROM chat_messages
    WHERE conversation_id=? AND sender_id!=? AND deleted_for_all=0
      AND COALESCE(kind,'')<>'system'
      AND created_at > ?
      AND id NOT IN (SELECT message_id FROM chat_message_hidden WHERE user_id=?)`)
    .get(conv.id, viewerId, me?.last_read_at || '', viewerId).c
  const others = parts.filter((p) => p.id !== viewerId)
  const isGroup = conv.type === 'group'
  const lastSender = last ? parts.find((p) => p.id === last.sender_id) : null
  // The ticks beside "You: …" in the list.
  const lastMine = !!last && last.sender_id === viewerId && !last.deleted_for_all && last.kind !== 'system' && !last.call_id && !last.meeting_id
  const rc = lastMine ? receiptCtx(conv.id, viewerId) : null
  const lastSeen = !!rc && rc.othersMinRead !== null && rc.othersMinRead >= last.created_at
  const lastDelivered = lastSeen || (!!rc && rc.othersMinDelivered !== null && rc.othersMinDelivered >= last.created_at)
  return {
    id: conv.id,
    type: conv.type,
    name: isGroup ? (conv.name || 'Group') : (others[0]?.name || 'Unknown'),
    avatar_color: isGroup ? conv.avatar_color : (others[0]?.avatar_color || '#6366f1'),
    avatar_file: isGroup ? (conv.avatar_file || null) : (others[0]?.avatar_file || null),
    other_user_id: isGroup ? null : (others[0]?.id || null),
    other_last_seen: isGroup ? null : (others[0]?.last_seen || null),
    member_count: parts.length,
    members: parts.map((p) => ({ id: p.id, name: p.name, avatar_color: p.avatar_color, avatar_file: p.avatar_file || null, role: p.member_role, job_role: p.role, status_text: p.status_text || '', status_emoji: p.status_emoji || '', dnd_until: p.dnd_until || null })),
    role: me ? (parts.find((p) => p.id === viewerId)?.member_role) : 'member',
    visibility: conv.visibility || 'private',
    description: conv.description || '',
    admins_only: !!conv.admins_only,
    created_by: conv.created_by || null,
    created_at: conv.created_at,
    muted: !!me?.muted && (!me?.muted_until || me.muted_until > now()),
    muted_until: me?.muted_until || null,
    pinned: !!me?.pinned,
    archived: !!me?.archived,
    marked_unread: !!me?.marked_unread,
    // Deleted from my list, and nothing newer has arrived since.
    removed: !!me?.removed_at && (!last || last.created_at <= me.removed_at),
    last_message: last ? snippet(last, viewerId) : null,
    last_kind: last ? (last.kind || (last.call_id ? 'call' : last.meeting_id ? 'meeting' : null)) : null,
    last_sender_name: lastSender ? lastSender.name : null,
    last_from_me: last ? last.sender_id === viewerId && last.kind !== 'system' : false,
    last_seen: lastSeen,
    last_delivered: lastDelivered,
    last_at: last?.created_at || conv.updated_at,
    unread,
  }
}

// ---------- file download (token in header OR ?token= so <img>/<a> work) ----------
r.get('/file/:messageId', (req, res) => {
  const user = (req.headers.authorization || '').startsWith('Bearer ')
    ? verifyToken(req.headers.authorization.slice(7))
    : verifyToken(req.query.token)
  if (!user) return res.status(401).json({ error: 'Authentication required' })
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.messageId)
  if (!m || !m.file_stored || m.deleted_for_all) return res.status(404).json({ error: 'File not found' })
  if (!member(m.conversation_id, user.id)) return res.status(403).json({ error: 'Forbidden' })
  const abs = path.join(UPLOAD_DIR, m.file_stored)
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File missing' })
  if (m.file_type) res.type(m.file_type)
  const dl = req.query.download === '1' ? 'attachment' : 'inline'
  res.setHeader('Content-Disposition', `${dl}; filename="${encodeURIComponent(m.file_name || 'file')}"`)
  // sendFile, not a bare stream, for the Content-Length and byte ranges: a big
  // video can be seeked, and a phone recording keeps its index at the end of
  // the file — without ranges the player downloads all of it just to show its
  // length. Dotfiles allowed because the path is ours, not the requester's.
  res.sendFile(abs, { cacheControl: false, dotfiles: 'allow' })
})

// Group photo (token via header or ?token= for <img>).
r.get('/conversations/:id/avatar', (req, res) => {
  const user = (req.headers.authorization || '').startsWith('Bearer ')
    ? verifyToken(req.headers.authorization.slice(7)) : verifyToken(req.query.token)
  if (!user) return res.status(401).json({ error: 'Authentication required' })
  const conv = db.prepare('SELECT avatar_file FROM chat_conversations WHERE id=?').get(req.params.id)
  if (!conv?.avatar_file) return res.status(404).json({ error: 'No avatar' })
  if (!member(req.params.id, user.id)) return res.status(403).json({ error: 'Forbidden' })
  const abs = path.join(UPLOAD_DIR, conv.avatar_file)
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Missing' })
  const ext = path.extname(conv.avatar_file); if (ext) res.type(ext)
  res.setHeader('Cache-Control', 'private, max-age=300')
  fs.createReadStream(abs).pipe(res)
})

r.use(authRequired)

// ---------- users available to chat / add to groups ----------
r.get('/users', (req, res) => {
  const rows = db.prepare('SELECT id, name, email, role, avatar_color, avatar_file, status_text, status_emoji, dnd_until FROM users WHERE org_id=? AND id!=? ORDER BY name').all(req.user.org_id, req.user.id)
  res.json({ users: rows })
})

// Who is currently online (has a live WebSocket connection).
r.get('/presence', (req, res) => res.json({ online: getOnlineUsers() }))

// ---------- conversations ----------
r.get('/conversations', (req, res) => {
  const me = req.user
  deliverPending(me.id)
  const convs = db.prepare(`
    SELECT c.* FROM chat_conversations c
    JOIN chat_participants p ON p.conversation_id=c.id
    WHERE p.user_id=? AND c.org_id=?`).all(me.id, me.org_id)
  const list = convs.map((c) => summarizeConvo(c, me.id)).filter((c) => !c.removed)
  list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.last_at || '').localeCompare(a.last_at || ''))
  res.json({ conversations: list })
})

// Total unread across conversations (nav badge). Polled every few seconds by
// every open copy of the app, which also makes it the moment messages count as
// delivered to this person. Archived chats stay quiet, as WhatsApp keeps them.
r.get('/unread', (req, res) => {
  deliverPending(req.user.id)
  const convs = db.prepare('SELECT c.id, p.last_read_at FROM chat_conversations c JOIN chat_participants p ON p.conversation_id=c.id WHERE p.user_id=? AND COALESCE(p.archived,0)=0').all(req.user.id)
  let unread = 0
  for (const c of convs) {
    unread += db.prepare(`
      SELECT COUNT(*) c FROM chat_messages
      WHERE conversation_id=? AND sender_id!=? AND deleted_for_all=0 AND created_at > ?
        AND COALESCE(kind,'')<>'system'
        AND id NOT IN (SELECT message_id FROM chat_message_hidden WHERE user_id=?)`)
      .get(c.id, req.user.id, c.last_read_at || '', req.user.id).c
  }
  res.json({ unread })
})

// Create a conversation: direct ({type:'direct', userId}) or group ({type:'group', name, memberIds}).
r.post('/conversations', (req, res) => {
  const me = req.user
  const { type } = req.body || {}
  if (type === 'direct') {
    const other = db.prepare('SELECT id FROM users WHERE id=? AND org_id=?').get(req.body.userId, me.org_id)
    if (!other || other.id === me.id) return res.status(400).json({ error: 'Invalid user' })
    const cid = findOrCreateDirect(me.org_id, me.id, other.id)
    // Opening the chat on purpose brings back one I deleted (empty — what was
    // in it stays cleared), rather than leaving it hidden until they write.
    db.prepare('UPDATE chat_participants SET removed_at=NULL WHERE conversation_id=? AND user_id=?').run(cid, me.id)
    return res.status(201).json(summarizeConvo(db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(cid), me.id))
  }
  if (type === 'group') {
    // Groups are an org structure, not a personal one: a channel that everyone
    // could spin up drifts into dozens of half-dead rooms. Managers and admins
    // create them; anyone can be added to one and talk in it. Enforced here and
    // not only in the UI, because the UI is not a permission.
    if (me.role !== 'manager' && me.role !== 'admin') return res.status(403).json({ error: 'Only managers can create groups' })
    const name = String(req.body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Group name required' })
    const ids = Array.isArray(req.body.memberIds) ? req.body.memberIds : []
    const valid = db.prepare(`SELECT id FROM users WHERE org_id=? AND id IN (${ids.map(() => '?').join(',') || "''"})`).all(me.org_id, ...ids).map((u) => u.id)
    // A public channel may legitimately start empty — anyone can walk in. A
    // private group with nobody in it is just a note to self.
    if (!valid.length && req.body.visibility !== 'public') return res.status(400).json({ error: 'Add at least one member' })
    const cid = id('cv')
    const ts = now()
    const colors = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#06b6d4']
    const visibility = req.body.visibility === 'public' ? 'public' : 'private'
    db.prepare('INSERT INTO chat_conversations (id, org_id, type, name, avatar_color, created_by, visibility, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(cid, me.org_id, 'group', name, colors[name.length % colors.length], me.id, visibility, ts, ts)
    db.prepare('INSERT INTO chat_participants (conversation_id, user_id, role, last_read_at, joined_at) VALUES (?,?,?,?,?)').run(cid, me.id, 'admin', ts, ts)
    for (const uid of valid) if (uid !== me.id) db.prepare('INSERT OR IGNORE INTO chat_participants (conversation_id, user_id, role, last_read_at, joined_at) VALUES (?,?,?,?,?)').run(cid, uid, 'member', null, ts)
    const desc = String(req.body.description || '').trim().slice(0, 500)
    if (desc) db.prepare('UPDATE chat_conversations SET description=? WHERE id=?').run(desc, cid)
    postSystem(db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(cid), me.id, { action: 'created', name })
    pushToConversation(cid, { type: 'conversation', action: 'created', conversationId: cid })
    return res.status(201).json(summarizeConvo(db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(cid), me.id))
  }
  res.status(400).json({ error: 'type must be direct or group' })
})

// Conversation detail + messages (marks read for me).
//
// The newest PAGE messages, oldest first — not the oldest 800 as it used to
// be, which on a long chat meant the thread opened months in the past and
// today's messages never loaded at all. ?before=<iso> fetches the page before
// that point, for scrolling back (WhatsApp's endless scroll upwards); those
// requests leave the read position alone.
const PAGE = 300
r.get('/conversations/:id', (req, res) => {
  const me = req.user
  if (!member(req.params.id, me.id)) return res.status(404).json({ error: 'Conversation not found' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : null
  const prevRead = db.prepare('SELECT last_read_at FROM chat_participants WHERE conversation_id=? AND user_id=?').get(conv.id, me.id)?.last_read_at || null
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT * FROM chat_messages WHERE conversation_id=?
        AND id NOT IN (SELECT message_id FROM chat_message_hidden WHERE user_id=?)
        ${before ? 'AND created_at < ?' : ''}
      ORDER BY created_at DESC LIMIT ${PAGE + 1}
    ) ORDER BY created_at ASC`).all(conv.id, me.id, ...(before ? [before] : []))
  const hasMore = rows.length > PAGE
  if (hasMore) rows.shift()
  const ids = rows.map((m) => m.id)
  const reactions = reactionsByMessage(ids)
  const mentions = mentionsByMessage(ids)
  const stars = new Set(db.prepare(`SELECT message_id FROM chat_stars WHERE user_id=? AND message_id IN (${ids.map(() => '?').join(',') || "''"})`).all(me.id, ...ids).map((s) => s.message_id))
  if (before) {
    const ctx = { reactions, mentions, stars, ...receiptCtx(conv.id, me.id) }
    return res.json({ messages: rows.map((row) => shapeMessage(row, me.id, ctx)), has_more: hasMore })
  }
  // Read first, so the ticks computed below and the ones pushed to everyone
  // else agree on where I am.
  const ts = now()
  const moved = markRead(conv.id, me.id, ts)
  const ctx = { reactions, mentions, stars, ...receiptCtx(conv.id, me.id) }
  const messages = rows.map((row) => shapeMessage(row, me.id, ctx))
  pushToConversation(conv.id, { type: 'read', conversationId: conv.id, userId: me.id, last_read_at: ts }, me.id)
  if (moved) pushReceipts(conv.id)
  res.json({ conversation: summarizeConvo(conv, me.id), messages, last_read_at: prevRead, has_more: hasMore })
})

// Mute / pin / archive / mark unread (per-user preferences).
r.post('/conversations/:id/prefs', (req, res) => {
  if (!member(req.params.id, req.user.id)) return res.status(404).json({ error: 'Not found' })
  const sets = [], args = []
  if ('muted' in (req.body || {})) { sets.push('muted=?'); args.push(req.body.muted ? 1 : 0) }
  if ('pinned' in (req.body || {})) { sets.push('pinned=?'); args.push(req.body.pinned ? 1 : 0) }
  if ('archived' in (req.body || {})) { sets.push('archived=?'); args.push(req.body.archived ? 1 : 0) }
  // WhatsApp's "Mark as unread" on a whole chat: a dot on the row, no count,
  // gone the moment the chat is opened. The read position is left alone.
  if ('marked_unread' in (req.body || {})) { sets.push('marked_unread=?'); args.push(req.body.marked_unread ? 1 : 0) }
  // Mute "for 8 hours": store the expiry AND set the boolean, so every existing
  // muted check keeps working and the timer is what clears it.
  if ('mute_minutes' in (req.body || {})) {
    const mins = Number(req.body.mute_minutes || 0)
    sets.push('muted=?'); args.push(mins > 0 ? 1 : 0)
    sets.push('muted_until=?'); args.push(mins > 0 ? new Date(Date.now() + mins * 60000).toISOString() : null)
  }
  if (!sets.length) return res.json({ ok: true })
  args.push(req.params.id, req.user.id)
  db.prepare(`UPDATE chat_participants SET ${sets.join(', ')} WHERE conversation_id=? AND user_id=?`).run(...args)
  res.json({ ok: true })
})

// Clear chat: hide every current message in this conversation for me only
// (the other participants keep their copies). New messages still arrive.
r.post('/conversations/:id/clear', (req, res) => {
  const me = req.user
  if (!member(req.params.id, me.id)) return res.status(404).json({ error: 'Not found' })
  const ids = db.prepare('SELECT id FROM chat_messages WHERE conversation_id=?').all(req.params.id)
  const ins = db.prepare('INSERT OR IGNORE INTO chat_message_hidden (message_id, user_id) VALUES (?,?)')
  db.transaction(() => { for (const m of ids) ins.run(m.id, me.id) })()
  db.prepare('UPDATE chat_participants SET last_read_at=? WHERE conversation_id=? AND user_id=?').run(now(), req.params.id, me.id)
  pushToUser(me.id, { type: 'cleared', conversationId: req.params.id }) // sync my other tabs
  res.json({ ok: true, cleared: ids.length })
})

// WhatsApp's "Delete chat" for a one-to-one: everything in it is cleared for
// me and the chat leaves my list — coming back by itself, empty, with the next
// message either of us sends. The other person keeps their copy. A group is
// left with Exit group instead, as in WhatsApp.
r.post('/conversations/:id/remove', (req, res) => {
  const me = req.user
  if (!member(req.params.id, me.id)) return res.status(404).json({ error: 'Not found' })
  const conv = db.prepare('SELECT type FROM chat_conversations WHERE id=?').get(req.params.id)
  if (conv?.type !== 'direct') return res.status(400).json({ error: 'Exit the group instead' })
  const ids = db.prepare('SELECT id FROM chat_messages WHERE conversation_id=?').all(req.params.id)
  const ins = db.prepare('INSERT OR IGNORE INTO chat_message_hidden (message_id, user_id) VALUES (?,?)')
  const ts = now()
  db.transaction(() => { for (const m of ids) ins.run(m.id, me.id) })()
  db.prepare('UPDATE chat_participants SET removed_at=?, last_read_at=?, archived=0, pinned=0, marked_unread=0 WHERE conversation_id=? AND user_id=?').run(ts, ts, req.params.id, me.id)
  pushToUser(me.id, { type: 'conversation', action: 'removed', conversationId: req.params.id })
  res.json({ ok: true })
})

// Set a group photo (admin only, images only).
r.post('/conversations/:id/avatar', smallUpload.single('file'), (req, res) => {
  const cleanup = () => { if (req.file) try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)) } catch {} }
  const m = member(req.params.id, req.user.id)
  if (!m) { cleanup(); return res.status(404).json({ error: 'Not found' }) }
  if (m.role !== 'admin') { cleanup(); return res.status(403).json({ error: 'Only the group admin can change the photo' }) }
  if (!req.file || !(req.file.mimetype || '').startsWith('image/')) { cleanup(); return res.status(400).json({ error: 'An image file is required' }) }
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  if (conv.type !== 'group') { cleanup(); return res.status(400).json({ error: 'Only groups have a photo' }) }
  const old = conv.avatar_file
  db.prepare('UPDATE chat_conversations SET avatar_file=? WHERE id=?').run(req.file.filename, conv.id)
  if (old) try { fs.unlinkSync(path.join(UPLOAD_DIR, old)) } catch {}
  postSystem(conv, req.user.id, { action: 'photo' })
  pushToConversation(conv.id, { type: 'conversation', action: 'updated', conversationId: conv.id })
  res.json({ ok: true })
})

// Mark a conversation read (lightweight; used on live inbound while open, and
// by "Mark as read" on the chat list).
r.post('/conversations/:id/read', (req, res) => {
  if (!member(req.params.id, req.user.id)) return res.status(404).json({ error: 'Not found' })
  const ts = now()
  const moved = markRead(req.params.id, req.user.id, ts)
  pushToConversation(req.params.id, { type: 'read', conversationId: req.params.id, userId: req.user.id, last_read_at: ts }, req.user.id)
  if (moved) pushReceipts(req.params.id)
  res.json({ ok: true })
})

// A group event line ("Priya added Ravi"), sent straight to everyone like the
// call ledger line — never through deliver(): an admin tidying the member list
// is not something to buzz every phone in the group about.
function postSystem(conv, actorId, meta) {
  if (!conv || conv.type !== 'group') return null
  const mid = id('msg')
  const full = { actor: actorId, ...meta }
  // The body is the line in the third person ("Priya added Ravi"). This app
  // words it per reader from `meta`; the body is for copies of the app from
  // before group events existed — the Android build in people's pockets —
  // which would otherwise show an empty bubble.
  db.prepare('INSERT INTO chat_messages (id, org_id, conversation_id, sender_id, recipient_id, body, kind, meta, read, created_at) VALUES (?,?,?,?,?,?,?,?,0,?)')
    .run(mid, conv.org_id, conv.id, actorId, '', systemText(full, null), 'system', JSON.stringify(full), now())
  touchConvo(conv.id)
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(mid)
  for (const uid of participantsOf(conv.id)) pushToUser(uid, { type: 'message', conversationId: conv.id, message: shapeMessage(row, uid, {}) })
  return row
}

// Rename a group, or change its description (admin only).
r.patch('/conversations/:id', (req, res) => {
  const m = member(req.params.id, req.user.id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  if (m.role !== 'admin') return res.status(403).json({ error: 'Only the group admin can do this' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  if (conv.type !== 'group') return res.status(400).json({ error: 'Only groups have a name' })
  const b = req.body || {}
  if ('name' in b) {
    const name = String(b.name || '').trim().slice(0, 80)
    if (!name) return res.status(400).json({ error: 'Name required' })
    if (name !== conv.name) {
      db.prepare('UPDATE chat_conversations SET name=? WHERE id=?').run(name, conv.id)
      postSystem(conv, req.user.id, { action: 'renamed', from: conv.name || '', to: name })
    }
  }
  if ('description' in b) {
    const description = String(b.description || '').trim().slice(0, 500)
    if (description !== (conv.description || '')) {
      db.prepare('UPDATE chat_conversations SET description=? WHERE id=?').run(description, conv.id)
      postSystem(conv, req.user.id, { action: 'description', to: description ? 1 : 0 })
    }
  }
  pushToConversation(req.params.id, { type: 'conversation', action: 'updated', conversationId: req.params.id })
  res.json({ ok: true })
})

// Group settings (admin only). Today one: "Send messages — only admins", for
// announcement groups where the room is for reading.
r.post('/conversations/:id/settings', (req, res) => {
  const m = member(req.params.id, req.user.id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  if (m.role !== 'admin') return res.status(403).json({ error: 'Only a group admin can change this' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  if (conv.type !== 'group') return res.status(400).json({ error: 'Only groups have settings' })
  if ('admins_only' in (req.body || {})) {
    const on = req.body.admins_only ? 1 : 0
    if (on !== (conv.admins_only ? 1 : 0)) {
      db.prepare('UPDATE chat_conversations SET admins_only=? WHERE id=?').run(on, conv.id)
      postSystem(conv, req.user.id, { action: 'admins_only', on: !!on })
    }
  }
  pushToConversation(conv.id, { type: 'conversation', action: 'updated', conversationId: conv.id })
  res.json({ ok: true })
})

// Make someone a group admin, or dismiss them as one (admin only). The last
// admin cannot dismiss themselves — a group nobody can manage is stuck.
r.post('/conversations/:id/members/:userId/role', (req, res) => {
  const m = member(req.params.id, req.user.id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  if (m.role !== 'admin') return res.status(403).json({ error: 'Only a group admin can do this' })
  const target = member(req.params.id, req.params.userId)
  if (!target) return res.status(404).json({ error: 'Not a member of this group' })
  const role = req.body?.role === 'admin' ? 'admin' : 'member'
  if (role === target.role) return res.json({ ok: true })
  if (role === 'member') {
    const admins = db.prepare("SELECT COUNT(*) n FROM chat_participants WHERE conversation_id=? AND role='admin'").get(req.params.id).n
    if (admins <= 1) return res.status(400).json({ error: 'A group needs at least one admin' })
  }
  db.prepare('UPDATE chat_participants SET role=? WHERE conversation_id=? AND user_id=?').run(role, req.params.id, req.params.userId)
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  postSystem(conv, req.user.id, { action: 'admin', on: role === 'admin', targets: [req.params.userId] })
  pushToConversation(req.params.id, { type: 'conversation', action: 'updated', conversationId: req.params.id })
  res.json({ ok: true })
})

// Add members to a group (admin only).
r.post('/conversations/:id/members', (req, res) => {
  const m = member(req.params.id, req.user.id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  if (m.role !== 'admin') return res.status(403).json({ error: 'Only the group admin can add members' })
  const ids = Array.isArray(req.body?.userIds) ? req.body.userIds : []
  const valid = db.prepare(`SELECT id FROM users WHERE org_id=? AND id IN (${ids.map(() => '?').join(',') || "''"})`).all(req.user.org_id, ...ids).map((u) => u.id)
  const fresh = valid.filter((uid) => !member(req.params.id, uid))
  const ts = now()
  for (const uid of fresh) db.prepare('INSERT OR IGNORE INTO chat_participants (conversation_id, user_id, role, last_read_at, joined_at) VALUES (?,?,?,?,?)').run(req.params.id, uid, 'member', null, ts)
  if (fresh.length) postSystem(db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id), req.user.id, { action: 'added', targets: fresh })
  pushToConversation(req.params.id, { type: 'conversation', action: 'updated', conversationId: req.params.id })
  res.json({ ok: true })
})

// Delete an entire group (admin only). Removes it for every member in real time.
r.delete('/conversations/:id', (req, res) => {
  const me = req.user
  const m = member(req.params.id, me.id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  if (!conv || conv.type !== 'group') return res.status(400).json({ error: 'Only groups can be deleted' })
  if (m.role !== 'admin') return res.status(403).json({ error: 'Only the group admin can delete the group' })
  const members = participantsOf(conv.id)
  // Remove any stored files from disk.
  for (const f of db.prepare('SELECT file_stored FROM chat_messages WHERE conversation_id=? AND file_stored IS NOT NULL').all(conv.id)) {
    if (f.file_stored) try { fs.unlinkSync(path.join(UPLOAD_DIR, f.file_stored)) } catch {}
  }
  const wipe = db.transaction(() => {
    const ids = db.prepare('SELECT id FROM chat_messages WHERE conversation_id=?').all(conv.id)
    for (const mm of ids) {
      db.prepare('DELETE FROM chat_reactions WHERE message_id=?').run(mm.id)
      db.prepare('DELETE FROM chat_stars WHERE message_id=?').run(mm.id)
      db.prepare('DELETE FROM chat_message_hidden WHERE message_id=?').run(mm.id)
      db.prepare('DELETE FROM chat_poll_votes WHERE message_id=?').run(mm.id)
      db.prepare('DELETE FROM chat_polls WHERE message_id=?').run(mm.id)
      removeEmbedding('chat', mm.id) // drop RAG vector for each wiped message
    }
    db.prepare('DELETE FROM chat_messages WHERE conversation_id=?').run(conv.id)
    db.prepare('DELETE FROM chat_receipt_marks WHERE conversation_id=?').run(conv.id)
    db.prepare('DELETE FROM chat_participants WHERE conversation_id=?').run(conv.id)
    db.prepare('DELETE FROM chat_conversations WHERE id=?').run(conv.id)
  })
  wipe()
  for (const uid of members) pushToUser(uid, { type: 'conversation', action: 'removed', conversationId: conv.id })
  res.json({ ok: true })
})

// Leave a group (self) or remove a member (admin).
r.delete('/conversations/:id/members/:userId', (req, res) => {
  const m = member(req.params.id, req.user.id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  const target = req.params.userId
  if (target !== req.user.id && m.role !== 'admin') return res.status(403).json({ error: 'Only the group admin can remove members' })
  if (!member(req.params.id, target)) return res.json({ ok: true })
  db.prepare('DELETE FROM chat_participants WHERE conversation_id=? AND user_id=?').run(req.params.id, target)
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  // The last admin walked out: hand the group to whoever has been in it
  // longest, as WhatsApp does, so it is never left with nobody able to run it.
  if (conv?.type === 'group' && !db.prepare("SELECT 1 FROM chat_participants WHERE conversation_id=? AND role='admin'").get(conv.id)) {
    const heir = db.prepare('SELECT user_id FROM chat_participants WHERE conversation_id=? ORDER BY joined_at ASC LIMIT 1').get(conv.id)
    if (heir) db.prepare("UPDATE chat_participants SET role='admin' WHERE conversation_id=? AND user_id=?").run(conv.id, heir.user_id)
  }
  postSystem(conv, req.user.id, target === req.user.id ? { action: 'left' } : { action: 'removed', targets: [target] })
  pushToConversation(req.params.id, { type: 'conversation', action: 'updated', conversationId: req.params.id })
  pushToUser(target, { type: 'conversation', action: 'removed', conversationId: req.params.id })
  res.json({ ok: true })
})

// ---------- messages ----------
function deliver(conv, msgRow, sender, mentioned = []) {
  touchConvo(conv.id)
  const others = participantsOf(conv.id).filter((u) => u !== sender.id)
  const label = conv.type === 'group' ? `${sender.name} in ${conv.name || 'Group'}` : sender.name
  const preview = snippet(msgRow)
  const short = preview.length > 70 ? preview.slice(0, 70) + '…' : preview
  const pinged = new Set(mentioned)
  for (const uid of others) {
    const p = db.prepare('SELECT muted, muted_until FROM chat_participants WHERE conversation_id=? AND user_id=?').get(conv.id, uid)
    // A timed mute that has run out is not a mute any more. Checked on read
    // rather than swept by a job: the answer is only ever needed right here.
    const muteLive = p?.muted && (!p.muted_until || p.muted_until > now())
    const dnd = db.prepare('SELECT dnd_until FROM users WHERE id=?').get(uid)?.dnd_until
    const dndLive = dnd && dnd > now()
    // Being named by hand outranks muting the room — that is the whole point of
    // typing someone's name instead of just talking. Muting still silences every
    // other message in the thread.
    if (pinged.has(uid) && !dndLive) {
      notify(conv.org_id, uid, 'chat_mention', `${sender.name} mentioned you${conv.type === 'group' ? ` in ${conv.name || 'Group'}` : ''}: ${short}`, null)
      continue
    }
    // DND silences everything, including a direct mention — that is the contract
    // a person sets when they turn it on, and a mention that overrode it would
    // make the setting useless. The message still arrives live in the thread.
    if (dndLive) continue
    if (muteLive) continue // muted: deliver the message live, but no notification
    notify(conv.org_id, uid, 'chat_message', `${label}: ${short}`, null)
  }
  // Recipients with the app open have it now: that is the second tick. The
  // rest get theirs when a device of theirs next checks in (deliverPending).
  const online = new Set(getOnlineUsers())
  const ts = now()
  for (const uid of others) if (online.has(uid)) markDelivered(conv.id, uid, ts)
  // Push the shaped message to everyone, each with their own view of the ticks.
  for (const uid of [sender.id, ...others]) {
    pushToUser(uid, { type: 'message', conversationId: conv.id, message: shapeMessage(msgRow, uid, receiptCtx(conv.id, uid)) })
  }
  indexChatMessage(msgRow.id) // RAG: index every delivered message (text/upload/forward)
}

// "Send messages: only admins" — checked on every way into a thread, not just
// the composer, because the UI hiding the box is not a permission.
function canPost(conv, userId) {
  if (!conv || conv.type !== 'group' || !conv.admins_only) return true
  return member(conv.id, userId)?.role === 'admin'
}
const ADMINS_ONLY = 'Only admins can send messages to this group'

// What a new message may quote. Normally a message in the same thread. A
// different thread only for WhatsApp's "Reply privately": allowed when the
// replier can see the original AND so can everyone in this thread, so a quote
// can never carry a group's words to someone outside that group.
function resolveReply(rawId, conv, userId) {
  if (!rawId) return null
  const src = db.prepare('SELECT id, conversation_id FROM chat_messages WHERE id=?').get(String(rawId))
  if (!src) return null
  if (src.conversation_id === conv.id) return src.id
  if (!member(src.conversation_id, userId)) return null
  return participantsOf(conv.id).every((uid) => member(src.conversation_id, uid)) ? src.id : null
}

// Send a message: text, or one of the kinds that need no file — a shared
// location ({kind:'location', meta:{lat,lng,label?,accuracy?}}) or a
// teammate's contact card ({kind:'contact', meta:{user_id}}).
r.post('/conversations/:id/messages', (req, res) => {
  const me = req.user
  if (!member(req.params.id, me.id)) return res.status(404).json({ error: 'Conversation not found' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  if (!canPost(conv, me.id)) return res.status(403).json({ error: ADMINS_ONLY })
  const kind = req.body?.kind === 'location' || req.body?.kind === 'contact' ? req.body.kind : null
  let body = String(req.body?.body || '').trim()
  let meta = null
  if (kind === 'location') {
    const lat = Number(req.body?.meta?.lat), lng = Number(req.body?.meta?.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'A valid location is required' })
    const label = String(req.body?.meta?.label || '').trim().slice(0, 120)
    const accuracy = Math.round(Number(req.body?.meta?.accuracy) || 0) || null
    meta = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, label, accuracy }
    body = label || 'Location'
  } else if (kind === 'contact') {
    const u = db.prepare('SELECT id, name FROM users WHERE id=? AND org_id=?').get(String(req.body?.meta?.user_id || ''), me.org_id)
    if (!u) return res.status(400).json({ error: 'Pick a teammate to share' })
    meta = { user_id: u.id }
    body = u.name
  } else if (!body) return res.status(400).json({ error: 'Message body required' })
  if (body.length > 4000) return res.status(400).json({ error: 'Message too long' })
  const replyTo = resolveReply(req.body?.replyTo, conv, me.id)
  const mid = id('msg')
  const ts = now()
  db.prepare('INSERT INTO chat_messages (id, org_id, conversation_id, sender_id, recipient_id, body, reply_to, kind, meta, read, created_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)')
    .run(mid, conv.org_id, conv.id, me.id, '', body, replyTo, kind, meta ? JSON.stringify(meta) : null, ts)
  const mentioned = kind ? [] : saveMentions(conv.id, mid, req.body?.mentions, me.id)
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(mid)
  deliver(conv, row, me, mentioned)
  res.status(201).json(shapeMessage(row, me.id, receiptCtx(conv.id, me.id)))
})

// Asked before a big file is sent: would it be let in right now? The upload
// route checks the same thing, but a browser reads no answer until it has
// sent the whole body, so its refusal arrives as "connection lost" — this is
// how a sender hears "no room" in a moment instead.
r.get('/upload-room', (req, res) => {
  const no = refusalFor(Number(req.query.size) || 0)
  if (no) return res.status(no[0]).json({ error: no[1] })
  res.json({ ok: true })
})

// Send a file (optional caption + replyTo).
r.post('/conversations/:id/upload', receiveChatFile, (req, res) => {
  const me = req.user
  const cleanup = () => { if (req.file) try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)) } catch {} }
  if (!member(req.params.id, me.id)) { cleanup(); return res.status(404).json({ error: 'Conversation not found' }) }
  if (!req.file) return res.status(400).json({ error: 'file required (field "file")' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  if (!canPost(conv, me.id)) { cleanup(); return res.status(403).json({ error: ADMINS_ONLY }) }
  const caption = String(req.body?.body || '').trim().slice(0, 4000)
  const replyTo = resolveReply(req.body?.replyTo, conv, me.id)
  const mid = id('msg')
  const ts = now()
  db.prepare(`INSERT INTO chat_messages (id, org_id, conversation_id, sender_id, recipient_id, body, file_name, file_stored, file_type, file_size, reply_to, read, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)`)
    .run(mid, conv.org_id, conv.id, me.id, '', caption, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, replyTo, ts)
  // A voice note whose sender's browser already recognised the speech arrives
  // with the text attached, so nobody has to pay for a transcription that has
  // effectively already happened. Trusted no further than any other client
  // input: it is display text, and it is capped.
  const supplied = String(req.body?.transcript || '').trim().slice(0, 5000)
  if (supplied) db.prepare('UPDATE chat_messages SET transcript=? WHERE id=?').run(supplied, mid)
  // multipart carries no arrays, so the caption's mentions arrive as a JSON string.
  let capMentions = []
  try { capMentions = JSON.parse(req.body?.mentions || '[]') } catch {}
  const mentioned = saveMentions(conv.id, mid, capMentions, me.id)
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(mid)
  deliver(conv, row, me, mentioned)
  res.status(201).json(shapeMessage(row, me.id, receiptCtx(conv.id, me.id)))
})

// Edit a message (sender only): the text, or the caption under a photo or
// file, as WhatsApp allows. Not a call line, a summary, a poll, a group event
// or a task card — those are records of something, not things someone typed.
// The @mentions are re-read from the new text so a name taken out stops
// counting, but nobody is notified again: an edit is a correction, not a
// second message.
r.patch('/message/:id', (req, res) => {
  const me = req.user
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || m.sender_id !== me.id || !member(m.conversation_id, me.id)) return res.status(404).json({ error: 'Message not found' })
  if (m.deleted_for_all) return res.status(400).json({ error: 'Cannot edit a deleted message' })
  if (m.kind || m.call_id || m.meeting_id || (m.file_type || '').startsWith('audio/')) return res.status(400).json({ error: 'This message cannot be edited' })
  const body = String(req.body?.body || '').trim()
  if (!body && !m.file_stored) return res.status(400).json({ error: 'Body required' })
  if (body.length > 4000) return res.status(400).json({ error: 'Message too long' })
  if (body === (m.body || '')) return res.json({ ok: true, body, edited_at: m.edited_at || null, mentions: mentionsByMessage([m.id])[m.id] || [] })
  const ts = now()
  db.prepare('UPDATE chat_messages SET body=?, edited_at=? WHERE id=?').run(body, ts, m.id)
  if (Array.isArray(req.body?.mentions)) {
    db.prepare('DELETE FROM chat_mentions WHERE message_id=?').run(m.id)
    saveMentions(m.conversation_id, m.id, req.body.mentions, me.id)
  }
  const mentions = mentionsByMessage([m.id])[m.id] || []
  pushToConversation(m.conversation_id, { type: 'edit', conversationId: m.conversation_id, id: m.id, body, edited_at: ts, mentions })
  indexChatMessage(m.id) // re-index edited body
  res.json({ ok: true, body, edited_at: ts, mentions })
})

// Forward a message to one or more conversations I'm a member of. Text,
// files, locations and contacts travel; a poll, a task card, a call line or a
// summary is a record of THIS chat and stays in it.
r.post('/message/:id/forward', (req, res) => {
  const me = req.user
  const src = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!src || src.deleted_for_all || !member(src.conversation_id, me.id)) return res.status(404).json({ error: 'Message not found' })
  if ((src.kind && src.kind !== 'location' && src.kind !== 'contact') || src.call_id || src.meeting_id) return res.status(400).json({ error: 'This message cannot be forwarded' })
  const targets = Array.isArray(req.body?.conversationIds) ? req.body.conversationIds : []
  const sent = []
  for (const cid of targets) {
    if (!member(cid, me.id)) continue
    const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(cid)
    if (!conv || !canPost(conv, me.id)) continue
    let storedName = null
    if (src.file_stored) {
      // A name of its own so deleting one message doesn't affect the other —
      // as a hard link, not a copy: copying a 1 GB file would stall the whole
      // server while it ran and spend another 1 GB of disk per chat it went to.
      // Unlinking one name leaves the other's bytes where they are.
      storedName = id('cf') + path.extname(src.file_stored)
      const from = path.join(UPLOAD_DIR, src.file_stored), to = path.join(UPLOAD_DIR, storedName)
      try { fs.linkSync(from, to) } catch { try { fs.copyFileSync(from, to) } catch { storedName = null } }
    }
    const mid = id('msg')
    const ts = now()
    db.prepare(`INSERT INTO chat_messages (id, org_id, conversation_id, sender_id, recipient_id, body, file_name, file_stored, file_type, file_size, kind, meta, transcript, forwarded, read, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,?)`)
      .run(mid, conv.org_id, cid, me.id, '', src.body, storedName ? src.file_name : null, storedName, storedName ? src.file_type : null, storedName ? src.file_size : null,
        src.kind || null, src.kind ? src.meta : null, storedName ? (src.transcript || null) : null, ts)
    const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(mid)
    deliver(conv, row, me)
    sent.push(cid)
  }
  res.json({ ok: true, forwarded_to: sent })
})

// Delete. Your own message: ?scope=all (the default) unsends it for everyone
// — a tombstone, the file removed — and ?scope=me only hides it from you, the
// two choices WhatsApp offers. Someone else's message can only be removed for
// you. A group event or call line is nobody's to unsend.
r.delete('/message/:id', (req, res) => {
  const me = req.user
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || !member(m.conversation_id, me.id)) return res.status(404).json({ error: 'Message not found' })
  const record = m.kind === 'system' || m.call_id || m.meeting_id
  if (m.sender_id === me.id && req.query.scope !== 'me' && !record) {
    db.prepare('UPDATE chat_messages SET deleted_for_all=1, body=?, file_name=NULL, file_stored=NULL, file_type=NULL, file_size=NULL, meta=NULL, transcript=NULL, pinned_at=NULL WHERE id=?').run('', m.id)
    db.prepare('DELETE FROM chat_reactions WHERE message_id=?').run(m.id)
    db.prepare('DELETE FROM chat_poll_votes WHERE message_id=?').run(m.id)
    db.prepare('DELETE FROM chat_polls WHERE message_id=?').run(m.id)
    db.prepare('DELETE FROM chat_mentions WHERE message_id=?').run(m.id)
    removeEmbedding('chat', m.id) // unsent message leaves the RAG index
    if (m.file_stored) try { fs.unlinkSync(path.join(UPLOAD_DIR, m.file_stored)) } catch {}
    pushToConversation(m.conversation_id, { type: 'delete', conversationId: m.conversation_id, id: m.id, scope: 'all' })
    if (m.pinned_at) pushToConversation(m.conversation_id, { type: 'pin', conversationId: m.conversation_id, id: m.id, pinned: false })
  } else {
    db.prepare('INSERT OR IGNORE INTO chat_message_hidden (message_id, user_id) VALUES (?,?)').run(m.id, me.id)
    pushToUser(me.id, { type: 'delete', conversationId: m.conversation_id, id: m.id, scope: 'me' })
  }
  res.json({ ok: true })
})

// Would a notification to this person about this conversation be welcome
// right now? (Not muted, not on do-not-disturb.)
function wantsPing(convId, uid) {
  const p = db.prepare('SELECT muted, muted_until FROM chat_participants WHERE conversation_id=? AND user_id=?').get(convId, uid)
  if (p?.muted && (!p.muted_until || p.muted_until > now())) return false
  const dnd = db.prepare('SELECT dnd_until FROM users WHERE id=?').get(uid)?.dnd_until
  return !(dnd && dnd > now())
}

// Toggle an emoji reaction (one reaction per user per message; same emoji = remove).
r.post('/message/:id/reactions', (req, res) => {
  const me = req.user
  const emoji = String(req.body?.emoji || '').slice(0, 8)
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || !member(m.conversation_id, me.id) || !emoji || m.deleted_for_all) return res.status(404).json({ error: 'Not found' })
  const existing = db.prepare('SELECT emoji FROM chat_reactions WHERE message_id=? AND user_id=?').get(m.id, me.id)
  db.prepare('DELETE FROM chat_reactions WHERE message_id=? AND user_id=?').run(m.id, me.id)
  const added = !existing || existing.emoji !== emoji
  if (added) {
    db.prepare('INSERT INTO chat_reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)').run(m.id, me.id, emoji, now())
  }
  const reactions = db.prepare('SELECT user_id, emoji FROM chat_reactions WHERE message_id=?').all(m.id)
  pushToConversation(m.conversation_id, { type: 'reaction', conversationId: m.conversation_id, id: m.id, reactions })
  // WhatsApp tells you when someone reacts to your message. Only a fresh
  // reaction, only to the author, and only if they have not muted the chat.
  if (added && m.sender_id !== me.id && m.kind !== 'system' && member(m.conversation_id, m.sender_id) && wantsPing(m.conversation_id, m.sender_id)) {
    const what = snippet(m)
    notify(m.org_id, m.sender_id, 'chat_message', `${me.name} reacted ${emoji} to: "${what.length > 50 ? what.slice(0, 50) + '…' : what}"`, null)
  }
  res.json({ reactions })
})

// Message info (your own messages): who has it, who has read it, and when —
// WhatsApp's "Read by / Delivered to". The time is the first moment that
// person's position passed the message (chat_receipt_marks); for messages from
// before marks were kept, "read" is known but the moment is not, and says so.
r.get('/message/:id/info', (req, res) => {
  const me = req.user
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || !member(m.conversation_id, me.id)) return res.status(404).json({ error: 'Message not found' })
  if (m.sender_id !== me.id) return res.status(403).json({ error: 'Only for your own messages' })
  const people = db.prepare(`
    SELECT u.id, u.name, u.avatar_color, u.avatar_file, p.last_read_at, p.read_receipt_at, p.last_delivered_at, p.joined_at
    FROM chat_participants p JOIN users u ON u.id=p.user_id
    WHERE p.conversation_id=? AND p.user_id!=? ORDER BY u.name`).all(m.conversation_id, me.id)
  const first = db.prepare(`SELECT MIN(at) at FROM chat_receipt_marks WHERE conversation_id=? AND user_id=? AND kind IN (SELECT value FROM json_each(?)) AND at>=?`)
  const read = [], delivered = [], waiting = []
  for (const p of people) {
    // Added to the group after this was sent: it was never theirs to receive.
    if (p.joined_at && p.joined_at > m.created_at) continue
    const who = { id: p.id, name: p.name, avatar_color: p.avatar_color, avatar_file: p.avatar_file || null }
    const readAt = first.get(m.conversation_id, p.id, '["r"]', m.created_at)?.at || null
    const isRead = !!readAt || (readPos(p) || '') >= m.created_at
    if (isRead) { read.push({ ...who, at: readAt }); continue }
    const delAt = first.get(m.conversation_id, p.id, '["d","r"]', m.created_at)?.at || null
    if (delAt || (deliveredPos(p) || '') >= m.created_at) delivered.push({ ...who, at: delAt })
    else waiting.push(who)
  }
  res.json({ created_at: m.created_at, read, delivered, waiting })
})

// The preview card for the first link in a message. Asked by message rather
// than by URL so this cannot be used as a general-purpose fetcher: the address
// has to be in a message the asker can see.
r.get('/message/:id/preview', async (req, res) => {
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || m.deleted_for_all || !member(m.conversation_id, req.user.id)) return res.status(404).json({ error: 'Not found' })
  const url = linksIn(m.body)[0]
  if (!url) return res.json({ preview: null })
  try {
    const data = await linkPreview(url)
    res.json({ preview: data ? { url, ...data } : null })
  } catch { res.json({ preview: null }) }
})

// ---------- polls ----------
r.post('/conversations/:id/poll', (req, res) => {
  const me = req.user
  if (!member(req.params.id, me.id)) return res.status(404).json({ error: 'Conversation not found' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  if (!canPost(conv, me.id)) return res.status(403).json({ error: ADMINS_ONLY })
  const question = String(req.body?.question || '').trim().slice(0, 300)
  const options = [...new Set((Array.isArray(req.body?.options) ? req.body.options : [])
    .map((o) => String(o || '').trim().slice(0, 100)).filter(Boolean))]
  if (!question) return res.status(400).json({ error: 'Ask a question' })
  if (options.length < 2) return res.status(400).json({ error: 'Add at least two options' })
  if (options.length > 12) return res.status(400).json({ error: 'A poll can have up to 12 options' })
  const mid = id('msg')
  db.prepare("INSERT INTO chat_messages (id, org_id, conversation_id, sender_id, recipient_id, body, kind, read, created_at) VALUES (?,?,?,?,?,?,'poll',0,?)")
    .run(mid, conv.org_id, conv.id, me.id, '', question, now())
  db.prepare('INSERT INTO chat_polls (message_id, options, multi) VALUES (?,?,?)').run(mid, JSON.stringify(options), req.body?.multi ? 1 : 0)
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(mid)
  deliver(conv, row, me)
  res.status(201).json(shapeMessage(row, me.id, receiptCtx(conv.id, me.id)))
})

// Vote: `options` is the complete set of my choices now (empty takes my vote
// back), so a change of mind is one request and can never leave a half-vote.
r.post('/message/:id/vote', (req, res) => {
  const me = req.user
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || m.kind !== 'poll' || m.deleted_for_all || !member(m.conversation_id, me.id)) return res.status(404).json({ error: 'Poll not found' })
  const p = db.prepare('SELECT options, multi FROM chat_polls WHERE message_id=?').get(m.id)
  if (!p) return res.status(404).json({ error: 'Poll not found' })
  let n = 0
  try { n = JSON.parse(p.options).length } catch {}
  let picks = [...new Set((Array.isArray(req.body?.options) ? req.body.options : []).map(Number))]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < n)
  if (!p.multi) picks = picks.slice(0, 1)
  const ts = now()
  db.transaction(() => {
    db.prepare('DELETE FROM chat_poll_votes WHERE message_id=? AND user_id=?').run(m.id, me.id)
    for (const i of picks) db.prepare('INSERT INTO chat_poll_votes (message_id, user_id, option_idx, created_at) VALUES (?,?,?,?)').run(m.id, me.id, i, ts)
  })()
  const poll = pollOf(m.id)
  pushToConversation(m.conversation_id, { type: 'poll', conversationId: m.conversation_id, id: m.id, poll })
  res.json({ poll })
})

// ---------- a task assigned from the chat ----------
// The task itself is created through POST /api/tasks — the one place a task is
// made, with its categories, audit and assignment notification — and then
// announced here as a card in the thread, quoting the message it came from.
// Two requests rather than a second task-creating route that would drift.
r.post('/conversations/:id/task-card', (req, res) => {
  const me = req.user
  if (!member(req.params.id, me.id)) return res.status(404).json({ error: 'Conversation not found' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  if (!canPost(conv, me.id)) return res.status(403).json({ error: ADMINS_ONLY })
  // A private task (a personal to-do) is only posted by its own owner — a card
  // shows its title, status and assignee to the whole chat.
  const t = db.prepare(`SELECT id, title FROM tasks WHERE id=? AND org_id=?
    AND (COALESCE(visible_to_manager, 1)=1 OR assignee_id=? OR assigned_by_id=?)`).get(String(req.body?.taskId || ''), me.org_id, me.id, me.id)
  if (!t) return res.status(404).json({ error: 'Task not found' })
  const replyTo = resolveReply(req.body?.replyTo, conv, me.id)
  const mid = id('msg')
  db.prepare("INSERT INTO chat_messages (id, org_id, conversation_id, sender_id, recipient_id, body, kind, task_id, reply_to, read, created_at) VALUES (?,?,?,?,?,?,'task',?,?,0,?)")
    .run(mid, conv.org_id, conv.id, me.id, '', t.title, t.id, replyTo, now())
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(mid)
  deliver(conv, row, me)
  res.status(201).json(shapeMessage(row, me.id, receiptCtx(conv.id, me.id)))
})

// Star / unstar (per user).
r.post('/message/:id/star', (req, res) => {
  const me = req.user
  const m = db.prepare('SELECT conversation_id FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || !member(m.conversation_id, me.id)) return res.status(404).json({ error: 'Not found' })
  db.prepare('INSERT OR IGNORE INTO chat_stars (message_id, user_id, created_at) VALUES (?,?,?)').run(req.params.id, me.id, now())
  res.json({ ok: true, starred: true })
})
r.delete('/message/:id/star', (req, res) => {
  db.prepare('DELETE FROM chat_stars WHERE message_id=? AND user_id=?').run(req.params.id, req.user.id)
  res.json({ ok: true, starred: false })
})

// My starred messages (most recent first).
r.get('/starred', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, s.created_at AS starred_at FROM chat_stars s
    JOIN chat_messages m ON m.id=s.message_id
    WHERE s.user_id=? AND m.deleted_for_all=0 ORDER BY s.created_at DESC LIMIT 100`).all(req.user.id)
  const items = rows.map((row) => ({ ...shapeMessage(row, req.user.id, { stars: new Set([row.id]) }), starred_at: row.starred_at }))
  res.json({ items })
})

// Messages that named me, newest first — the "@ Mentions" inbox. Without it a
// mention in a busy group is just one more unread row in the sidebar.
r.get('/mentions', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, mn.created_at AS mentioned_at FROM chat_mentions mn
    JOIN chat_messages m ON m.id=mn.message_id
    WHERE mn.user_id=? AND m.deleted_for_all=0
      AND m.id NOT IN (SELECT message_id FROM chat_message_hidden WHERE user_id=?)
    ORDER BY mn.created_at DESC LIMIT 100`).all(req.user.id, req.user.id)
  const names = {}
  const items = rows.map((row) => {
    const conv = db.prepare('SELECT type, name FROM chat_conversations WHERE id=?').get(row.conversation_id)
    const sender = names[row.sender_id] || (names[row.sender_id] = db.prepare('SELECT name FROM users WHERE id=?').get(row.sender_id)?.name || 'Unknown')
    return {
      ...shapeMessage(row, req.user.id, {}),
      sender_name: sender,
      conversation_name: conv?.type === 'group' ? (conv.name || 'Group') : sender,
      conversation_type: conv?.type || 'direct',
      mentioned_at: row.mentioned_at,
    }
  })
  res.json({ items })
})

// ---------- calls (audio / video / screen share) ----------
//
// Signalling only. The media is peer-to-peer WebRTC negotiated over the chat
// WebSocket (see ws/chatHub.js); these routes own the call's LIFECYCLE — who is
// ringing, who picked up, when it ended — because that has to survive a refresh,
// a reconnect and a second device, which an in-memory socket map does not.

const liveCall = (convId) => db.prepare("SELECT * FROM chat_calls WHERE conversation_id=? AND status IN ('ringing','active') ORDER BY started_at DESC LIMIT 1").get(convId)

// Write the "Video call · 4m" line into the thread. Deliberately NOT deliver():
// a call that just ended has already interrupted everyone in it, and a push
// notification for its own receipt is noise.
function postCallLine(conv, call) {
  const mins = Math.round((call.duration_sec || 0) / 60)
  const label = call.kind === 'video' ? 'Video call' : 'Audio call'
  // "Missed" reads as an accusation to whoever placed the call — they did not
  // miss anything, nobody picked up. One line is shared by everyone in the
  // thread, so it has to be true from both ends: "no answer" is.
  const body = call.status === 'ended'
    ? `${label} · ${call.duration_sec < 60 ? `${call.duration_sec}s` : `${mins}m`}`
    : call.status === 'declined' ? `${label} declined` : `${label} · no answer`
  const mid = id('msg')
  db.prepare('INSERT INTO chat_messages (id, org_id, conversation_id, sender_id, recipient_id, body, call_id, read, created_at) VALUES (?,?,?,?,?,?,?,0,?)')
    .run(mid, conv.org_id, conv.id, call.started_by, '', body, call.id, now())
  touchConvo(conv.id)
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(mid)
  for (const uid of participantsOf(conv.id)) pushToUser(uid, { type: 'message', conversationId: conv.id, message: shapeMessage(row, uid, {}) })
}

// Start ringing everyone else in the conversation.
r.post('/conversations/:id/call', (req, res) => {
  const me = req.user
  if (!member(req.params.id, me.id)) return res.status(404).json({ error: 'Conversation not found' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  const kind = req.body?.kind === 'video' ? 'video' : 'audio'

  // Someone already started one — join that instead of opening a rival call in
  // the same room, which would split the group across two meshes.
  const existing = liveCall(conv.id)
  if (existing) {
    db.prepare('INSERT OR IGNORE INTO chat_call_participants (call_id, user_id, joined_at) VALUES (?,?,?)').run(existing.id, me.id, now())
    db.prepare('UPDATE chat_call_participants SET joined_at=COALESCE(joined_at,?), left_at=NULL WHERE call_id=? AND user_id=?').run(now(), existing.id, me.id)
    pushToConversation(conv.id, { type: 'call-joined', callId: existing.id, userId: me.id, name: me.name }, me.id)
    return res.json({ ...existing, joined: true, peers: callPeers(existing.id, me.id) })
  }

  const cid = id('call')
  const ts = now()
  db.prepare('INSERT INTO chat_calls (id, org_id, conversation_id, started_by, kind, status, started_at) VALUES (?,?,?,?,?,?,?)')
    .run(cid, conv.org_id, conv.id, me.id, kind, 'ringing', ts)
  db.prepare('INSERT INTO chat_call_participants (call_id, user_id, joined_at) VALUES (?,?,?)').run(cid, me.id, ts)
  const label = conv.type === 'group' ? (conv.name || 'Group') : me.name
  pushToConversation(conv.id, {
    type: 'call-ring', callId: cid, conversationId: conv.id, kind,
    from: { id: me.id, name: me.name }, conversationName: label, conversationType: conv.type, transcribe: 1,
  }, me.id)
  res.status(201).json({ id: cid, conversation_id: conv.id, kind, status: 'ringing', started_by: me.id, transcribe: 1, peers: [] })
})

// Everyone else already in the call, so a joiner knows who to offer to.
function callPeers(callId, exceptUserId) {
  return db.prepare('SELECT user_id FROM chat_call_participants WHERE call_id=? AND joined_at IS NOT NULL AND left_at IS NULL AND user_id!=?')
    .all(callId, exceptUserId).map((p) => p.user_id)
}

// Pick up. Returns the peers to negotiate with — the joiner sends the offers,
// so exactly one side of each pair initiates and the two don't collide.
r.post('/call/:id/answer', (req, res) => {
  const me = req.user
  const call = db.prepare('SELECT * FROM chat_calls WHERE id=?').get(req.params.id)
  if (!call || !member(call.conversation_id, me.id)) return res.status(404).json({ error: 'Call not found' })
  if (call.status === 'ended') return res.status(409).json({ error: 'Call already ended' })
  const ts = now()
  const peers = callPeers(call.id, me.id)
  if (call.status === 'ringing') db.prepare('UPDATE chat_calls SET status=?, answered_at=COALESCE(answered_at,?) WHERE id=?').run('active', ts, call.id)
  db.prepare('INSERT OR IGNORE INTO chat_call_participants (call_id, user_id, joined_at) VALUES (?,?,?)').run(call.id, me.id, ts)
  db.prepare('UPDATE chat_call_participants SET joined_at=COALESCE(joined_at,?), left_at=NULL WHERE call_id=? AND user_id=?').run(ts, call.id, me.id)
  pushToConversation(call.conversation_id, { type: 'call-joined', callId: call.id, userId: me.id, name: me.name }, me.id)
  res.json({ ...db.prepare('SELECT * FROM chat_calls WHERE id=?').get(call.id), peers })
})

// Decline: only meaningful while it is still ringing, and only ends the call for
// everyone in a 1:1 — in a group the others may still be talking.
r.post('/call/:id/decline', (req, res) => {
  const me = req.user
  const call = db.prepare('SELECT * FROM chat_calls WHERE id=?').get(req.params.id)
  if (!call || !member(call.conversation_id, me.id)) return res.status(404).json({ error: 'Call not found' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(call.conversation_id)
  pushToUser(call.started_by, { type: 'call-declined', callId: call.id, userId: me.id, name: me.name })
  if (conv.type === 'direct' && call.status === 'ringing') {
    db.prepare('UPDATE chat_calls SET status=?, ended_at=? WHERE id=?').run('declined', now(), call.id)
    pushToConversation(call.conversation_id, { type: 'call-ended', callId: call.id })
    postCallLine(conv, { ...callSummary(call.id), status: 'declined' })
  }
  res.json({ ok: true })
})

// Leave. The last person out ends the call and files the ledger line.
r.post('/call/:id/end', (req, res) => {
  const me = req.user
  const call = db.prepare('SELECT * FROM chat_calls WHERE id=?').get(req.params.id)
  if (!call || !member(call.conversation_id, me.id)) return res.status(404).json({ error: 'Call not found' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(call.conversation_id)
  const ts = now()
  db.prepare('UPDATE chat_call_participants SET left_at=? WHERE call_id=? AND user_id=? AND left_at IS NULL').run(ts, call.id, me.id)
  pushToConversation(call.conversation_id, { type: 'call-left', callId: call.id, userId: me.id }, me.id)

  const stillIn = db.prepare('SELECT COUNT(*) n FROM chat_call_participants WHERE call_id=? AND joined_at IS NOT NULL AND left_at IS NULL').get(call.id).n
  // 'declined' and 'missed' are already terminal and have already filed their
  // line. Without this, the caller hanging up after a decline would land a
  // second "Audio call · 0s" underneath the "Audio call declined" one.
  const settled = ['ended', 'declined', 'missed'].includes(call.status)
  if (stillIn === 0 && !settled) {
    // Nobody ever answered → it was a missed call, not a zero-second one.
    const status = call.answered_at ? 'ended' : 'missed'
    db.prepare('UPDATE chat_calls SET status=?, ended_at=? WHERE id=?').run(status, ts, call.id)
    pushToConversation(call.conversation_id, { type: 'call-ended', callId: call.id })
    const sum = callSummary(call.id)
    postCallLine(conv, sum)
    // Everyone is off the call: what was said becomes its summary and tasks.
    if (status === 'ended') scheduleFinalize(call.id)
    if (status === 'missed') {
      for (const uid of participantsOf(conv.id)) {
        if (uid === call.started_by) continue
        notify(conv.org_id, uid, 'chat_call', `Missed ${call.kind} call from ${db.prepare('SELECT name FROM users WHERE id=?').get(call.started_by)?.name || 'a teammate'}`, null)
      }
    }
  }
  res.json({ ok: true })
})

// May this person add to the call's transcript? Only someone who actually
// joined the call — a group member who never picked up must not be able to
// put words in it, which would then be summarised and assigned in the
// caller's name — and only while it runs, with a short grace for lines and
// recording pieces still on their way when it ended. Not once someone has
// switched transcription off: a line from before the switch does not sneak
// in after it.
function canTranscribe(call, userId) {
  if (!call.transcribe || call.processed_at) return false
  const p = db.prepare('SELECT joined_at FROM chat_call_participants WHERE call_id=? AND user_id=?').get(call.id, userId)
  if (!p?.joined_at) return false
  if (call.status === 'ringing' || call.status === 'active') return true
  return call.status === 'ended' && !!call.ended_at && Date.now() - new Date(call.ended_at).getTime() < 90000
}

// One utterance, from one person's own browser, during a recorded call.
// Deliberately tiny and unvalidated beyond membership: it is called every few
// seconds by every participant, and a slow endpoint here would be felt as the
// call stuttering.
r.post('/call/:id/segment', (req, res) => {
  const me = req.user
  const call = db.prepare('SELECT * FROM chat_calls WHERE id=?').get(req.params.id)
  if (!call || !member(call.conversation_id, me.id)) return res.status(404).json({ error: 'Call not found' })
  if (!canTranscribe(call, me.id)) return res.json({ ok: true, ignored: true })
  const text = String(req.body?.text || '').trim().slice(0, 2000)
  if (!text) return res.json({ ok: true })
  db.prepare('INSERT INTO chat_call_segments (id, call_id, user_id, text, created_at) VALUES (?,?,?,?,?)')
    .run(id('seg'), call.id, me.id, text, now())
  res.json({ ok: true })
})

// A browser that cannot recognise speech itself (Firefox, an iPhone app's
// web view) records its owner's microphone in short pieces and sends each one
// here; the server transcribes it and files it as that person's lines, so
// their half of the call is in the transcript like everyone else's. Needs a
// speech provider key — without one this says so and the call is summarised
// from whoever's browser could listen.
const pendingAudio = new Map()
r.post('/call/:id/audio', smallUpload.single('file'), async (req, res) => {
  const me = req.user
  const drop = () => { if (req.file) try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)) } catch {} }
  const call = db.prepare('SELECT * FROM chat_calls WHERE id=?').get(req.params.id)
  if (!call || !member(call.conversation_id, me.id)) { drop(); return res.status(404).json({ error: 'Call not found' }) }
  if (!req.file) return res.status(400).json({ error: 'file required (field "file")' })
  if (!canTranscribe(call, me.id)) { drop(); return res.json({ ok: true, skipped: true }) }
  pendingAudio.set(call.id, (pendingAudio.get(call.id) || 0) + 1)
  try {
    const buf = fs.readFileSync(path.join(UPLOAD_DIR, req.file.filename))
    const { text } = await transcribeAudio(buf, req.file.originalname || 'call.webm', req.file.mimetype || 'audio/webm')
    const clean = String(text || '').trim().slice(0, 8000)
    if (clean) {
      // Filed at the moment the piece STARTED, so it sits among everyone
      // else's lines in the order things were said.
      const at = new Date(String(req.body?.started_at || ''))
      const when = isNaN(at.getTime()) || at.toISOString() < call.started_at ? now() : at.toISOString()
      db.prepare('INSERT INTO chat_call_segments (id, call_id, user_id, text, created_at) VALUES (?,?,?,?,?)').run(id('seg'), call.id, me.id, clean, when)
    }
    res.json({ ok: true, captured: !!clean })
  } catch (err) {
    res.status(err.code === 'NO_PROVIDER' ? 400 : 502).json({ error: err.message, code: err.code || null })
  } finally {
    drop()
    const n = (pendingAudio.get(call.id) || 1) - 1
    if (n > 0) pendingAudio.set(call.id, n); else pendingAudio.delete(call.id)
  }
})

// "Name: what they said", one line per turn — the shape the extractor already
// expects from a meeting transcript, so attribution survives into the
// suggested assignees. Each recognised utterance is punctuated before being
// joined. The Web Speech API returns them bare, and the extractor splits on
// sentence boundaries — so without this, everything one person said in a row
// becomes one run-on sentence and two separate asks get merged into a single
// unusable task.
function callTranscript(callId) {
  const segs = db.prepare(`
    SELECT s.text, s.created_at, u.name FROM chat_call_segments s
    JOIN users u ON u.id=s.user_id WHERE s.call_id=? ORDER BY s.created_at`).all(callId)
  const punct = (t) => (/[.!?।]$/.test(t.trim()) ? t.trim() : t.trim() + '.')
  const lines = []
  let lastName = null
  for (const sg of segs) {
    if (sg.name === lastName) lines[lines.length - 1] += ' ' + punct(sg.text)
    else { lines.push(`${sg.name}: ${punct(sg.text)}`); lastName = sg.name }
  }
  return { transcript: lines.join('\n'), lines: lines.length }
}

// Run a call's transcript through the SAME meeting pipeline an uploaded
// recording uses — extraction, summary, suggestions — and leave the summary
// card where the call happened. With autoAssign (every call, once it ends)
// each task whose owner was named goes straight to them, exactly as a manager
// pressing "Assign" on the review screen would; a task nobody could be matched
// to stays a suggestion for someone to settle. No audio leaves the browser and
// no speech key is needed for the usual case, because the speech-to-text
// already happened on each participant's device while they were talking.
async function summariseCall(call, actorId, { autoAssign }) {
  const { transcript, lines } = callTranscript(call.id)
  if (!lines) return null
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(call.conversation_id)
  const joined = db.prepare('SELECT DISTINCT user_id FROM chat_call_participants WHERE call_id=? AND joined_at IS NOT NULL').all(call.id).map((x) => x.user_id)
  // Who the work can go to: everyone on the call and, in a group call, the
  // rest of the group — "Ravi will send the quote" is Ravi's even if he missed
  // the call. Nobody outside the conversation can ever be handed anything.
  const pool = [...new Set([...joined, ...(conv ? participantsOf(conv.id) : [])])]
  const attendees = attendeesFor(call.org_id, pool)
  const others = attendees.filter((a) => joined.includes(a.id) && a.id !== actorId).map((a) => a.name)
  const title = conv?.type === 'group' ? `Call — ${conv.name || 'Group'}` : `Call with ${others[0] || 'a teammate'}`
  const meetingDate = now().slice(0, 10)
  const analysis = await analyzeMeetingTranscript(transcript, {
    meetingDate, knownNames: attendees.map((a) => a.name), attendees, summaryLanguage: 'en',
  })
  const { mid, suggestionCount } = persistMeeting(
    { orgId: call.org_id, userId: actorId, title, description: `Transcribed live from ${call.kind === 'audio' ? 'an' : 'a'} ${call.kind} call.`, meetingDate, transcript, sourceType: 'call', participantIds: pool, callKind: call.kind === 'video' ? 'video' : 'audio' },
    analysis)
  // These utterances are now a meeting with a transcript of their own, so
  // drop them. Recording a SECOND stretch of the same call would otherwise
  // re-file everything said in the first one.
  db.prepare('DELETE FROM chat_call_segments WHERE call_id=?').run(call.id)

  let assigned = 0
  if (autoAssign) {
    const owned = db.prepare("SELECT * FROM suggested_tasks WHERE meeting_id=? AND status='pending' AND suggested_assignee_id IS NOT NULL").all(mid)
    db.transaction(() => {
      for (const s of owned) { createTaskFromSuggestion(s, { orgId: call.org_id, actorId, notifyAssignee: true }); assigned++ }
    })()
    if (assigned) audit(call.org_id, actorId, 'meeting.assign', 'meeting', mid, `assigned=${assigned}, automatically at the end of a call`)
  }
  const pending = db.prepare("SELECT COUNT(*) n FROM suggested_tasks WHERE meeting_id=? AND status='pending'").get(mid).n
  db.prepare('UPDATE chat_calls SET meeting_id=? WHERE id=?').run(mid, call.id)

  // Leave the audit where the conversation happened. A summary that lives only
  // in the Meetings list is a summary nobody on the call ever sees again.
  if (conv) {
    const lid = id('msg')
    db.prepare('INSERT INTO chat_messages (id, org_id, conversation_id, sender_id, recipient_id, body, meeting_id, read, created_at) VALUES (?,?,?,?,?,?,?,0,?)')
      .run(lid, call.org_id, conv.id, actorId, '', `Summary of ${title}`, mid, now())
    touchConvo(conv.id)
    const lrow = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(lid)
    for (const uid of participantsOf(conv.id)) {
      pushToUser(uid, { type: 'message', conversationId: conv.id, message: shapeMessage(lrow, uid, {}) })
    }
  }
  for (const uid of joined) pushToUser(uid, { type: 'call-summary', callId: call.id, conversationId: call.conversation_id, meetingId: mid, assigned, pending })
  return { mid, suggestionCount, assigned, pending, engine: analysis.engine, lines }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The end of every call that was answered. A short wait first: the last
// lines spoken are still on their way from people's browsers when the last
// person hangs up, and a recording piece may still be being transcribed.
function scheduleFinalize(callId, delayMs = 4000, tries = 0) {
  setTimeout(() => { finalizeCall(callId, tries).catch((e) => console.error('[chat] call summary failed:', e.message)) }, delayMs)
}
// Claimed in one statement, so the end-of-call path and the manual button
// (older apps) can never both summarise the same call. A claim with no
// meeting after ten minutes is one a crash or restart abandoned mid-way, and
// may be taken again rather than leaving the call stuck for ever.
const STALE_CLAIM_MS = 10 * 60000
const claimCall = (callId) => db.prepare(`UPDATE chat_calls SET processed_at=? WHERE id=? AND meeting_id IS NULL
  AND (processed_at IS NULL OR processed_at < ?)`).run(now(), callId, new Date(Date.now() - STALE_CLAIM_MS).toISOString()).changes > 0
// What was said while transcription was ON is summarised even if someone
// switched it off later — switching off stops capture from that moment, as
// the call's button says; it does not unsay what everyone already heard.
async function finalizeCall(callId, tries = 0) {
  for (let i = 0; i < 120 && (pendingAudio.get(callId) || 0) > 0; i++) await sleep(1000)
  if (!db.prepare('SELECT 1 FROM chat_call_segments WHERE call_id=? LIMIT 1').get(callId)) {
    // A last recording piece can still be on its way; look once more.
    if (tries < 2) scheduleFinalize(callId, 15000, tries + 1)
    return
  }
  if (!claimCall(callId)) return
  const call = db.prepare('SELECT * FROM chat_calls WHERE id=?').get(callId)
  pushToConversation(call.conversation_id, { type: 'call-processing', conversationId: call.conversation_id, callId, on: true })
  try {
    await summariseCall(call, call.started_by, { autoAssign: true })
  } catch (e) {
    console.error('[chat] call summary failed:', e.message)
    db.prepare('UPDATE chat_calls SET processed_at=NULL WHERE id=?').run(callId) // let the manual route retry
  } finally {
    pushToConversation(call.conversation_id, { type: 'call-processing', conversationId: call.conversation_id, callId, on: false })
  }
}

// The manual way in, kept for copies of the app from before calls were
// summarised by themselves (their Record button calls this on hang-up). It
// stops at suggestions for the review screen, as it always did.
r.post('/call/:id/to-tasks', requireRole('manager', 'admin'), async (req, res) => {
  const me = req.user
  const call = db.prepare('SELECT * FROM chat_calls WHERE id=?').get(req.params.id)
  if (!call || !member(call.conversation_id, me.id)) return res.status(404).json({ error: 'Call not found' })
  if (call.meeting_id) {
    const n = db.prepare("SELECT COUNT(*) n FROM suggested_tasks WHERE meeting_id=? AND status='pending'").get(call.meeting_id).n
    return res.status(201).json({ id: call.meeting_id, suggestion_count: n, existing: true })
  }
  if (!db.prepare('SELECT 1 FROM chat_call_segments WHERE call_id=? LIMIT 1').get(call.id)) return res.status(422).json({ error: 'Nothing was captured from this call', code: 'NO_SPEECH' })
  if (!claimCall(call.id)) return res.status(409).json({ error: 'This call is already being summarised' })
  try {
    const out = await summariseCall(call, me.id, { autoAssign: false })
    res.status(201).json({ id: out.mid, suggestion_count: out.suggestionCount, engine: out.engine, lines: out.lines })
  } catch (err) {
    db.prepare('UPDATE chat_calls SET processed_at=NULL WHERE id=?').run(call.id)
    console.error('[chat] call-to-tasks failed:', err.message)
    res.status(502).json({ error: err.message })
  }
})

// Someone turned their camera on mid-call, so an audio call is now a video one.
// Broadcast it so every participant's UI switches to the video layout — the media
// itself needs no renegotiation (see the pre-armed video transceiver in
// CallCenter), but the other side still has to be told to start showing tiles.
r.post('/call/:id/kind', (req, res) => {
  const me = req.user
  const call = db.prepare('SELECT * FROM chat_calls WHERE id=?').get(req.params.id)
  if (!call || !member(call.conversation_id, me.id)) return res.status(404).json({ error: 'Call not found' })
  const kind = req.body?.kind === 'video' ? 'video' : 'audio'
  db.prepare('UPDATE chat_calls SET kind=? WHERE id=?').run(kind, call.id)
  pushToConversation(call.conversation_id, { type: 'call-kind', callId: call.id, kind, by: me.id, byName: me.name })
  res.json({ ok: true, kind })
})

// Switch the call's transcription on or off. Every call starts with it on —
// that is what turns a call into its summary and tasks — and anyone on the
// call may switch it off (or back on). Everyone in the call is told, always: a
// recording nobody was told about is not something this app is going to make
// easy, whatever the local law says.
r.post('/call/:id/recording', (req, res) => {
  const me = req.user
  const call = db.prepare('SELECT * FROM chat_calls WHERE id=?').get(req.params.id)
  if (!call || !member(call.conversation_id, me.id)) return res.status(404).json({ error: 'Call not found' })
  const on = !!req.body?.on
  db.prepare('UPDATE chat_calls SET transcribe=? WHERE id=?').run(on ? 1 : 0, call.id)
  pushToConversation(call.conversation_id, { type: 'call-recording', callId: call.id, on, by: me.id, byName: me.name })
  res.json({ ok: true, on })
})

// The call log — WhatsApp's Calls tab. Every finished call in a conversation
// I am in, newest first: which way it went, whether I missed it, how long it
// ran, and the summary it left behind.
r.get('/calls', (req, res) => {
  const me = req.user
  const rows = db.prepare(`
    SELECT c.*, cv.type AS conv_type, cv.name AS conv_name, cv.avatar_color AS conv_color, cv.avatar_file AS conv_avatar,
      (SELECT joined_at FROM chat_call_participants cp WHERE cp.call_id=c.id AND cp.user_id=?) AS my_joined
    FROM chat_calls c
    JOIN chat_conversations cv ON cv.id=c.conversation_id
    JOIN chat_participants p ON p.conversation_id=c.conversation_id AND p.user_id=?
    WHERE c.org_id=? AND c.status NOT IN ('ringing','active')
    ORDER BY c.started_at DESC LIMIT 150`).all(me.id, me.id, me.org_id)
  const peerOf = db.prepare('SELECT u.id, u.name, u.avatar_color, u.avatar_file FROM chat_participants p JOIN users u ON u.id=p.user_id WHERE p.conversation_id=? AND p.user_id!=? LIMIT 1')
  res.json({ items: rows.map((c) => {
    const direct = c.conv_type === 'direct'
    const peer = direct ? peerOf.get(c.conversation_id, me.id) : null
    const outgoing = c.started_by === me.id
    return {
      id: c.id, conversation_id: c.conversation_id, type: c.conv_type,
      name: direct ? (peer?.name || 'Unknown') : (c.conv_name || 'Group'),
      avatar_color: direct ? (peer?.avatar_color || null) : c.conv_color,
      avatar_file: direct ? (peer?.avatar_file || null) : (c.conv_avatar || null),
      other_user_id: peer?.id || null,
      kind: c.kind, status: c.status, outgoing,
      missed: !outgoing && !c.my_joined,
      started_at: c.started_at,
      duration_sec: c.answered_at && c.ended_at ? Math.max(0, Math.round((new Date(c.ended_at) - new Date(c.answered_at)) / 1000)) : 0,
      meeting_id: c.meeting_id || null,
    }
  }) })
})

// The call I am STILL IN, wherever I am. A browser that is closed, killed or
// backgrounded never sends /end, so the server still has me as present — which
// is exactly the state that lets a new tab, or a different device entirely, walk
// straight back in without being asked.
r.get('/calls/active', (req, res) => {
  const me = req.user
  const row = db.prepare(`
    SELECT c.* FROM chat_calls c
    JOIN chat_call_participants p ON p.call_id=c.id AND p.user_id=?
    WHERE c.status IN ('ringing','active') AND p.joined_at IS NOT NULL AND p.left_at IS NULL
    ORDER BY c.started_at DESC LIMIT 1`).get(me.id)
  if (!row) return res.json({ call: null })
  const conv = db.prepare('SELECT type, name FROM chat_conversations WHERE id=?').get(row.conversation_id)
  const others = db.prepare(`
    SELECT u.name FROM chat_call_participants p JOIN users u ON u.id=p.user_id
    WHERE p.call_id=? AND p.user_id!=?`).all(row.id, me.id).map((x) => x.name)
  res.json({ call: {
    ...row,
    peers: callPeers(row.id, me.id),
    title: conv?.type === 'group' ? (conv.name || 'Group') : (others[0] || 'Call'),
  } })
})

// Current live call in a conversation, so a refresh mid-call can rejoin.
r.get('/conversations/:id/call', (req, res) => {
  if (!member(req.params.id, req.user.id)) return res.status(404).json({ error: 'Not found' })
  const call = liveCall(req.params.id)
  if (!call) return res.json({ call: null })
  res.json({ call: { ...call, peers: callPeers(call.id, req.user.id) } })
})

// ---------- chat → task ----------

// Strip the chat out of a sentence so it can be a task title: the @names, the
// greeting, the "please can you". What's left is the instruction itself.
function titleFromText(text, mentionNames = []) {
  let t = String(text || '').split('\n').find((l) => l.trim()) || ''
  for (const n of mentionNames) {
    for (const form of [n, n.split(' ')[0]]) {
      if (form) t = t.replace(new RegExp('@' + form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), ' ')
    }
  }
  t = t.replace(/@all\b/gi, ' ').replace(/\s+/g, ' ').trim()
  // "Great, thanks. Can you write down what broke?" — the work is in the
  // second sentence. A short opener of three words or fewer ("Great,
  // thanks.", "Ok.", "Hi Ravi!") is courtesy, not the task, so it is dropped
  // when something longer follows it.
  // An @name still in the text (typed, not picked) is who it is for, not part
  // of the opener, so it is not counted as one of its words.
  const words = (s) => s.replace(/@\S+(\s+[A-Z][\p{L}]*)?/gu, ' ').trim().split(/\s+/).filter(Boolean).length
  for (let i = 0; i < 3; i++) {
    const m = /^([^.!?।]{1,50}[.!?।]+)\s+(\S[\s\S]*)$/.exec(t)
    if (!m || words(m[1]) > 3 || words(m[2]) < 3) break
    t = m[2].trim()
  }
  // A name said out loud leads the sentence the same way an @mention does
  // ("Ravi, can you…"). It is already captured as the assignee, so leaving it
  // in the title just repeats it on every card.
  for (const n of mentionNames) {
    for (const form of [n, n.split(' ')[0]]) {
      if (form && form.length >= 3) t = t.replace(new RegExp('^' + form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b[\\s,:-]*', 'i'), '')
    }
  }
  t = t.trim()
  // Looped, because real messages stack these: "Hey team, please can you…".
  const LEAD = /^(hi|hey|hello|team|guys|folks|all|please|pls|plz|kindly|can you|could you|can u|would you|need you to|i need you to)\b[\s,:-]*/i
  for (let i = 0; i < 4 && LEAD.test(t); i++) t = t.replace(LEAD, '')
  t = t.trim()
  // A title is one instruction: its first sentence, without the full stop or
  // question mark ("Write down what broke?" is a request, not a question, by
  // the time it is a task). The rest of the message stays in the description.
  const stop = t.search(/[.!?।](\s|$)/)
  if (stop > 12) t = t.slice(0, stop)
  t = t.replace(/[.!?।]+$/, '').trim()
  // Long messages: keep the first sentence, else the first clause, else cut on a
  // word boundary. A title chopped mid-word reads like a bug, and one chopped
  // mid-clause ("…users cannot sign in on") reads like a truncated thought.
  if (t.length > 80) {
    const head = t.slice(0, 90)
    const sentence = head.search(/[.!?।]\s/)
    const clause = head.indexOf(', ')
    if (sentence > 12) t = t.slice(0, sentence)
    else if (clause > 12) t = t.slice(0, clause)
    else { const cut = t.slice(0, 80); t = cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : 80) }
  }
  return (t.charAt(0).toUpperCase() + t.slice(1)).trim()
}

// Build the pre-filled task from a message id, or from text still in the composer.
// Deliberately rule-based and not an LLM call: this answers on every press of the
// + button, and per extractor.js the app must keep working with no API keys at all.
r.post('/task-draft', async (req, res) => {
  const me = req.user
  let text = String(req.body?.text || '')
  let mentionIds = Array.isArray(req.body?.mentions) ? req.body.mentions.map(String) : []
  let sourceSender = me.id
  let convId = null

  if (req.body?.messageId) {
    const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.body.messageId)
    if (!m || m.deleted_for_all || !member(m.conversation_id, me.id)) return res.status(404).json({ error: 'Message not found' })
    text = m.body || ''
    sourceSender = m.sender_id
    convId = m.conversation_id
    mentionIds = db.prepare('SELECT user_id FROM chat_mentions WHERE message_id=?').all(m.id).map((x) => x.user_id)

    // A VOICE NOTE carries its content in the transcript, not the body. Reading
    // file_name here was the bug: every spoken task became a task called
    // "voice-note.webm". The words are what the task is made of.
    const isVoice = m.file_stored && (m.file_type || '').startsWith('audio/')
    if (!text.trim() && m.transcript) text = m.transcript
    else if (m.transcript && isVoice) text = m.transcript   // caption + speech: the speech is the substance

    // Not transcribed yet (recorded on Safari/iOS, or before this existed) —
    // transcribe it now rather than making the user press two buttons. Cached
    // on the message, so this happens at most once per note.
    if (!text.trim() && isVoice) {
      try {
        const buf = readForTranscription(path.join(UPLOAD_DIR, m.file_stored))
        const out = await transcribeAudio(buf, m.file_name || 'voice.webm', m.file_type || 'audio/webm')
        const clean = String(out.text || '').trim()
        if (clean) {
          db.prepare('UPDATE chat_messages SET transcript=? WHERE id=?').run(clean, m.id)
          pushToConversation(m.conversation_id, { type: 'transcript', conversationId: m.conversation_id, id: m.id, transcript: clean })
          text = clean
        }
      } catch (err) {
        // Too long to transcribe ever: it is a bare attachment, and gets its
        // file name as the title below, like any other.
        if (err.code !== 'TOO_LARGE') return res.status(422).json({
          error: 'This voice note has no text yet, so there is nothing to build a task from. Play it and press "Read it as text" first, or set a speech provider on the server.',
          code: 'NO_TRANSCRIPT',
        })
      }
    }

    if (!text.trim() && m.file_name) text = m.file_name // a bare attachment still deserves a title
  }
  if (!text.trim()) return res.status(400).json({ error: 'Nothing to turn into a task' })

  const mentioned = mentionIds.length
    ? db.prepare(`SELECT id, name FROM users WHERE org_id=? AND id IN (${mentionIds.map(() => '?').join(',')})`).all(me.org_id, ...mentionIds)
    : []
  const body = text.trim()
  // The person named in the message is who the work is for — that is what naming
  // them meant. Never the sender: "@Ravi please do X" is not a task for whoever
  // typed it. An ambiguous multi-name message leaves the picker empty on purpose.
  let target = mentioned.find((u) => u.id !== sourceSender) || null

  // Nobody @mentioned — which is always the case for speech, because you cannot
  // say an @. Look for a teammate's name in the words themselves. Scoped to the
  // people in THIS conversation, so "ask Priya" can only ever resolve to a Priya
  // who is actually in the room, and never to a stranger with a common name.
  if (!target && convId) {
    const inRoom = db.prepare(`
      SELECT u.id, u.name, u.aliases FROM chat_participants p JOIN users u ON u.id=p.user_id
      WHERE p.conversation_id=? AND u.id!=?`).all(convId, sourceSender)
    const hay = ' ' + body.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ') + ' '
    const said = (form) => form.length >= 3 && hay.includes(' ' + form.trim().toLowerCase() + ' ')

    // Matched in tiers, strongest first. A shared first name must not drown out
    // a full name: on a team of "Employee 1..30" every one of them matches
    // "employee", so a flat search finds thirty candidates and gives up — while
    // the message plainly said "Employee 1". The same holds for a real team with
    // a Ravi Kumar and a Ravi Shankar: "Ravi" is genuinely ambiguous and is left
    // alone, "Ravi Kumar" is not.
    const byFullName = inRoom.filter((u) => said(u.name))
    const byAlias = inRoom.filter((u) => String(u.aliases || '').split(',').some((a) => said(a)))
    const byFirstName = inRoom.filter((u) => said(u.name.split(' ')[0]))

    // Exactly one candidate in a tier is a decision; more than one is a guess,
    // and guessing who owns a task is not a recoverable mistake — so ambiguity
    // leaves the picker empty for a human to settle.
    const decided = [byFullName, byAlias, byFirstName].find((tier) => tier.length === 1)
    if (decided) target = { id: decided[0].id, name: decided[0].name }
  }
  // Title last: it strips the names of whoever the message was addressed to,
  // which is only known once the assignee has been resolved above.
  const addressed = [...mentioned.map((u) => u.name), ...(target ? [target.name] : [])]
  const title = titleFromText(text, addressed) || body.slice(0, 80)

  const due = parseDueDate(body, new Date().toISOString().slice(0, 10))
  res.json({
    title,
    description: body === title ? '' : body,
    priority: detectPriority(body),
    due_date: due?.date || '',
    assignee_id: target ? target.id : '',
    assignee_name: target ? target.name : null,
  })
})

// ---------- pinned messages ----------
// A pinned MESSAGE belongs to the thread, so everyone sees the same pins (unlike
// a pinned conversation, which is your own private ordering).
r.post('/message/:id/pin', (req, res) => {
  const me = req.user
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || m.deleted_for_all || !member(m.conversation_id, me.id)) return res.status(404).json({ error: 'Message not found' })
  db.prepare('UPDATE chat_messages SET pinned_at=?, pinned_by=? WHERE id=?').run(now(), me.id, m.id)
  pushToConversation(m.conversation_id, { type: 'pin', conversationId: m.conversation_id, id: m.id, pinned: true })
  res.json({ ok: true })
})
r.delete('/message/:id/pin', (req, res) => {
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || !member(m.conversation_id, req.user.id)) return res.status(404).json({ error: 'Message not found' })
  db.prepare('UPDATE chat_messages SET pinned_at=NULL, pinned_by=NULL WHERE id=?').run(m.id)
  pushToConversation(m.conversation_id, { type: 'pin', conversationId: m.conversation_id, id: m.id, pinned: false })
  res.json({ ok: true })
})
r.get('/conversations/:id/pinned', (req, res) => {
  if (!member(req.params.id, req.user.id)) return res.status(404).json({ error: 'Not found' })
  const rows = db.prepare('SELECT * FROM chat_messages WHERE conversation_id=? AND pinned_at IS NOT NULL AND deleted_for_all=0 ORDER BY pinned_at DESC LIMIT 20').all(req.params.id)
  res.json({ items: rows.map((row) => shapeMessage(row, req.user.id, {})) })
})

// ---------- mark as unread ----------
// Rewind my read cursor to just before this message, which is exactly what
// "leave this for later" means — no extra column, and the unread divider and
// badge both already read from last_read_at.
r.post('/conversations/:id/unread', (req, res) => {
  const me = req.user
  if (!member(req.params.id, me.id)) return res.status(404).json({ error: 'Not found' })
  const m = db.prepare('SELECT created_at FROM chat_messages WHERE id=? AND conversation_id=?').get(req.body?.messageId, req.params.id)
  if (!m) return res.status(404).json({ error: 'Message not found' })
  const before = new Date(new Date(m.created_at).getTime() - 1).toISOString()
  // The read receipt keeps where it got to (read_receipt_at, filled in here for
  // rows from before it existed): leaving something for later is not unreading
  // it as far as the sender's blue ticks are concerned.
  db.prepare('UPDATE chat_participants SET read_receipt_at=COALESCE(read_receipt_at, last_read_at), last_read_at=? WHERE conversation_id=? AND user_id=?').run(before, req.params.id, me.id)
  res.json({ ok: true, last_read_at: before })
})

// Export chat: every message I can still see, oldest first, as data — the
// browser writes the .txt in WhatsApp's export layout, in the reader's own
// time zone (this server runs on UTC).
r.get('/conversations/:id/export', (req, res) => {
  const me = req.user
  if (!member(req.params.id, me.id)) return res.status(404).json({ error: 'Not found' })
  const rows = db.prepare(`
    SELECT * FROM chat_messages WHERE conversation_id=?
      AND id NOT IN (SELECT message_id FROM chat_message_hidden WHERE user_id=?)
    ORDER BY created_at ASC`).all(req.params.id, me.id)
  const names = {}
  const who = (uid) => names[uid] || (names[uid] = nameOf(uid))
  res.json({ items: rows.map((row) => {
    let text
    if (row.deleted_for_all) text = row.sender_id === me.id ? 'You deleted this message' : 'This message was deleted'
    else if (row.kind === 'system') text = systemText(parseMeta(row), me.id)
    else if (row.kind === 'poll') {
      const p = pollOf(row.id)
      text = `POLL:\n${row.body}\n` + (p?.options || []).map((o) => `OPTION: ${o.text} (${o.voters.length} vote${o.voters.length === 1 ? '' : 's'})`).join('\n')
    } else if (row.kind === 'location') {
      const g = parseMeta(row)
      text = `location: https://maps.google.com/?q=${g.lat},${g.lng}`
    } else if (row.file_stored) text = `${row.file_name} (file attached)${row.body ? '\n' + row.body : ''}`
    else text = snippet(row, me.id)
    return { at: row.created_at, sender: who(row.sender_id), text, event: row.kind === 'system' || !!row.call_id || !!row.meeting_id }
  }) })
})

// ---------- reminders ----------
r.post('/message/:id/remind', (req, res) => {
  const me = req.user
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || !member(m.conversation_id, me.id)) return res.status(404).json({ error: 'Message not found' })
  const at = new Date(req.body?.remind_at || '')
  if (isNaN(at.getTime())) return res.status(400).json({ error: 'A valid remind_at is required' })
  const rid = id('rem')
  db.prepare('INSERT INTO chat_reminders (id, org_id, user_id, message_id, conversation_id, note, remind_at, sent, created_at) VALUES (?,?,?,?,?,?,?,0,?)')
    .run(rid, m.org_id, me.id, m.id, m.conversation_id, String(req.body?.note || '').slice(0, 200), at.toISOString(), now())
  res.status(201).json({ id: rid, remind_at: at.toISOString() })
})
r.get('/reminders', (req, res) => {
  const rows = db.prepare('SELECT * FROM chat_reminders WHERE user_id=? AND sent=0 ORDER BY remind_at').all(req.user.id)
  res.json({ items: rows.map((x) => {
    const m = x.message_id ? db.prepare('SELECT body, file_name FROM chat_messages WHERE id=?').get(x.message_id) : null
    return { ...x, preview: m ? (m.body || m.file_name || '') : x.note }
  }) })
})
r.delete('/reminders/:id', (req, res) => {
  db.prepare('DELETE FROM chat_reminders WHERE id=? AND user_id=?').run(req.params.id, req.user.id)
  res.json({ ok: true })
})

// ---------- scheduled messages ----------
r.post('/conversations/:id/schedule', (req, res) => {
  const me = req.user
  if (!member(req.params.id, me.id)) return res.status(404).json({ error: 'Not found' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  const body = String(req.body?.body || '').trim()
  if (!body) return res.status(400).json({ error: 'Message body required' })
  const at = new Date(req.body?.send_at || '')
  if (isNaN(at.getTime())) return res.status(400).json({ error: 'A valid send_at is required' })
  if (at.getTime() < Date.now() - 60000) return res.status(400).json({ error: 'Pick a time in the future' })
  const sid = id('sch')
  const mentions = Array.isArray(req.body?.mentions) ? req.body.mentions.join(',') : ''
  db.prepare('INSERT INTO chat_scheduled (id, org_id, conversation_id, sender_id, body, mentions, send_at, sent, created_at) VALUES (?,?,?,?,?,?,?,0,?)')
    .run(sid, conv.org_id, conv.id, me.id, body, mentions, at.toISOString(), now())
  res.status(201).json({ id: sid, send_at: at.toISOString(), body })
})
r.get('/scheduled', (req, res) => {
  const rows = db.prepare('SELECT * FROM chat_scheduled WHERE sender_id=? AND sent=0 ORDER BY send_at').all(req.user.id)
  res.json({ items: rows.map((x) => {
    const c = db.prepare('SELECT type, name FROM chat_conversations WHERE id=?').get(x.conversation_id)
    return { ...x, conversation_name: c?.type === 'group' ? (c.name || 'Group') : directName(x.conversation_id, req.user.id) }
  }) })
})
r.delete('/scheduled/:id', (req, res) => {
  db.prepare('DELETE FROM chat_scheduled WHERE id=? AND sender_id=?').run(req.params.id, req.user.id)
  res.json({ ok: true })
})
const directName = (convId, viewerId) =>
  db.prepare('SELECT u.name FROM chat_participants p JOIN users u ON u.id=p.user_id WHERE p.conversation_id=? AND p.user_id!=? LIMIT 1').get(convId, viewerId)?.name || 'Chat'

// ---------- global search ----------
// Across every conversation I'm in, which is the one search Cliq has and we did
// not: the in-thread filter only ever looked at the thread already open.
r.get('/search', (req, res) => {
  const me = req.user
  const q = String(req.query.q || '').trim()
  if (q.length < 2) return res.json({ items: [] })
  const rows = db.prepare(`
    SELECT m.* FROM chat_messages m
    JOIN chat_participants p ON p.conversation_id=m.conversation_id AND p.user_id=?
    WHERE m.deleted_for_all=0 AND (m.body LIKE ? OR m.file_name LIKE ?)
      AND COALESCE(m.kind,'')<>'system'
      AND m.id NOT IN (SELECT message_id FROM chat_message_hidden WHERE user_id=?)
    ORDER BY m.created_at DESC LIMIT 60`).all(me.id, `%${q}%`, `%${q}%`, me.id)
  const names = {}
  res.json({ items: rows.map((row) => {
    const c = db.prepare('SELECT type, name FROM chat_conversations WHERE id=?').get(row.conversation_id)
    const sender = names[row.sender_id] || (names[row.sender_id] = db.prepare('SELECT name FROM users WHERE id=?').get(row.sender_id)?.name || 'Unknown')
    return {
      ...shapeMessage(row, me.id, {}),
      sender_name: sender,
      conversation_name: c?.type === 'group' ? (c.name || 'Group') : directName(row.conversation_id, me.id),
      conversation_type: c?.type || 'direct',
    }
  }) })
})

// ---------- shared files / media in a conversation ----------
r.get('/conversations/:id/media', (req, res) => {
  if (!member(req.params.id, req.user.id)) return res.status(404).json({ error: 'Not found' })
  const rows = db.prepare(`
    SELECT * FROM chat_messages WHERE conversation_id=? AND file_stored IS NOT NULL AND deleted_for_all=0
      AND id NOT IN (SELECT message_id FROM chat_message_hidden WHERE user_id=?)
    ORDER BY created_at DESC LIMIT 200`).all(req.params.id, req.user.id)
  const names = {}
  res.json({ items: rows.map((row) => ({
    ...shapeMessage(row, req.user.id, {}),
    sender_name: names[row.sender_id] || (names[row.sender_id] = db.prepare('SELECT name FROM users WHERE id=?').get(row.sender_id)?.name || 'Unknown'),
  })) })
})

// ---------- links shared in a conversation ----------
// The Links tab of the chat info panel: every web address in the messages this
// person can still see — the same filter as /media above (not deleted for
// everyone, not hidden by their own "clear chat") — newest first, one row per
// address per message. Asked of the server rather than read off the open
// thread, which loads only part of a long chat.
//
// "A link" is exactly what the thread makes clickable (Chats.tsx MessageText
// and renderInline): ``` blocks come out first, then `code`, *bold*, _italic_
// and ~strike~ win over a URL inside them in one alternation, so only bare URL
// tokens are links. Matching URLs alone listed "https://x.com*" for a bolded
// address, with a broken host to go with it.
const LINK_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/gi
const INLINE_RE = new RegExp(['`[^`\\n]+`', '\\*[^*\\n]+\\*', '_[^_\\n]+_', '~[^~\\n]+~', LINK_RE.source].join('|'), 'gi')
const linksIn = (body) => [...new Set(String(body || '').split(/```[\s\S]*?```/)
  .flatMap((seg) => (seg.match(INLINE_RE) || []).filter((t) => /^https?:\/\//i.test(t))))]
r.get('/conversations/:id/links', (req, res) => {
  if (!member(req.params.id, req.user.id)) return res.status(404).json({ error: 'Not found' })
  const rows = db.prepare(`
    SELECT id, sender_id, body, created_at FROM chat_messages
    WHERE conversation_id=? AND deleted_for_all=0 AND body LIKE '%http%'
      AND id NOT IN (SELECT message_id FROM chat_message_hidden WHERE user_id=?)
    ORDER BY created_at DESC LIMIT 1000`).all(req.params.id, req.user.id)
  const names = {}
  const items = []
  for (const row of rows) {
    for (const url of linksIn(row.body)) {
      let host
      try { host = new URL(url).hostname.replace(/^www\./, '') } catch { continue }
      items.push({
        id: row.id, url, host, created_at: row.created_at, sender_id: row.sender_id,
        sender_name: names[row.sender_id] || (names[row.sender_id] = db.prepare('SELECT name FROM users WHERE id=?').get(row.sender_id)?.name || 'Unknown'),
      })
      if (items.length >= 300) break
    }
    if (items.length >= 300) break
  }
  res.json({ items })
})

// ---------- public channels ----------
// Cliq's org-wide channels: a room anyone can find and walk into, as against the
// invite-only groups this app had. Creating one is still manager-only (it is a
// group), but JOINING one is not — that is the whole point of it being public.
r.get('/channels', (req, res) => {
  const me = req.user
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM chat_participants p WHERE p.conversation_id=c.id) AS member_count,
      EXISTS(SELECT 1 FROM chat_participants p2 WHERE p2.conversation_id=c.id AND p2.user_id=?) AS joined
    FROM chat_conversations c
    WHERE c.org_id=? AND c.type='group' AND c.visibility='public'
    ORDER BY joined DESC, member_count DESC`).all(me.id, me.org_id)
  res.json({ channels: rows.map((c) => ({
    id: c.id, name: c.name || 'Channel', avatar_color: c.avatar_color, avatar_file: c.avatar_file || null,
    member_count: c.member_count, joined: !!c.joined, created_at: c.created_at,
  })) })
})

r.post('/channels/:id/join', (req, res) => {
  const me = req.user
  const conv = db.prepare("SELECT * FROM chat_conversations WHERE id=? AND org_id=? AND type='group'").get(req.params.id, me.org_id)
  if (!conv || conv.visibility !== 'public') return res.status(404).json({ error: 'Channel not found' })
  if (member(conv.id, me.id)) return res.json(summarizeConvo(conv, me.id))
  const ts = now()
  db.prepare('INSERT OR IGNORE INTO chat_participants (conversation_id, user_id, role, last_read_at, joined_at) VALUES (?,?,?,?,?)')
    .run(conv.id, me.id, 'member', ts, ts)
  postSystem(conv, me.id, { action: 'joined' })
  pushToConversation(conv.id, { type: 'conversation', action: 'updated', conversationId: conv.id })
  res.status(201).json(summarizeConvo(conv, me.id))
})

// Open a private group up, or close a public one. Group admins only — the same
// people who can rename it or remove members.
r.post('/conversations/:id/visibility', (req, res) => {
  const me = req.user
  const p = member(req.params.id, me.id)
  if (!p) return res.status(404).json({ error: 'Not found' })
  if (p.role !== 'admin') return res.status(403).json({ error: 'Only a group admin can change this' })
  const visibility = req.body?.visibility === 'public' ? 'public' : 'private'
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  db.prepare('UPDATE chat_conversations SET visibility=? WHERE id=?').run(visibility, req.params.id)
  if ((conv.visibility || 'private') !== visibility) postSystem(conv, me.id, { action: 'visibility', to: visibility })
  pushToConversation(req.params.id, { type: 'conversation', action: 'updated', conversationId: req.params.id })
  res.json({ ok: true, visibility })
})

// ---------- fork a message into its own thread ----------
// Cliq's "fork": a side conversation that starts WITH the message that caused it,
// so the new room does not open on an empty screen that nobody has the context
// for. Creating a group is manager-gated everywhere else in this file, and a fork
// creates a group, so it is gated identically — otherwise it would be the loophole.
r.post('/message/:id/fork', (req, res) => {
  const me = req.user
  if (me.role !== 'manager' && me.role !== 'admin') return res.status(403).json({ error: 'Only managers can create groups' })
  const src = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!src || src.deleted_for_all || !member(src.conversation_id, me.id)) return res.status(404).json({ error: 'Message not found' })

  const name = String(req.body?.name || '').trim() || (src.body || 'Side thread').slice(0, 40)
  const requested = Array.isArray(req.body?.memberIds) ? req.body.memberIds : participantsOf(src.conversation_id)
  const valid = db.prepare(`SELECT id FROM users WHERE org_id=? AND id IN (${requested.map(() => '?').join(',') || "''"})`)
    .all(me.org_id, ...requested).map((u) => u.id)

  const cid = id('cv')
  const ts = now()
  const colors = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#06b6d4']
  db.prepare('INSERT INTO chat_conversations (id, org_id, type, name, avatar_color, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(cid, me.org_id, 'group', name, colors[name.length % colors.length], me.id, ts, ts)
  db.prepare('INSERT INTO chat_participants (conversation_id, user_id, role, last_read_at, joined_at) VALUES (?,?,?,?,?)').run(cid, me.id, 'admin', ts, ts)
  for (const uid of valid) if (uid !== me.id) db.prepare('INSERT OR IGNORE INTO chat_participants (conversation_id, user_id, role, last_read_at, joined_at) VALUES (?,?,?,?,?)').run(cid, uid, 'member', null, ts)

  // Carry the message across as the opening line, attributed to whoever said it.
  const origin = db.prepare('SELECT name FROM users WHERE id=?').get(src.sender_id)?.name || 'Someone'
  const mid = id('msg')
  const carried = src.file_name && !src.body ? `📎 ${src.file_name}` : (src.body || '')
  db.prepare('INSERT INTO chat_messages (id, org_id, conversation_id, sender_id, recipient_id, body, forwarded, read, created_at) VALUES (?,?,?,?,?,?,1,0,?)')
    .run(mid, me.org_id, cid, me.id, '', `Forked from ${origin}: "${carried}"`, ts)

  pushToConversation(cid, { type: 'conversation', action: 'created', conversationId: cid })
  for (const uid of valid) if (uid !== me.id) notify(me.org_id, uid, 'chat_message', `${me.name} started "${name}" from a message`, null)
  res.status(201).json(summarizeConvo(db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(cid), me.id))
})

// ---------- transcribe a voice note ----------
// The multilingual bet, applied to chat: a colleague sends thirty seconds of
// Telugu and anyone can read it. Cached on the message, because transcription
// costs money per call and the second person to open it must not pay again.
r.post('/message/:id/transcribe', async (req, res) => {
  const me = req.user
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || !member(m.conversation_id, me.id)) return res.status(404).json({ error: 'Message not found' })
  if (!m.file_stored || !(m.file_type || '').startsWith('audio/')) return res.status(400).json({ error: 'That message is not a voice note' })
  if (m.transcript) return res.json({ text: m.transcript, cached: true })
  // The row can outlive its file (a restore from a DB-only backup, a disk that
  // was not carried across). Say which it is, rather than surfacing a raw ENOENT.
  const notePath = path.join(UPLOAD_DIR, m.file_stored)
  if (!fs.existsSync(notePath)) return res.status(410).json({ error: 'The audio for this voice note is no longer on the server, so it cannot be transcribed.', code: 'FILE_MISSING' })
  try {
    const buf = readForTranscription(notePath)
    const { text } = await transcribeAudio(buf, m.file_name || 'voice.webm', m.file_type || 'audio/webm')
    const clean = String(text || '').trim()
    if (!clean) return res.status(422).json({ error: 'Nothing could be made out in that recording' })
    db.prepare('UPDATE chat_messages SET transcript=? WHERE id=?').run(clean, m.id)
    pushToConversation(m.conversation_id, { type: 'transcript', conversationId: m.conversation_id, id: m.id, transcript: clean })
    res.json({ text: clean, cached: false })
  } catch (err) {
    console.error('[chat] voice transcription failed:', err.message)
    res.status(err.code === 'NO_PROVIDER' ? 400 : err.code === 'TOO_LARGE' ? 413 : 502).json({ error: err.message, code: err.code || null })
  }
})

// Turn a recorded call (or any voice note) sitting in the chat into a meeting
// summary with reviewable tasks.
//
// The live path needs speech recognised DURING the call; when that is not
// available the audio is still kept in the thread, and this is how it gets
// used. It is also the retry: add a transcription provider later and every
// recording already in the chat becomes summarisable, instead of being lost
// because the key arrived a day too late.
r.post('/message/:id/to-meeting', requireRole('manager', 'admin'), async (req, res) => {
  const me = req.user
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || m.deleted_for_all || !member(m.conversation_id, me.id)) return res.status(404).json({ error: 'Message not found' })
  if (!m.file_stored || !(m.file_type || '').startsWith('audio/')) return res.status(400).json({ error: 'That message has no recording' })
  if (m.meeting_id) return res.json({ id: m.meeting_id, existing: true })

  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(m.conversation_id)
  try {
    // A call recording is long, so prefer Whisper when a key is present —
    // Sarvam's instant endpoint rejects audio over 30 seconds (same reasoning
    // as the meetings upload route).
    const recPath = path.join(UPLOAD_DIR, m.file_stored)
    if (!fs.existsSync(recPath)) return res.status(410).json({ error: 'The recording is no longer on the server, so it cannot be summarised.', code: 'FILE_MISSING' })
    const buf = readForTranscription(recPath)
    const provider = process.env.OPENAI_API_KEY ? 'openai' : undefined
    const { text } = await transcribeAudio(buf, m.file_name || 'call.webm', m.file_type || 'audio/webm', { provider })
    const transcript = String(text || '').trim()
    if (!transcript) return res.status(422).json({ error: 'Nothing could be made out in that recording' })

    db.prepare('UPDATE chat_messages SET transcript=? WHERE id=?').run(transcript, m.id)
    const participantIds = participantsOf(m.conversation_id)
    const attendees = attendeesFor(me.org_id, participantIds)
    const meetingDate = now().slice(0, 10)
    const analysis = await analyzeMeetingTranscript(transcript, {
      meetingDate, knownNames: attendees.map((a) => a.name), attendees, summaryLanguage: 'en',
    })
    const title = conv?.type === 'group' ? `Call — ${conv.name || 'Group'}` : `Call with ${attendees.filter((a) => a.id !== me.id)[0]?.name || 'a teammate'}`
    // Audio or video, for the review screen's heading. Only the app's own call
    // recordings (older CallCenters posted them as call-recording-HHMM) can say,
    // and the upload carries no call id, so the call is matched by time: the one
    // call in this chat the recorder was on, with the recording posted between
    // its start and fifteen minutes after its end. Two candidates is a guess, and
    // a guess would name the wrong kind of call, so it is then left unnamed.
    let callKind = null
    if (/^call-recording/i.test(m.file_name || '')) {
      const hits = db.prepare(`
        SELECT k.kind FROM chat_calls k
        JOIN chat_call_participants p ON p.call_id=k.id AND p.user_id=?
        WHERE k.conversation_id=? AND k.org_id=?
          AND julianday(?) BETWEEN julianday(k.started_at) AND julianday(COALESCE(k.ended_at, ?)) + 15.0/1440
        LIMIT 2`).all(m.sender_id, m.conversation_id, me.org_id, m.created_at, m.created_at)
      if (hits.length === 1) callKind = hits[0].kind === 'video' ? 'video' : 'audio'
    }
    const { mid, suggestionCount } = persistMeeting(
      { orgId: me.org_id, userId: me.id, title, description: 'Transcribed from a recording in the chat.', meetingDate, transcript, sourceType: 'call', participantIds, callKind },
      analysis)

    // Point the recording at its summary, and drop the audit card in the thread.
    db.prepare('UPDATE chat_messages SET meeting_id=? WHERE id=?').run(mid, m.id)
    const lid = id('msg')
    db.prepare('INSERT INTO chat_messages (id, org_id, conversation_id, sender_id, recipient_id, body, meeting_id, read, created_at) VALUES (?,?,?,?,?,?,?,0,?)')
      .run(lid, me.org_id, m.conversation_id, me.id, '', `Summary of ${title}`, mid, now())
    touchConvo(m.conversation_id)
    const lrow = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(lid)
    for (const uid of participantIds) pushToUser(uid, { type: 'message', conversationId: m.conversation_id, message: shapeMessage(lrow, uid, {}) })

    res.status(201).json({ id: mid, suggestion_count: suggestionCount, engine: analysis.engine })
  } catch (err) {
    console.error('[chat] recording -> meeting failed:', err.message)
    res.status(err.code === 'NO_PROVIDER' ? 400 : err.code === 'TOO_LARGE' ? 413 : 502).json({ error: err.message, code: err.code || null })
  }
})

// ---------- workload, for the accountability chips ----------
// The thing a chat tool cannot normally tell you: how much this person is already
// carrying, shown at the moment you are about to hand them more. One grouped
// query for the whole org rather than a lookup per name — the mention picker
// renders six candidates at a time and must not fire six requests to do it.
//
// PRIVATE tasks are excluded (visible_to_manager=0). A count is not much, but it
// is still someone else's private list, and it is not this feature's to spend.
r.get('/workload', (req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const rows = db.prepare(`
    SELECT assignee_id AS user_id,
           COUNT(*) AS open,
           SUM(CASE WHEN due_date IS NOT NULL AND due_date <> '' AND due_date < ? THEN 1 ELSE 0 END) AS overdue
    FROM tasks
    WHERE org_id=? AND assignee_id IS NOT NULL AND assignee_id <> ''
      AND status NOT IN ('Done') AND COALESCE(visible_to_manager, 1) = 1
    GROUP BY assignee_id`).all(today, req.user.org_id)
  const byUser = {}
  for (const r0 of rows) byUser[r0.user_id] = { open: r0.open, overdue: r0.overdue || 0 }
  res.json({ byUser })
})

// ---------- custom status / do-not-disturb ----------
r.get('/status', (req, res) => {
  res.json(db.prepare('SELECT status_text, status_emoji, dnd_until FROM users WHERE id=?').get(req.user.id) || { status_text: '', status_emoji: '', dnd_until: null })
})
r.post('/status', (req, res) => {
  const me = req.user
  const text = String(req.body?.status_text ?? '').slice(0, 80)
  const emoji = String(req.body?.status_emoji ?? '').slice(0, 8)
  // dnd_minutes: 0 or absent clears DND, a number sets an expiry. A timestamp
  // rather than a flag so nobody stays silenced because they forgot to switch
  // it off — the single most common complaint about DND anywhere.
  let dnd = null
  const mins = Number(req.body?.dnd_minutes || 0)
  if (mins > 0) dnd = new Date(Date.now() + mins * 60000).toISOString()
  db.prepare('UPDATE users SET status_text=?, status_emoji=?, dnd_until=? WHERE id=?').run(text, emoji, dnd, me.id)
  const row = db.prepare('SELECT status_text, status_emoji, dnd_until FROM users WHERE id=?').get(me.id)
  broadcastStatus(me.id, row)
  res.json(row)
})
function broadcastStatus(userId, row) {
  const orgMates = db.prepare('SELECT id FROM users WHERE org_id=(SELECT org_id FROM users WHERE id=?)').all(userId)
  for (const u of orgMates) pushToUser(u.id, { type: 'status', userId, ...row })
}

// ---------- due work, driven by scheduler.js's one-minute tick ----------
// Lives here rather than in its own module so a scheduled message goes out
// through the SAME deliver() as a typed one: same notification, same mention
// handling, same WebSocket push. A second delivery path would drift.
export function runChatDue() {
  const ts = now()

  // Calls nobody is on any more. A killed browser never sends /end, which is
  // deliberate — it is what lets someone walk back into the call from another
  // device. The cost is that a call would otherwise stay 'active' for ever and
  // the next call in that conversation would silently join a ghost. So: end a
  // call once every participant has been off the socket for a couple of
  // minutes, and give up on one that has been ringing unanswered.
  try {
    const live = db.prepare("SELECT * FROM chat_calls WHERE status IN ('ringing','active')").all()
    if (live.length) {
      const online = new Set(getOnlineUsers())
      for (const call of live) {
        const present = db.prepare('SELECT user_id FROM chat_call_participants WHERE call_id=? AND joined_at IS NOT NULL AND left_at IS NULL').all(call.id)
        const anyoneHere = present.some((p) => online.has(p.user_id))
        const ageMs = Date.now() - new Date(call.started_at).getTime()
        // The grace period is what makes a reload survivable: the socket drops
        // and comes back within seconds, and the call must still be there.
        const abandoned = !anyoneHere && ageMs > 120000
        const ringingTooLong = call.status === 'ringing' && ageMs > 90000
        if (!abandoned && !ringingTooLong) continue

        const status = call.answered_at ? 'ended' : 'missed'
        db.prepare('UPDATE chat_calls SET status=?, ended_at=? WHERE id=?').run(status, ts, call.id)
        db.prepare('UPDATE chat_call_participants SET left_at=? WHERE call_id=? AND left_at IS NULL').run(ts, call.id)
        const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(call.conversation_id)
        pushToConversation(call.conversation_id, { type: 'call-ended', callId: call.id })
        if (conv) postCallLine(conv, callSummary(call.id))
        if (status === 'ended') scheduleFinalize(call.id, 500)
      }
    }
  } catch (e) { console.error('[chat] call reaper failed:', e.message) }

  // Reminders I set on a message ("remind me at 4pm").
  const dueReminders = db.prepare('SELECT * FROM chat_reminders WHERE sent=0 AND remind_at<=? LIMIT 50').all(ts)
  for (const rem of dueReminders) {
    db.prepare('UPDATE chat_reminders SET sent=1 WHERE id=?').run(rem.id) // mark first: a throw must not re-fire it every minute
    try {
      const m = rem.message_id ? db.prepare('SELECT body, file_name FROM chat_messages WHERE id=?').get(rem.message_id) : null
      const preview = rem.note || (m ? (m.body || m.file_name || '') : '')
      notify(rem.org_id, rem.user_id, 'chat_reminder', `Reminder: ${preview.slice(0, 80)}`, null)
      pushToUser(rem.user_id, { type: 'reminder', conversationId: rem.conversation_id, messageId: rem.message_id, preview })
    } catch (e) { console.error('[chat] reminder failed:', e.message) }
  }

  // Messages written earlier and due to go out now.
  const dueMessages = db.prepare('SELECT * FROM chat_scheduled WHERE sent=0 AND send_at<=? LIMIT 25').all(ts)
  for (const sch of dueMessages) {
    db.prepare('UPDATE chat_scheduled SET sent=1 WHERE id=?').run(sch.id)
    try {
      const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(sch.conversation_id)
      const sender = db.prepare('SELECT * FROM users WHERE id=?').get(sch.sender_id)
      // The sender may have been removed from the group between writing and
      // sending. Posting it anyway would put a message in a room they can no
      // longer see, so it just quietly doesn't go.
      if (!conv || !sender || !member(conv.id, sender.id) || !canPost(conv, sender.id)) continue
      const mid = id('msg')
      db.prepare('INSERT INTO chat_messages (id, org_id, conversation_id, sender_id, recipient_id, body, read, created_at) VALUES (?,?,?,?,?,?,0,?)')
        .run(mid, conv.org_id, conv.id, sender.id, '', sch.body, now())
      const mentioned = saveMentions(conv.id, mid, sch.mentions ? sch.mentions.split(',').filter(Boolean) : [], sender.id)
      const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(mid)
      deliver(conv, row, sender, mentioned)
    } catch (e) { console.error('[chat] scheduled message failed:', e.message) }
  }
}

export default r
