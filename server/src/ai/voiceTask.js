// Turn a single spoken sentence into structured task fields.
// Example speech: "Create a high priority task for Ravi to fix the login page bug before Friday."
// → { title, description, assignee_name, priority, due_date_raw }
//
// Mirrors the provider chain used by the meeting extractor: OpenRouter
// (OPENROUTER_API_KEY) first, then Claude (ANTHROPIC_API_KEY), then OpenAI
// (OPENAI_API_KEY). When no key is set, the caller should fall back to using the
// raw transcript as the title.
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

export const hasLLM = () => !!(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)

const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']

const SYSTEM_PROMPT = `You are a task-intake assistant inside a team task manager.
A person is dictating ONE task out loud (English, Hindi, Telugu, or a code-mixed blend). Listen carefully and extract the structured task they intend to create.

Extract these fields:
- title: a SHORT, clear task title in ENGLISH (imperative, ≤ 8 words, e.g. "Fix the login page bug"). Capture only the core action — push the detail into the description. Always required.
- description: ALWAYS write a concise 1-2 sentence description in ENGLISH that explains what the task involves — the goal, context, or what "done" looks like. NEVER leave it empty. If the speaker gave extra detail, summarize it here. If they gave only a short task, still write one helpful clarifying sentence about it (do NOT just repeat the title word-for-word).
- assignee_name: the person the task is FOR, exactly as spoken (e.g. "Ravi", "Reddeppa"). null if no person was named. Pick the name from the provided team list when it clearly matches; otherwise keep the spoken name.
- priority: one of Critical | High | Medium | Low. Infer from urgency cues ("urgent"/"ASAP"/"production down"/"today" => High or Critical; routine/"whenever"/"someday" => Low). Default to "Medium" when there is no signal.
- due_date_raw: the natural-language deadline exactly as spoken ("by Friday", "tomorrow", "repu", "next week"), or null if none.

Be precise: capture exactly what the speaker asked for — do not invent tasks, people, deadlines, or priorities they did not state. Always translate title and description to English even if spoken in another language. Ignore filler, greetings, and self-corrections — capture the final intent.

Respond with ONLY a JSON object, no markdown fences:
{"title":"...","description":"...","assignee_name":"...|null","priority":"Medium","due_date_raw":"...|null"}`

function buildUserMsg(transcript, users) {
  const names = (users || []).map((u) => `- ${u.name}${u.role ? ` (${u.role})` : ''}`).join('\n') || 'none provided'
  return `Team members the task can be assigned to:\n${names}\n\nSPOKEN TASK:\n${transcript}`
}

export function parseJson(text) {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

export async function callOpenRouter(system, userMsg, onUsage) {
  const model = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash'
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'SmartTask AI',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  })
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  if (onUsage) onUsage({ provider: 'openrouter', model, inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0 })
  return data.choices?.[0]?.message?.content || ''
}

export async function callClaude(system, userMsg, onUsage) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8'
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  })
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  if (onUsage) onUsage({ provider: 'anthropic', model, inputTokens: data.usage?.input_tokens || 0, outputTokens: data.usage?.output_tokens || 0 })
  return (data.content || []).map((c) => c.text || '').join('')
}

export async function callOpenAI(system, userMsg, onUsage) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 512,
    }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  if (onUsage) onUsage({ provider: 'openai', model, inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0 })
  return data.choices?.[0]?.message?.content || ''
}

// Returns { title, description, assignee_name, priority, due_date_raw }. Throws if
// no provider is configured or the call/parse fails — the route handles fallback.
export async function parseSpokenTask(transcript, { users = [], onUsage } = {}) {
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY
  const hasClaude = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI = !!process.env.OPENAI_API_KEY
  if (!hasOpenRouter && !hasClaude && !hasOpenAI) throw new Error('No LLM configured')

  const userMsg = buildUserMsg(transcript, users)
  // Try each configured provider in turn (OpenRouter → Claude → OpenAI), falling
  // through on error so a single out-of-credits/quota provider doesn't break voice.
  let raw
  const providers = [
    hasOpenRouter && { name: 'OpenRouter', call: callOpenRouter },
    hasClaude && { name: 'Claude', call: callClaude },
    hasOpenAI && { name: 'OpenAI', call: callOpenAI },
  ].filter(Boolean)
  let lastErr
  for (const p of providers) {
    try { raw = await p.call(SYSTEM_PROMPT, userMsg, onUsage); if (raw) break }
    catch (err) { lastErr = err; console.warn(`[voiceTask] ${p.name} failed, trying next:`, err.message) }
  }
  if (raw === undefined) throw lastErr || new Error('All providers failed')

  const obj = parseJson(raw)
  if (!obj || !obj.title) throw new Error('Empty model response')

  return {
    title: String(obj.title).trim(),
    description: typeof obj.description === 'string' ? obj.description.trim() : '',
    assignee_name: obj.assignee_name ? String(obj.assignee_name).trim() : null,
    priority: PRIORITIES.includes(obj.priority) ? obj.priority : 'Medium',
    due_date_raw: obj.due_date_raw ? String(obj.due_date_raw).trim() : null,
  }
}
