// Orchestrator: choose Claude when configured, else the rule-based engine.
// Then resolve spoken names to real user records and return a unified result.
import { analyzeTranscript } from './rules.js'
import { analyzeWithClaude } from './claude.js'
import { analyzeWithOpenAI } from './openai.js'
import { db } from '../db.js'

// Match a spoken/raw name to a user in the org via name, alias, or fuzzy contains.
export function resolveUser(orgId, rawName) {
  if (!rawName) return null
  const users = db.prepare('SELECT * FROM users WHERE org_id = ?').all(orgId)
  const norm = (s) => (s || '').toLowerCase().trim()
  const target = norm(rawName)

  // exact name
  let hit = users.find((u) => norm(u.name) === target)
  if (hit) return hit
  // alias list
  hit = users.find((u) => (u.aliases || '').split(',').map(norm).filter(Boolean).includes(target))
  if (hit) return hit
  // first-name match
  hit = users.find((u) => norm(u.name).split(' ')[0] === target)
  if (hit) return hit
  // contains either direction
  hit = users.find((u) => norm(u.name).includes(target) || target.includes(norm(u.name).split(' ')[0]))
  return hit || null
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
  // Engine priority: Claude (if configured) → OpenAI/GPT (if configured) → offline rules.
  const hasClaude = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI = !!process.env.OPENAI_API_KEY

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
