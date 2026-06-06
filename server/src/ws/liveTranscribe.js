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
import { WebSocketServer, WebSocket } from 'ws'
import { verifyToken } from '../auth.js'

const SARVAM_WS = 'wss://api.sarvam.ai/speech-to-text/ws'

export function attachLiveTranscribe(server) {
  const wss = new WebSocketServer({ server, path: '/api/meetings/live' })

  wss.on('connection', (client, req) => {
    const url = new URL(req.url, 'http://localhost')
    const token = url.searchParams.get('token')
    const language = url.searchParams.get('language') || 'unknown'

    // --- Auth: only managers/admins may stream a meeting ---
    const user = verifyToken(token)
    if (!user || (user.role !== 'manager' && user.role !== 'admin')) {
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
