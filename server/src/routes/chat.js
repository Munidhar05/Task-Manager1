import { Router } from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../db.js'
import { authRequired, requireRole, verifyToken } from '../auth.js'
import { id, now, notify } from '../util.js'
import { pushToUser, getOnlineUsers } from '../ws/chatHub.js'
import { indexChatMessage, removeEmbedding } from '../ai/ragIndex.js'
import { transcribeAudio } from '../ai/transcribe.js'
import { analyzeMeetingTranscript } from '../ai/extractor.js'
import { persistMeeting, attendeesFor } from './meetings.js'
import { parseDueDate } from '../ai/dates.js'
import { detectPriority } from '../ai/rules.js'

// Internal team chat (WhatsApp-style): 1:1 + group conversations, file attachments,
// real-time delivery, replies, reactions, stars, edit, single-delete, read receipts.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'chat_uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, id('cf') + path.extname(file.originalname || '').slice(0, 12)),
})
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } })

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

// One-line preview of a message for reply quotes / conversation lists.
function snippet(row) {
  if (!row) return ''
  if (row.deleted_for_all) return 'This message was deleted'
  if (row.file_stored || row.file_name) return '📎 ' + (row.file_name || 'Attachment')
  return row.body || ''
}

// Shape a message row for the client (viewer-specific: starred, reactions, seen).
function shapeMessage(row, viewerId, ctx = {}) {
  const base = { id: row.id, conversation_id: row.conversation_id, sender_id: row.sender_id, created_at: row.created_at }
  if (row.deleted_for_all) return { ...base, deleted: true, body: '' }
  const reactions = (ctx.reactions && ctx.reactions[row.id]) || []
  let replyPreview = null
  if (row.reply_to) {
    const rep = db.prepare('SELECT id, sender_id, body, file_name, deleted_for_all FROM chat_messages WHERE id=?').get(row.reply_to)
    if (rep) {
      const u = db.prepare('SELECT name FROM users WHERE id=?').get(rep.sender_id)
      replyPreview = { id: rep.id, sender_id: rep.sender_id, sender_name: u?.name || 'Unknown', text: snippet(rep) }
    }
  }
  // "Seen" for my own messages: all other participants read past this message.
  let seen = false
  if (row.sender_id === viewerId && ctx.othersMinRead !== undefined) {
    seen = ctx.othersMinRead !== null && ctx.othersMinRead >= row.created_at
  }
  return {
    ...base,
    body: row.body,
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
    seen,
  }
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
  const me = db.prepare('SELECT last_read_at, muted, pinned, muted_until FROM chat_participants WHERE conversation_id=? AND user_id=?').get(conv.id, viewerId)
  const last = db.prepare(`
    SELECT * FROM chat_messages WHERE conversation_id=?
      AND id NOT IN (SELECT message_id FROM chat_message_hidden WHERE user_id=?)
    ORDER BY created_at DESC LIMIT 1`).get(conv.id, viewerId)
  const unread = db.prepare(`
    SELECT COUNT(*) c FROM chat_messages
    WHERE conversation_id=? AND sender_id!=? AND deleted_for_all=0
      AND created_at > ?
      AND id NOT IN (SELECT message_id FROM chat_message_hidden WHERE user_id=?)`)
    .get(conv.id, viewerId, me?.last_read_at || '', viewerId).c
  const others = parts.filter((p) => p.id !== viewerId)
  const isGroup = conv.type === 'group'
  const lastSender = last ? parts.find((p) => p.id === last.sender_id) : null
  return {
    id: conv.id,
    type: conv.type,
    name: isGroup ? (conv.name || 'Group') : (others[0]?.name || 'Unknown'),
    avatar_color: isGroup ? conv.avatar_color : (others[0]?.avatar_color || '#6366f1'),
    avatar_file: isGroup ? (conv.avatar_file || null) : (others[0]?.avatar_file || null),
    other_user_id: isGroup ? null : (others[0]?.id || null),
    other_last_seen: isGroup ? null : (others[0]?.last_seen || null),
    member_count: parts.length,
    members: parts.map((p) => ({ id: p.id, name: p.name, avatar_color: p.avatar_color, avatar_file: p.avatar_file || null, role: p.member_role, status_text: p.status_text || '', status_emoji: p.status_emoji || '', dnd_until: p.dnd_until || null })),
    role: me ? (parts.find((p) => p.id === viewerId)?.member_role) : 'member',
    visibility: conv.visibility || 'private',
    muted: !!me?.muted && (!me?.muted_until || me.muted_until > now()),
    muted_until: me?.muted_until || null,
    pinned: !!me?.pinned,
    last_message: last ? snippet(last) : null,
    last_sender_name: lastSender ? lastSender.name : null,
    last_from_me: last ? last.sender_id === viewerId : false,
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
  fs.createReadStream(abs).pipe(res)
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
  const convs = db.prepare(`
    SELECT c.* FROM chat_conversations c
    JOIN chat_participants p ON p.conversation_id=c.id
    WHERE p.user_id=? AND c.org_id=?`).all(me.id, me.org_id)
  const list = convs.map((c) => summarizeConvo(c, me.id))
  list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.last_at || '').localeCompare(a.last_at || ''))
  res.json({ conversations: list })
})

// Total unread across conversations (nav badge).
r.get('/unread', (req, res) => {
  const convs = db.prepare('SELECT c.id FROM chat_conversations c JOIN chat_participants p ON p.conversation_id=c.id WHERE p.user_id=?').all(req.user.id)
  let unread = 0
  for (const c of convs) {
    const me = db.prepare('SELECT last_read_at FROM chat_participants WHERE conversation_id=? AND user_id=?').get(c.id, req.user.id)
    unread += db.prepare(`
      SELECT COUNT(*) c FROM chat_messages
      WHERE conversation_id=? AND sender_id!=? AND deleted_for_all=0 AND created_at > ?
        AND id NOT IN (SELECT message_id FROM chat_message_hidden WHERE user_id=?)`)
      .get(c.id, req.user.id, me?.last_read_at || '', req.user.id).c
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
    pushToConversation(cid, { type: 'conversation', action: 'created', conversationId: cid })
    return res.status(201).json(summarizeConvo(db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(cid), me.id))
  }
  res.status(400).json({ error: 'type must be direct or group' })
})

// Conversation detail + messages (marks read for me).
r.get('/conversations/:id', (req, res) => {
  const me = req.user
  if (!member(req.params.id, me.id)) return res.status(404).json({ error: 'Conversation not found' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  const prevRead = db.prepare('SELECT last_read_at FROM chat_participants WHERE conversation_id=? AND user_id=?').get(conv.id, me.id)?.last_read_at || null
  const rows = db.prepare(`
    SELECT * FROM chat_messages WHERE conversation_id=?
      AND id NOT IN (SELECT message_id FROM chat_message_hidden WHERE user_id=?)
    ORDER BY created_at ASC LIMIT 800`).all(conv.id, me.id)
  const ids = rows.map((m) => m.id)
  const reactions = reactionsByMessage(ids)
  const mentions = mentionsByMessage(ids)
  const stars = new Set(db.prepare(`SELECT message_id FROM chat_stars WHERE user_id=? AND message_id IN (${ids.map(() => '?').join(',') || "''"})`).all(me.id, ...ids).map((s) => s.message_id))
  // others' minimum last_read_at → drives the "seen" tick on my messages
  // Others' minimum last_read_at: if anyone hasn't read up to a message, it's not "seen".
  const others = db.prepare('SELECT last_read_at FROM chat_participants WHERE conversation_id=? AND user_id!=?').all(conv.id, me.id)
  const minRead = others.length === 0 ? null
    : (others.some((o) => !o.last_read_at) ? null : others.reduce((m, o) => (o.last_read_at < m ? o.last_read_at : m), others[0].last_read_at))
  const ctx = { reactions, mentions, stars, othersMinRead: minRead }
  const messages = rows.map((row) => shapeMessage(row, me.id, ctx))
  // mark read
  db.prepare('UPDATE chat_participants SET last_read_at=? WHERE conversation_id=? AND user_id=?').run(now(), conv.id, me.id)
  pushToConversation(conv.id, { type: 'read', conversationId: conv.id, userId: me.id, last_read_at: now() }, me.id)
  res.json({ conversation: summarizeConvo(conv, me.id), messages, last_read_at: prevRead })
})

// Mute / pin a conversation (per-user preferences).
r.post('/conversations/:id/prefs', (req, res) => {
  if (!member(req.params.id, req.user.id)) return res.status(404).json({ error: 'Not found' })
  const sets = [], args = []
  if ('muted' in (req.body || {})) { sets.push('muted=?'); args.push(req.body.muted ? 1 : 0) }
  if ('pinned' in (req.body || {})) { sets.push('pinned=?'); args.push(req.body.pinned ? 1 : 0) }
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

// Set a group photo (admin only, images only).
r.post('/conversations/:id/avatar', upload.single('file'), (req, res) => {
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
  pushToConversation(conv.id, { type: 'conversation', action: 'updated', conversationId: conv.id })
  res.json({ ok: true })
})

// Mark a conversation read (lightweight; used on live inbound while open).
r.post('/conversations/:id/read', (req, res) => {
  if (!member(req.params.id, req.user.id)) return res.status(404).json({ error: 'Not found' })
  db.prepare('UPDATE chat_participants SET last_read_at=? WHERE conversation_id=? AND user_id=?').run(now(), req.params.id, req.user.id)
  pushToConversation(req.params.id, { type: 'read', conversationId: req.params.id, userId: req.user.id, last_read_at: now() }, req.user.id)
  res.json({ ok: true })
})

// Rename a group (admin only).
r.patch('/conversations/:id', (req, res) => {
  const m = member(req.params.id, req.user.id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  if (m.role !== 'admin') return res.status(403).json({ error: 'Only the group admin can do this' })
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: 'Name required' })
  db.prepare("UPDATE chat_conversations SET name=? WHERE id=? AND type='group'").run(name, req.params.id)
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
  const ts = now()
  for (const uid of valid) db.prepare('INSERT OR IGNORE INTO chat_participants (conversation_id, user_id, role, last_read_at, joined_at) VALUES (?,?,?,?,?)').run(req.params.id, uid, 'member', null, ts)
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
      removeEmbedding('chat', mm.id) // drop RAG vector for each wiped message
    }
    db.prepare('DELETE FROM chat_messages WHERE conversation_id=?').run(conv.id)
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
  db.prepare('DELETE FROM chat_participants WHERE conversation_id=? AND user_id=?').run(req.params.id, target)
  pushToConversation(req.params.id, { type: 'conversation', action: 'updated', conversationId: req.params.id })
  pushToUser(target, { type: 'conversation', action: 'removed', conversationId: req.params.id })
  res.json({ ok: true })
})

// ---------- messages ----------
function deliver(conv, msgRow, sender, mentioned = []) {
  touchConvo(conv.id)
  const others = participantsOf(conv.id).filter((u) => u !== sender.id)
  const label = conv.type === 'group' ? `${sender.name} in ${conv.name || 'Group'}` : sender.name
  const preview = msgRow.file_name ? `📎 ${msgRow.file_name}` : (msgRow.body || '')
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
  // push the shaped message to everyone (each viewer computes their own ctx as null → fine for live append)
  for (const uid of [sender.id, ...others]) {
    pushToUser(uid, { type: 'message', conversationId: conv.id, message: shapeMessage(msgRow, uid, {}) })
  }
  indexChatMessage(msgRow.id) // RAG: index every delivered message (text/upload/forward)
}

// Send a text message.
r.post('/conversations/:id/messages', (req, res) => {
  const me = req.user
  if (!member(req.params.id, me.id)) return res.status(404).json({ error: 'Conversation not found' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  const body = String(req.body?.body || '').trim()
  if (!body) return res.status(400).json({ error: 'Message body required' })
  if (body.length > 4000) return res.status(400).json({ error: 'Message too long' })
  const replyTo = req.body?.replyTo && db.prepare('SELECT id FROM chat_messages WHERE id=? AND conversation_id=?').get(req.body.replyTo, conv.id) ? req.body.replyTo : null
  const mid = id('msg')
  const ts = now()
  db.prepare('INSERT INTO chat_messages (id, org_id, conversation_id, sender_id, recipient_id, body, reply_to, read, created_at) VALUES (?,?,?,?,?,?,?,0,?)')
    .run(mid, conv.org_id, conv.id, me.id, '', body, replyTo, ts)
  const mentioned = saveMentions(conv.id, mid, req.body?.mentions, me.id)
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(mid)
  deliver(conv, row, me, mentioned)
  res.status(201).json(shapeMessage(row, me.id, {}))
})

// Send a file (optional caption + replyTo).
r.post('/conversations/:id/upload', upload.single('file'), (req, res) => {
  const me = req.user
  const cleanup = () => { if (req.file) try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)) } catch {} }
  if (!member(req.params.id, me.id)) { cleanup(); return res.status(404).json({ error: 'Conversation not found' }) }
  if (!req.file) return res.status(400).json({ error: 'file required (field "file")' })
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id)
  const caption = String(req.body?.body || '').trim().slice(0, 4000)
  const replyTo = req.body?.replyTo && db.prepare('SELECT id FROM chat_messages WHERE id=? AND conversation_id=?').get(req.body.replyTo, conv.id) ? req.body.replyTo : null
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
  res.status(201).json(shapeMessage(row, me.id, {}))
})

// Edit a message body (sender only; not files, not deleted).
r.patch('/message/:id', (req, res) => {
  const me = req.user
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || m.sender_id !== me.id) return res.status(404).json({ error: 'Message not found' })
  if (m.deleted_for_all) return res.status(400).json({ error: 'Cannot edit a deleted message' })
  const body = String(req.body?.body || '').trim()
  if (!body) return res.status(400).json({ error: 'Body required' })
  const ts = now()
  db.prepare('UPDATE chat_messages SET body=?, edited_at=? WHERE id=?').run(body, ts, m.id)
  pushToConversation(m.conversation_id, { type: 'edit', conversationId: m.conversation_id, id: m.id, body, edited_at: ts })
  indexChatMessage(m.id) // re-index edited body
  res.json({ ok: true, body, edited_at: ts })
})

// Forward a message to one or more conversations I'm a member of.
r.post('/message/:id/forward', (req, res) => {
  const me = req.user
  const src = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!src || src.deleted_for_all || !member(src.conversation_id, me.id)) return res.status(404).json({ error: 'Message not found' })
  const targets = Array.isArray(req.body?.conversationIds) ? req.body.conversationIds : []
  const sent = []
  for (const cid of targets) {
    if (!member(cid, me.id)) continue
    const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(cid)
    if (!conv) continue
    let storedName = null
    if (src.file_stored) {
      // copy the file so deleting one message doesn't affect the other
      storedName = id('cf') + path.extname(src.file_stored)
      try { fs.copyFileSync(path.join(UPLOAD_DIR, src.file_stored), path.join(UPLOAD_DIR, storedName)) } catch { storedName = null }
    }
    const mid = id('msg')
    const ts = now()
    db.prepare(`INSERT INTO chat_messages (id, org_id, conversation_id, sender_id, recipient_id, body, file_name, file_stored, file_type, file_size, forwarded, read, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,0,?)`)
      .run(mid, conv.org_id, cid, me.id, '', src.body, storedName ? src.file_name : null, storedName, storedName ? src.file_type : null, storedName ? src.file_size : null, ts)
    const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(mid)
    deliver(conv, row, me)
    sent.push(cid)
  }
  res.json({ ok: true, forwarded_to: sent })
})

// Single Delete: your own message → unsend for everyone (tombstone + file removed);
// someone else's → hide for you only.
r.delete('/message/:id', (req, res) => {
  const me = req.user
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || !member(m.conversation_id, me.id)) return res.status(404).json({ error: 'Message not found' })
  if (m.sender_id === me.id) {
    db.prepare('UPDATE chat_messages SET deleted_for_all=1, body=?, file_name=NULL, file_stored=NULL, file_type=NULL, file_size=NULL WHERE id=?').run('', m.id)
    db.prepare('DELETE FROM chat_reactions WHERE message_id=?').run(m.id)
    removeEmbedding('chat', m.id) // unsent message leaves the RAG index
    if (m.file_stored) try { fs.unlinkSync(path.join(UPLOAD_DIR, m.file_stored)) } catch {}
    pushToConversation(m.conversation_id, { type: 'delete', conversationId: m.conversation_id, id: m.id, scope: 'all' })
  } else {
    db.prepare('INSERT OR IGNORE INTO chat_message_hidden (message_id, user_id) VALUES (?,?)').run(m.id, me.id)
    pushToUser(me.id, { type: 'delete', conversationId: m.conversation_id, id: m.id, scope: 'me' })
  }
  res.json({ ok: true })
})

// Toggle an emoji reaction (one reaction per user per message; same emoji = remove).
r.post('/message/:id/reactions', (req, res) => {
  const me = req.user
  const emoji = String(req.body?.emoji || '').slice(0, 8)
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.id)
  if (!m || !member(m.conversation_id, me.id) || !emoji) return res.status(404).json({ error: 'Not found' })
  const existing = db.prepare('SELECT emoji FROM chat_reactions WHERE message_id=? AND user_id=?').get(m.id, me.id)
  db.prepare('DELETE FROM chat_reactions WHERE message_id=? AND user_id=?').run(m.id, me.id)
  if (!existing || existing.emoji !== emoji) {
    db.prepare('INSERT INTO chat_reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)').run(m.id, me.id, emoji, now())
  }
  const reactions = db.prepare('SELECT user_id, emoji FROM chat_reactions WHERE message_id=?').all(m.id)
  pushToConversation(m.conversation_id, { type: 'reaction', conversationId: m.conversation_id, id: m.id, reactions })
  res.json({ reactions })
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
  const body = call.status === 'ended'
    ? `${label} · ${call.duration_sec < 60 ? `${call.duration_sec}s` : `${mins}m`}`
    : call.status === 'declined' ? `${label} declined` : `Missed ${label.toLowerCase()}`
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
    from: { id: me.id, name: me.name }, conversationName: label, conversationType: conv.type,
  }, me.id)
  res.status(201).json({ id: cid, conversation_id: conv.id, kind, status: 'ringing', started_by: me.id, peers: [] })
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
    if (status === 'missed') {
      for (const uid of participantsOf(conv.id)) {
        if (uid === call.started_by) continue
        notify(conv.org_id, uid, 'chat_call', `Missed ${call.kind} call from ${db.prepare('SELECT name FROM users WHERE id=?').get(call.started_by)?.name || 'a teammate'}`, null)
      }
    }
  }
  res.json({ ok: true })
})

// One utterance, from one person's own browser, during a recorded call.
// Deliberately tiny and unvalidated beyond membership: it is called every few
// seconds by every participant, and a slow endpoint here would be felt as the
// call stuttering.
r.post('/call/:id/segment', (req, res) => {
  const me = req.user
  const call = db.prepare('SELECT * FROM chat_calls WHERE id=?').get(req.params.id)
  if (!call || !member(call.conversation_id, me.id)) return res.status(404).json({ error: 'Call not found' })
  const text = String(req.body?.text || '').trim().slice(0, 2000)
  if (!text) return res.json({ ok: true })
  db.prepare('INSERT INTO chat_call_segments (id, call_id, user_id, text, created_at) VALUES (?,?,?,?,?)')
    .run(id('seg'), call.id, me.id, text, now())
  res.json({ ok: true })
})

// Stitch the call's segments into a transcript and run it through the SAME
// meeting pipeline an uploaded recording uses — extraction, suggestions, the
// review screen, assignment. No audio leaves the browser and no speech key is
// needed, because the speech-to-text already happened on each participant's
// device while they were talking.
r.post('/call/:id/to-tasks', requireRole('manager', 'admin'), async (req, res) => {
  const me = req.user
  const call = db.prepare('SELECT * FROM chat_calls WHERE id=?').get(req.params.id)
  if (!call || !member(call.conversation_id, me.id)) return res.status(404).json({ error: 'Call not found' })

  const segs = db.prepare(`
    SELECT s.text, s.created_at, u.name FROM chat_call_segments s
    JOIN users u ON u.id=s.user_id WHERE s.call_id=? ORDER BY s.created_at`).all(call.id)
  if (!segs.length) return res.status(422).json({ error: 'Nothing was captured from this call', code: 'NO_SPEECH' })

  // "Name: what they said" is the shape the extractor already expects from a
  // meeting transcript, so attribution survives into the suggested assignees.
  // Each recognised utterance is punctuated before being joined. The Web Speech
  // API returns them bare, and the extractor splits on sentence boundaries — so
  // without this, everything one person said in a row becomes one run-on
  // sentence and two separate asks get merged into a single unusable task.
  const punct = (t) => (/[.!?।]$/.test(t.trim()) ? t.trim() : t.trim() + '.')
  const lines = []
  let lastName = null
  for (const sg of segs) {
    if (sg.name === lastName) lines[lines.length - 1] += ' ' + punct(sg.text)
    else { lines.push(`${sg.name}: ${punct(sg.text)}`); lastName = sg.name }
  }
  const transcript = lines.join('\n')

  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(call.conversation_id)
  const participantIds = db.prepare('SELECT DISTINCT user_id FROM chat_call_participants WHERE call_id=? AND joined_at IS NOT NULL').all(call.id).map((x) => x.user_id)
  const attendees = attendeesFor(me.org_id, participantIds)
  const others = attendees.filter((a) => a.id !== me.id).map((a) => a.name)
  const title = conv?.type === 'group'
    ? `Call — ${conv.name || 'Group'}`
    : `Call with ${others[0] || 'a teammate'}`

  try {
    const meetingDate = now().slice(0, 10)
    const analysis = await analyzeMeetingTranscript(transcript, {
      meetingDate, knownNames: attendees.map((a) => a.name), attendees, summaryLanguage: 'en',
    })
    const { mid, suggestionCount } = persistMeeting(
      { orgId: me.org_id, userId: me.id, title, description: `Transcribed live from ${call.kind === 'audio' ? 'an' : 'a'} ${call.kind} call.`, meetingDate, transcript, sourceType: 'call', participantIds },
      analysis)
    res.status(201).json({ id: mid, suggestion_count: suggestionCount, engine: analysis.engine, lines: lines.length })
  } catch (err) {
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

// Announce that someone started or stopped recording. Everyone in the call is
// told, always: a recording nobody was told about is not something this app is
// going to make easy, whatever the local law says.
r.post('/call/:id/recording', (req, res) => {
  const me = req.user
  const call = db.prepare('SELECT * FROM chat_calls WHERE id=?').get(req.params.id)
  if (!call || !member(call.conversation_id, me.id)) return res.status(404).json({ error: 'Call not found' })
  pushToConversation(call.conversation_id, { type: 'call-recording', callId: call.id, on: !!req.body?.on, by: me.id, byName: me.name })
  res.json({ ok: true })
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
        const buf = fs.readFileSync(path.join(UPLOAD_DIR, m.file_stored))
        const out = await transcribeAudio(buf, m.file_name || 'voice.webm', m.file_type || 'audio/webm')
        const clean = String(out.text || '').trim()
        if (clean) {
          db.prepare('UPDATE chat_messages SET transcript=? WHERE id=?').run(clean, m.id)
          pushToConversation(m.conversation_id, { type: 'transcript', conversationId: m.conversation_id, id: m.id, transcript: clean })
          text = clean
        }
      } catch (err) {
        return res.status(422).json({
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
  db.prepare('UPDATE chat_participants SET last_read_at=? WHERE conversation_id=? AND user_id=?').run(before, req.params.id, me.id)
  res.json({ ok: true, last_read_at: before })
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
  db.prepare('UPDATE chat_conversations SET visibility=? WHERE id=?').run(visibility, req.params.id)
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
  try {
    const buf = fs.readFileSync(path.join(UPLOAD_DIR, m.file_stored))
    const { text } = await transcribeAudio(buf, m.file_name || 'voice.webm', m.file_type || 'audio/webm')
    const clean = String(text || '').trim()
    if (!clean) return res.status(422).json({ error: 'Nothing could be made out in that recording' })
    db.prepare('UPDATE chat_messages SET transcript=? WHERE id=?').run(clean, m.id)
    pushToConversation(m.conversation_id, { type: 'transcript', conversationId: m.conversation_id, id: m.id, transcript: clean })
    res.json({ text: clean, cached: false })
  } catch (err) {
    console.error('[chat] voice transcription failed:', err.message)
    res.status(err.code === 'NO_PROVIDER' ? 400 : 502).json({ error: err.message, code: err.code || null })
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
      if (!conv || !sender || !member(conv.id, sender.id)) continue
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
