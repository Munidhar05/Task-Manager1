// Real-time chat hub: pushes new direct messages to recipients instantly over
// a WebSocket, so the Chats page doesn't have to wait for the next poll.
//
// Client -> us:   nothing (the socket is push-only; messages are still SENT over
//                 the REST POST /api/chat/:userId so they're persisted reliably)
// us -> Client:   { type: 'ready' }                          on connect
//                 { type: 'message', message: {...} }        when a DM arrives
//
// A user may have several tabs/devices open, so we keep a Set of sockets per
// user id and fan out to all of them.
import { WebSocketServer } from 'ws'
import { verifyToken } from '../auth.js'
import { db } from '../db.js'

// userId -> Set<WebSocket>
const clients = new Map()

export function attachChatHub(server) {
  // `noServer` + manual upgrade routing so this shares the HTTP server with the
  // live-transcription socket without either aborting the other's handshakes.
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    let pathname
    try { pathname = new URL(req.url, 'http://localhost').pathname } catch { return }
    if (pathname !== '/api/chat/ws') return // not ours — let another handler take it
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost')
    const user = verifyToken(url.searchParams.get('token'))
    if (!user) {
      try { ws.send(JSON.stringify({ error: 'Authentication required' })) } catch {}
      return ws.close(4401, 'unauthorized')
    }

    ws.userId = user.id
    if (!clients.has(user.id)) clients.set(user.id, new Set())
    clients.get(user.id).add(ws)
    try { ws.send(JSON.stringify({ type: 'ready' })) } catch {}

    // Relay ephemeral "typing…" signals to the other participants of a conversation.
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.type !== 'typing' || !msg.conversationId) return
      const isMember = db.prepare('SELECT 1 FROM chat_participants WHERE conversation_id=? AND user_id=?').get(msg.conversationId, user.id)
      if (!isMember) return
      const others = db.prepare('SELECT user_id FROM chat_participants WHERE conversation_id=? AND user_id!=?').all(msg.conversationId, user.id)
      const payload = { type: 'typing', conversationId: msg.conversationId, userId: user.id, name: user.name, isTyping: !!msg.isTyping }
      for (const o of others) pushToUser(o.user_id, payload)
    })

    // Heartbeat bookkeeping so we can reap dead sockets (closed laptops etc.).
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })

    const detach = () => {
      const set = clients.get(user.id)
      if (set) { set.delete(ws); if (!set.size) clients.delete(user.id) }
    }
    ws.on('close', detach)
    ws.on('error', () => { try { ws.close() } catch {} })
  })

  // Ping every 30s; terminate any socket that didn't pong since the last round.
  const heartbeat = setInterval(() => {
    for (const set of clients.values()) {
      for (const ws of set) {
        if (ws.isAlive === false) { try { ws.terminate() } catch {}; continue }
        ws.isAlive = false
        try { ws.ping() } catch {}
      }
    }
  }, 30000)
  wss.on('close', () => clearInterval(heartbeat))

  return wss
}

// Push a JSON payload to every live socket for a user. No-op if they're offline
// (they'll see the message on next load / poll instead).
export function pushToUser(userId, payload) {
  const set = clients.get(userId)
  if (!set || !set.size) return
  const data = JSON.stringify(payload)
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) { try { ws.send(data) } catch {} }
  }
}
