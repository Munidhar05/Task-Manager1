// Text-to-speech proxy. The client posts a sentence and gets MP3 back; the
// ElevenLabs key never leaves the server (see ai/speech.js for why).
import { Router } from 'express'
import { Readable, pipeline } from 'node:stream'
import { authRequired } from '../auth.js'
import { synthesize, synthesizeStream, ttsConfigured, ttsModel, TTS_MAX_CHARS } from '../ai/speech.js'
import { recordUsage } from '../ai/usage.js'

const r = Router()
r.use(authRequired)

// Capability probe. The client asks once per session so it can pick its voice path
// up front, rather than attempting a network round-trip before every single reply
// on a deployment that has no key.
r.get('/status', (req, res) => {
  res.json({ enabled: ttsConfigured(), voice: ttsConfigured() ? ttsModel() : null })
})

r.post('/speak', async (req, res) => {
  const text = String(req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'text required' })
  // Not configured is a normal state, not an error: the client falls back to the
  // on-device voice. 503 says "try again elsewhere", which is exactly right.
  if (!ttsConfigured()) return res.status(503).json({ error: 'TTS not configured' })

  const clipped = text.slice(0, TTS_MAX_CHARS)

  try {
    const audio = await synthesize(clipped)
    // Billed per character, so the character count is what gets recorded.
    recordUsage({
      orgId: req.user.org_id,
      userId: req.user.id,
      provider: 'elevenlabs',
      feature: 'voice_tts',
      model: ttsModel(),
      inputTokens: clipped.length,
    })
    res.set('content-type', 'audio/mpeg')
    // Same sentence, same audio — let the browser reuse it. The assistant repeats
    // short phrases constantly ("Okay, cancelled.", "Shall I go ahead?"), and each
    // repeat is otherwise a paid API call and a fresh round-trip of latency.
    res.set('cache-control', 'private, max-age=86400')
    res.send(audio)
  } catch (err) {
    console.warn('[tts] synthesis failed:', err.message)
    // Never 500 here. A failed voice is not a failed action — the client speaks the
    // same sentence with the on-device voice and the user barely notices.
    res.status(502).json({ error: 'TTS unavailable' })
  }
})

// Streaming variant of /speak: MP3 bytes are piped through as ElevenLabs produces
// them, so playback can begin before synthesis finishes. No cache-control here —
// a partial stream must never be cached and replayed as if it were the whole clip;
// the client keeps its own completed-blob cache instead.
r.post('/stream', async (req, res) => {
  const text = String(req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'text required' })
  if (!ttsConfigured()) return res.status(503).json({ error: 'TTS not configured' })

  const clipped = text.slice(0, TTS_MAX_CHARS)

  try {
    const upstream = await synthesizeStream(clipped)
    recordUsage({
      orgId: req.user.org_id,
      userId: req.user.id,
      provider: 'elevenlabs',
      feature: 'voice_tts',
      model: ttsModel(),
      inputTokens: clipped.length,
    })
    res.set('content-type', 'audio/mpeg')
    // pipeline (not .pipe) so a barge-in — the client aborting mid-playback — tears
    // down the upstream ElevenLabs stream instead of leaving it draining for nothing.
    pipeline(Readable.fromWeb(upstream), res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn('[tts] stream ended:', err.message)
    })
  } catch (err) {
    console.warn('[tts] stream synthesis failed:', err.message)
    // Same contract as /speak: a failed voice is not a failed action.
    res.status(502).json({ error: 'TTS unavailable' })
  }
})

export default r
