// Text-to-speech via ElevenLabs — the assistant's voice.
//
// This exists because the browser's built-in speechSynthesis, which the app used
// until now, sounds like a screen reader. For an assistant that is meant to feel
// like a colleague operating the app, the voice IS most of the impression: the same
// sentence read by a flat system voice reads as a robot reporting, and read by a
// natural one reads as someone telling you what they did.
//
// It is OPTIONAL, like every other provider here. With no ELEVENLABS_API_KEY the
// module reports itself unavailable and the client falls straight back to the
// on-device voice — the app must keep working with no keys at all, and a missing
// TTS key must never cost the user a spoken reply.
//
// The key stays server-side. A browser calling ElevenLabs directly would have to
// ship the key in the bundle, where anyone can read it out of the Android APK or
// devtools and spend the account's credits.

const API = 'https://api.elevenlabs.io/v1/text-to-speech'

// Rachel — a calm, neutral, professional read that suits short status sentences.
// Override with ELEVENLABS_VOICE_ID; browse voices at elevenlabs.io/app/voice-library.
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'

// Turbo, not v3, and measured rather than assumed. Round-trip on real assistant
// sentences from this account:
//
//   "Done, I have assigned Review API documentation to Ravi Kumar."
//     turbo_v2_5 0.59s | flash_v2_5 0.84s | v3 2.64s
//   "Who should I assign it to?"
//     turbo_v2_5 0.48s | flash_v2_5 0.65s | v3 1.32s
//
// v3 is the better model and the wrong one for this workload. Its advantage is
// emotional range over long-form narration; everything spoken here is one short
// factual status line, so there is nothing for that range to act on — you would pay
// 3x the latency for a capability the content cannot use. It lands worst on a
// clarifying question, where the user is waiting to answer and the loop only
// re-opens the mic once speech ends. Turbo also bills at about half v3 per
// character. Override with ELEVENLABS_MODEL if a voice needs a different engine.
const DEFAULT_MODEL = 'eleven_turbo_v2_5'

export const ttsConfigured = () => !!process.env.ELEVENLABS_API_KEY

export const ttsVoice = () => process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE
export const ttsModel = () => process.env.ELEVENLABS_MODEL || DEFAULT_MODEL

// Longer than any reply the assistant produces. Guards against a caller passing a
// whole meeting transcript in and burning the account's credits on one request.
export const TTS_MAX_CHARS = 800

// Shared request against either the buffered or the /stream endpoint. Same body,
// same error handling; only what happens to the response bytes differs.
async function requestTts(text, endpointSuffix, signal) {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error('TTS not configured')

  const body = {
    text,
    model_id: ttsModel(),
    // stability/similarity at ElevenLabs' balanced defaults; `speed` slightly above
    // 1 because status lines ("Done — I've assigned that to Ravi") drag at 1.0.
    voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.05 },
  }

  const res = await fetch(`${API}/${ttsVoice()}${endpointSuffix}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    // ElevenLabs returns JSON errors even on a binary endpoint. Surface the detail —
    // "quota exceeded" and "voice not found" need very different fixes, and both
    // otherwise present identically as "the assistant went quiet".
    const detail = await res.text().catch(() => '')
    throw new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 200) || res.statusText}`)
  }

  return res
}

// Synthesize `text` to MP3. Returns a Buffer, or throws with a message safe to log.
export async function synthesize(text, { signal } = {}) {
  const res = await requestTts(text, '', signal)
  return Buffer.from(await res.arrayBuffer())
}

// Synthesize `text` as a live MP3 stream (web ReadableStream). The first chunk
// arrives while the tail is still being generated, so the client can START PLAYING
// a few hundred ms in instead of waiting for the whole clip — the difference
// between the assistant answering and the assistant hesitating.
export async function synthesizeStream(text, { signal } = {}) {
  const res = await requestTts(text, '/stream', signal)
  if (!res.body) throw new Error('ElevenLabs returned no stream body')
  return res.body
}
