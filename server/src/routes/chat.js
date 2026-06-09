import { Router } from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../db.js'
import { authRequired, verifyToken } from '../auth.js'
import { id, now, notify } from '../util.js'
import { pushToUser, getOnlineUsers } from '../ws/chatHub.js'
import { indexChatMessage, removeEmbedding } from '../ai/ragIndex.js'

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
    starred: ctx.stars ? ctx.stars.has(row.id) : false,
    seen,
  }
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
    SELECT u.id, u.name, u.avatar_color, u.avatar_file, u.role, u.last_seen, p.role AS member_role
    FROM chat_participants p JOIN users u ON u.id=p.user_id WHERE p.conversation_id=?`).all(conv.id)
  const me = db.prepare('SELECT last_read_at, muted, pinned FROM chat_participants WHERE conversation_id=? AND user_id=?').get(conv.id, viewerId)
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
    members: parts.map((p) => ({ id: p.id, name: p.name, avatar_color: p.avatar_color, avatar_file: p.avatar_file || null, role: p.member_role })),
    role: me ? (parts.find((p) => p.id === viewerId)?.member_role) : 'member',
    muted: !!me?.muted,
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
  const rows = db.prepare('SELECT id, name, email, role, avatar_color, avatar_file FROM users WHERE org_id=? AND id!=? ORDER BY name').all(req.user.org_id, req.user.id)
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
    const name = String(req.body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Group name required' })
    const ids = Array.isArray(req.body.memberIds) ? req.body.memberIds : []
    const valid = db.prepare(`SELECT id FROM users WHERE org_id=? AND id IN (${ids.map(() => '?').join(',') || "''"})`).all(me.org_id, ...ids).map((u) => u.id)
    if (!valid.length) return res.status(400).json({ error: 'Add at least one member' })
    const cid = id('cv')
    const ts = now()
    const colors = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#06b6d4']
    db.prepare('INSERT INTO chat_conversations (id, org_id, type, name, avatar_color, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(cid, me.org_id, 'group', name, colors[name.length % colors.length], me.id, ts, ts)
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
  const stars = new Set(db.prepare(`SELECT message_id FROM chat_stars WHERE user_id=? AND message_id IN (${ids.map(() => '?').join(',') || "''"})`).all(me.id, ...ids).map((s) => s.message_id))
  // others' minimum last_read_at → drives the "seen" tick on my messages
  // Others' minimum last_read_at: if anyone hasn't read up to a message, it's not "seen".
  const others = db.prepare('SELECT last_read_at FROM chat_participants WHERE conversation_id=? AND user_id!=?').all(conv.id, me.id)
  const minRead = others.length === 0 ? null
    : (others.some((o) => !o.last_read_at) ? null : others.reduce((m, o) => (o.last_read_at < m ? o.last_read_at : m), others[0].last_read_at))
  const ctx = { reactions, stars, othersMinRead: minRead }
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
function deliver(conv, msgRow, sender) {
  touchConvo(conv.id)
  const others = participantsOf(conv.id).filter((u) => u !== sender.id)
  const label = conv.type === 'group' ? `${sender.name} in ${conv.name || 'Group'}` : sender.name
  const preview = msgRow.file_name ? `📎 ${msgRow.file_name}` : (msgRow.body || '')
  for (const uid of others) {
    const p = db.prepare('SELECT muted FROM chat_participants WHERE conversation_id=? AND user_id=?').get(conv.id, uid)
    if (p?.muted) continue // muted: deliver the message live, but no notification
    notify(conv.org_id, uid, 'chat_message', `${label}: ${preview.length > 70 ? preview.slice(0, 70) + '…' : preview}`, null)
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
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(mid)
  deliver(conv, row, me)
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
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(mid)
  deliver(conv, row, me)
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

export default r
