// Server-side speech-to-text with automatic language detection.
// Primary provider: Sarvam AI (saarika) — built for Telugu/Hindi/English + code-mixing.
// Also supports OpenAI / Groq Whisper. Node 18+ provides global fetch/FormData/Blob.

// opts.prompt = recent transcript text used as context so the model keeps names
// and spelling consistent across consecutive live segments (auto-correction).
export async function transcribeAudio(buffer, filename = 'audio.webm', mimetype = 'audio/webm', opts = {}) {
  const provider = (process.env.TRANSCRIPTION_PROVIDER || 'none').toLowerCase()
  if (provider === 'none') {
    const err = new Error('No transcription provider configured. Set TRANSCRIPTION_PROVIDER in server/.env (e.g. "sarvam") and the matching API key.')
    err.code = 'NO_PROVIDER'
    throw err
  }
  if (provider === 'sarvam') return sarvam(buffer, filename, mimetype)
  if (provider === 'openai' || provider === 'groq') return whisper(buffer, filename, mimetype, provider, opts)
  throw new Error(`Unknown TRANSCRIPTION_PROVIDER "${provider}"`)
}

// Sarvam AI — https://docs.sarvam.ai (Speech-to-Text). language_code "unknown" => auto-detect.
async function sarvam(buffer, filename, mimetype) {
  const key = process.env.SARVAM_API_KEY
  if (!key) throw new Error('SARVAM_API_KEY is not set in server/.env')
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimetype }), filename)
  form.append('model', process.env.SARVAM_MODEL || 'saarika:v2.5')
  form.append('language_code', 'unknown') // auto-detect language (incl. code-mixed Indian languages)
  const res = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: { 'api-subscription-key': key },
    body: form,
  })
  if (!res.ok) throw new Error(`Sarvam ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  return { text: data.transcript || '', language: data.language_code || null }
}

// OpenAI (gpt-4o-transcribe by default — more accurate than whisper-1) or Groq
// (whisper-large-v3). Both auto-detect language. opts.prompt biases the model
// with prior context so names/terms stay consistent across live segments.
async function whisper(buffer, filename, mimetype, provider, opts = {}) {
  const isGroq = provider === 'groq'
  const key = isGroq ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY
  if (!key) throw new Error(`${isGroq ? 'GROQ_API_KEY' : 'OPENAI_API_KEY'} is not set in server/.env`)
  const base = isGroq ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1'
  const model = isGroq
    ? (process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3')
    : (process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe')
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimetype }), filename)
  form.append('model', model)
  form.append('response_format', 'json')
  // Context prompt (≤ ~224 tokens) keeps spelling/names consistent chunk-to-chunk.
  if (opts.prompt) form.append('prompt', String(opts.prompt).slice(-450))
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
  })
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  return { text: data.text || '', language: data.language || null }
}
