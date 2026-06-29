// Turn a spoken task-SEARCH request into structured search filters.
// The speaker may use any language (English, Hindi, Kannada, Telugu, Tamil or a
// code-mixed blend) and names are often heard in a non-Latin script (e.g. the mic
// hears "Shabbir" and transcribes "शब्बीर"). We translate everything to English /
// Latin so it can match the (English) task and employee data, and we split the
// request into: free-text keywords, a named person, an optional status/priority.
//
// Reuses the same provider chain + JSON parsing as the task-creation voice flow.
import { callOpenRouter, callClaude, callOpenAI, parseJson, hasLLM } from './voiceTask.js'

export { hasLLM }

const STATUSES = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened']
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']

const SYSTEM_PROMPT = `You convert a SPOKEN search request into structured filters for a team task manager's search box.
The speaker may use ANY language (English, Hindi, Kannada, Telugu, Tamil, or a code-mixed blend) and a person's name may have been transcribed in a non-Latin script (e.g. Devanagari "शब्बीर" means "Shabbir"). Always understand the intent and ALWAYS output ENGLISH / Latin script.

Extract these fields:
- query: the English keywords to match against task titles/descriptions (e.g. "login bug", "payment report"). Use an EMPTY string if the person only named an employee or only asked by status/priority with no topic.
- person: the employee whose tasks they want, transliterated to Latin and matched to a name in the team list when one clearly fits (e.g. "शब्बीर" -> "Shabbir", "give me ravi tasks" -> "Ravi"). null if no person was mentioned.
- status: one of ${STATUSES.join(' | ')} if they asked for a particular state, else null.
- priority: one of ${PRIORITIES.join(' | ')} if they asked for a priority, else null.

Rules:
- Transliterate / translate names to how they appear in the team list. Prefer an exact team-list name over a phonetic guess.
- Do NOT invent keywords, people, statuses, or priorities that were not spoken.
- If they only say a name ("Shabbir", "Ravi ke tasks"), set person and leave query empty so ALL of that person's tasks are returned.

Respond with ONLY a JSON object, no markdown fences:
{"query":"...","person":"...|null","status":"...|null","priority":"...|null"}`

function buildUserMsg(transcript, users) {
  const names = (users || []).map((u) => `- ${u.name}${u.role ? ` (${u.role})` : ''}`).join('\n') || 'none provided'
  return `Team members whose tasks can be searched:\n${names}\n\nSPOKEN SEARCH REQUEST:\n${transcript}`
}

// Returns { query, person, status, priority }. Throws only if no provider is
// configured; the route catches errors and falls back to the raw transcript.
export async function interpretVoiceSearch(transcript, { users = [] } = {}) {
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY
  const hasClaude = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI = !!process.env.OPENAI_API_KEY
  if (!hasOpenRouter && !hasClaude && !hasOpenAI) throw new Error('No LLM configured')

  const userMsg = buildUserMsg(transcript, users)
  const providers = [
    hasOpenRouter && { name: 'OpenRouter', call: callOpenRouter },
    hasClaude && { name: 'Claude', call: callClaude },
    hasOpenAI && { name: 'OpenAI', call: callOpenAI },
  ].filter(Boolean)
  let raw, lastErr
  for (const p of providers) {
    try { raw = await p.call(SYSTEM_PROMPT, userMsg); if (raw) break }
    catch (err) { lastErr = err; console.warn(`[voiceSearch] ${p.name} failed, trying next:`, err.message) }
  }
  if (raw === undefined) throw lastErr || new Error('All providers failed')

  const obj = parseJson(raw) || {}
  return {
    query: typeof obj.query === 'string' ? obj.query.trim() : '',
    person: obj.person && String(obj.person).trim() ? String(obj.person).trim() : null,
    status: STATUSES.includes(obj.status) ? obj.status : null,
    priority: PRIORITIES.includes(obj.priority) ? obj.priority : null,
  }
}
