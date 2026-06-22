// Orchestrator: choose Claude when configured, else the rule-based engine.
// Then resolve spoken names to real user records and return a unified result.
import { analyzeTranscript } from './rules.js'
import { analyzeWithClaude } from './claude.js'
import { analyzeWithOpenAI } from './openai.js'
import { analyzeWithOpenRouter } from './openrouter.js'
import { db } from '../db.js'

// Match a spoken/raw name to a user in the org via name, alias, or token match.
// Matching is WHOLE-WORD, not loose substring — so "an" never matches "Ananya"
// and a spoken sentence only assigns when it actually contains the person's name.
export function resolveUser(orgId, rawName) {
  if (!rawName) return null
  const users = db.prepare('SELECT * FROM users WHERE org_id = ?').all(orgId)
  const norm = (s) => (s || '').toLowerCase().trim()
  const target = norm(rawName)
  if (!target) return null
  const tokens = (s) => norm(s).split(/\s+/).filter(Boolean)
  const targetTokens = tokens(target)

  // 1. Exact full name.
  let hit = users.find((u) => norm(u.name) === target)
  if (hit) return hit
  // 2. Alias list (comma-separated), exact match on a whole alias.
  hit = users.find((u) => (u.aliases || '').split(',').map(norm).filter(Boolean).includes(target))
  if (hit) return hit
  // 3. First name exactly equals what was spoken ("Ravi" -> "Ravi Kumar").
  hit = users.find((u) => tokens(u.name)[0] === target)
  if (hit) return hit
  // 4. Any name token exactly matches a spoken token (≥ 2 chars) — handles a
  //    surname or a phrase that contains the person's name.
  hit = users.find((u) => tokens(u.name).some((nt) => nt.length >= 2 && targetTokens.includes(nt)))
  if (hit) return hit
  // 5. Last resort: a clear prefix match on the first name (spoken "Reddep" for
  //    "Reddeppa"), only for fragments ≥ 4 chars to avoid false hits.
  if (target.length >= 4) {
    hit = users.find((u) => {
      const first = tokens(u.name)[0] || ''
      return first && (first.startsWith(target) || target.startsWith(first))
    })
    if (hit) return hit
  }
  return null
}

// Resolve a spoken name to a user, restricted to a set of allowed user IDs
// (the meeting attendees). The AI must never assign work to a non-attendee.
export function resolveUserAmong(orgId, rawName, allowedIds) {
  const u = resolveUser(orgId, rawName)
  if (!u) return null
  if (allowedIds && allowedIds.length && !allowedIds.includes(u.id)) return null
  return u
}

export async function analyzeMeetingTranscript(transcript, opts = {}) {
  // Engine priority: OpenRouter (primary) → Claude → OpenAI/GPT → offline rules.
  // Each tier is tried only if its key is set, falling through on error.
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY
  const hasClaude = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI = !!process.env.OPENAI_API_KEY

  if (hasOpenRouter) {
    try { return await analyzeWithOpenRouter(transcript, opts) }
    catch (err) { console.warn('[ai] OpenRouter failed:', err.message) }
  }
  if (hasClaude) {
    try { return await analyzeWithClaude(transcript, opts) }
    catch (err) { console.warn('[ai] Claude failed:', err.message) }
  }
  if (hasOpenAI) {
    try { return await analyzeWithOpenAI(transcript, opts) }
    catch (err) {
      console.warn('[ai] OpenAI failed, falling back to rule-based:', err.message)
      const result = analyzeTranscript(transcript, opts)
      result.fallback_reason = err.message
      return result
    }
  }
  return analyzeTranscript(transcript, opts)
}
