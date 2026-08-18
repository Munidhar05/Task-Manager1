// Live transcription WebSocket proxy: browser  <->  this server  <->  Sarvam.
//
// The browser can't talk to Sarvam directly — it can't attach the
// `Api-Subscription-Key` header to a WebSocket handshake, and we must never ship
// the key to the client. So the browser opens a socket to us; we open an upstream
// socket to Sarvam, relaying raw PCM16 audio up and transcripts back down.
//
// Client -> us:   base64 string of little-endian 16-bit PCM @ 16 kHz (one frame)
// us -> Sarvam:   { audio: { data, sample_rate: "16000", encoding: "audio/wav" } }
// Sarvam -> us:   { type: "data",  data: { transcript } }  /  { type: "error", data: { message } }
// us -> Client:   { transcript }  /  { error }
//
// TWO endpoints share this relay, with deliberately different policies:
//   /api/meetings/live   managers/admins; language LOCKED (a 2h meeting mis-detected
//                        into Malayalam poisons the whole transcript, so meetings
//                        pin the language and let the user pick it in the recorder)
//   /api/assistant/live  every role; language AUTO-DETECTED (a voice command is one
//                        short code-mixed sentence — "Ravi ki assign cheyyi" locked
//                        to en-IN comes out as English mush, and a wrong guess costs
//                        one retry, not a meeting)
import { WebSocketServer, WebSocket } from 'ws'
import { verifyToken } from '../auth.js'

const SARVAM_WS = 'wss://api.sarvam.ai/speech-to-text/ws'

function attachSarvamRelay(server, { path, allowUser, pickLanguage }) {
  // `noServer` + manual upgrade routing so multiple WS endpoints can share one
  // HTTP server. (Binding with `{ server, path }` makes ws abort every mismatched
  // upgrade with a 400, which would kill the other endpoints' handshakes.)
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    let pathname
    try { pathname = new URL(req.url, 'http://localhost').pathname } catch { return }
    if (pathname !== path) return // not ours — let another handler take it
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (client, req) => {
    const url = new URL(req.url, 'http://localhost')
    const token = url.searchParams.get('token')
    const language = pickLanguage(url.searchParams.get('language'))

    // --- Auth ---
    const user = verifyToken(token)
    if (!user || !allowUser(user)) {
      try { client.send(JSON.stringify({ error: 'Authentication required' })) } catch {}
      return client.close(4401, 'unauthorized')
    }

    // --- Provider guard ---
    const key = process.env.SARVAM_API_KEY
    if ((process.env.TRANSCRIPTION_PROVIDER || '').toLowerCase() !== 'sarvam' || !key) {
      try { client.send(JSON.stringify({ error: 'Live streaming requires TRANSCRIPTION_PROVIDER=sarvam and SARVAM_API_KEY.' })) } catch {}
      return client.close(4400, 'provider')
    }

    // --- Open the upstream Sarvam socket ---
    const model = process.env.SARVAM_MODEL || 'saarika:v2.5'
    const upstreamUrl = `${SARVAM_WS}?language-code=${encodeURIComponent(language)}`
      + `&model=${encodeURIComponent(model)}&mode=transcribe`
      + `&sample_rate=16000&input_audio_codec=pcm_s16le`
    const sarvam = new WebSocket(upstreamUrl, { headers: { 'Api-Subscription-Key': key } })

    let sarvamReady = false
    const pending = [] // audio frames that arrived before Sarvam's socket opened

    const sendToSarvam = (b64) => {
      const frame = JSON.stringify({ audio: { data: b64, sample_rate: '16000', encoding: 'audio/wav' } })
      if (sarvamReady && sarvam.readyState === WebSocket.OPEN) sarvam.send(frame)
      else pending.push(frame)
    }
    const toClient = (obj) => { if (client.readyState === WebSocket.OPEN) { try { client.send(JSON.stringify(obj)) } catch {} } }

    sarvam.on('open', () => {
      sarvamReady = true
      // Tell the client the upstream is live — the assistant uses this to start
      // its turn clock only once audio can actually flow, so a slow Sarvam
      // handshake doesn't eat into the user's speech window.
      toClient({ ready: true })
      while (pending.length && sarvam.readyState === WebSocket.OPEN) sarvam.send(pending.shift())
    })
    sarvam.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.type === 'data' && msg.data?.transcript) toClient({ transcript: msg.data.transcript })
      else if (msg.type === 'error') toClient({ error: msg.data?.message || 'Sarvam error' })
    })
    sarvam.on('error', (err) => { toClient({ error: 'Sarvam connection error: ' + err.message }); try { client.close() } catch {} })
    sarvam.on('close', () => { try { client.close() } catch {} })

    // --- Client -> Sarvam relay ---
    client.on('message', (raw) => {
      // Audio frames are base64 strings; ignore anything non-text/empty.
      const data = raw.toString()
      if (data) sendToSarvam(data)
    })
    client.on('close', () => { try { sarvam.close() } catch {} })
    client.on('error', () => { try { sarvam.close() } catch {} })
  })

  return wss
}

export function attachLiveTranscribe(server) {
  return attachSarvamRelay(server, {
    path: '/api/meetings/live',
    // Only managers/admins may stream a meeting.
    allowUser: (u) => u.role === 'manager' || u.role === 'admin',
    // Lock to a single language so live meeting audio is never mis-transcribed into
    // other Indian languages. Client may request one of en/hi/te; otherwise (or
    // "unknown") fall back to SARVAM_LANGUAGE (default English).
    pickLanguage: (requested) => (requested && requested !== 'unknown')
      ? requested
      : (process.env.SARVAM_LANGUAGE || 'en-IN'),
  })
}

export function attachAssistantLive(server) {
  return attachSarvamRelay(server, {
    path: '/api/assistant/live',
    // Voice commands are for everyone — same as POST /assistant/command.
    allowUser: () => true,
    // Auto-detect by default: commands are code-mixed Telugu/Hindi/English and the
    // meeting-style en-IN lock mangles them. VOICE_STT_LANGUAGE pins it if a
    // deployment finds auto-detect drifting into other languages.
    pickLanguage: () => process.env.VOICE_STT_LANGUAGE || 'unknown',
  })
}
