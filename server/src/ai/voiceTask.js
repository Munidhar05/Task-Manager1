// Turn a single spoken sentence into structured task fields.
// Example speech: "Create a high priority task for Ravi to fix the login page bug before Friday."
// → { title, description, assignee_name, priority, due_date_raw }
//
// Mirrors the provider chain used elsewhere: Claude (ANTHROPIC_API_KEY) first,
// then OpenAI (OPENAI_API_KEY). When no key is set, the caller should fall back
// to using the raw transcript as the title.
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

export const hasLLM = () => !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)

const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']

const SYSTEM_PROMPT = `You are a task-intake assistant inside a team task manager.
A person is dictating ONE task out loud (English, Hindi, Telugu, or a code-mixed blend). Listen carefully and extract the structured task they intend to create.

Extract these fields:
- title: a short, clear task title in ENGLISH (imperative, e.g. "Fix the login page bug"). Always required.
- description: any extra detail or context they gave, in ENGLISH. Use "" if they gave none — do NOT just repeat the title.
- assignee_name: the person the task is FOR, exactly as spoken (e.g. "Ravi", "Reddeppa"). null if no person was named. Pick the name from the provided team list when it clearly matches; otherwise keep the spoken name.
- priority: one of Critical | High | Medium | Low. Infer from urgency cues ("urgent"/"ASAP"/"production down"/"today" => High or Critical; routine/"whenever"/"someday" => Low). Default to "Medium" when there is no signal.
- due_date_raw: the natural-language deadline exactly as spoken ("by Friday", "tomorrow", "repu", "next week"), or null if none.

Always translate title and description to English even if spoken in another language. Ignore filler, greetings, and self-corrections — capture the final intent.

Respond with ONLY a JSON object, no markdown fences:
{"title":"...","description":"...","assignee_name":"...|null","priority":"Medium","due_date_raw":"...|null"}`

function buildUserMsg(transcript, users) {
  const names = (users || []).map((u) => `- ${u.name}${u.role ? ` (${u.role})` : ''}`).join('\n') || 'none provided'
  return `Team members the task can be assigned to:\n${names}\n\nSPOKEN TASK:\n${transcript}`
}

function parseJson(text) {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

async function callClaude(system, userMsg) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  })
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return (data.content || []).map((c) => c.text || '').join('')
}

async function callOpenAI(system, userMsg) {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 512,
    }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

// Returns { title, description, assignee_name, priority, due_date_raw }. Throws if
// no provider is configured or the call/parse fails — the route handles fallback.
export async function parseSpokenTask(transcript, { users = [] } = {}) {
  const hasClaude = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI = !!process.env.OPENAI_API_KEY
  if (!hasClaude && !hasOpenAI) throw new Error('No LLM configured')

  const userMsg = buildUserMsg(transcript, users)
  let raw
  if (hasClaude) {
    try { raw = await callClaude(SYSTEM_PROMPT, userMsg) }
    catch (err) {
      if (!hasOpenAI) throw err
      console.warn('[voiceTask] Claude failed, trying OpenAI:', err.message)
    }
  }
  if (raw === undefined && hasOpenAI) raw = await callOpenAI(SYSTEM_PROMPT, userMsg)

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
