// Per-organization usage tracking for the external AI / transcription API keys.
// Every provider call is logged to usage_events with token counts and an ESTIMATED
// US-dollar cost, so the platform (super) admin can see how much each organization
// consumes. Costs are best-effort estimates from public list prices — treat them
// as indicative, not an invoice.
import { db } from '../db.js'
import { id, now } from '../util.js'

// Approximate list prices in USD per 1,000,000 tokens, keyed by provider then by a
// substring of the model name. Falls back to the provider's '*' default. Update
// these as pricing changes — they only affect the cost ESTIMATE, never behaviour.
const TOKEN_PRICES = {
  anthropic: {
    'opus': { in: 15, out: 75 },
    'sonnet': { in: 3, out: 15 },
    'haiku': { in: 0.8, out: 4 },
    '*': { in: 3, out: 15 },
  },
  openai: {
    'gpt-4o-mini': { in: 0.15, out: 0.6 },
    'gpt-4o': { in: 2.5, out: 10 },
    'gpt-4.1-mini': { in: 0.4, out: 1.6 },
    'transcribe': { in: 2.5, out: 10 },   // gpt-4o-transcribe (token-billed)
    'embedding': { in: 0.02, out: 0 },
    '*': { in: 0.5, out: 1.5 },
  },
  openrouter: {
    'gemini-2.5-flash': { in: 0.3, out: 2.5 },
    'gemini': { in: 0.3, out: 2.5 },
    '*': { in: 0.5, out: 1.5 },
  },
  groq: {
    'whisper': { in: 0, out: 0 },          // billed per audio-hour; counted as calls
    '*': { in: 0.1, out: 0.3 },
  },
}

// Flat per-call estimate (USD) for providers billed by audio, not tokens.
const PER_CALL_PRICES = {
  sarvam: 0.003,   // ~ a few seconds of speech-to-text
  groq: 0.001,     // whisper-large-v3 audio transcription
}

// Rough token estimate when a provider does not return exact usage (~4 chars/token).
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4)
}

function priceFor(provider, model) {
  const table = TOKEN_PRICES[provider]
  if (!table) return null
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(table)) {
    if (key !== '*' && m.includes(key)) return table[key]
  }
  return table['*'] || null
}

// Estimate USD cost for one call from token counts (+ any flat per-call price).
export function estimateCost({ provider, model, inputTokens = 0, outputTokens = 0 }) {
  let cost = PER_CALL_PRICES[provider] || 0
  const p = priceFor(provider, model)
  if (p) cost += (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out
  return cost
}

// Aggregate one org's usage: grand total + breakdowns by provider and feature.
// Optional { since } is an ISO timestamp lower-bound (inclusive) for a time window.
export function usageForOrg(orgId, { since } = {}) {
  const args = [orgId]
  let where = 'org_id=?'
  if (since) { where += ' AND created_at>=?'; args.push(since) }
  const total = db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input_tokens,
    COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(total_tokens),0) AS tokens,
    COALESCE(SUM(cost_usd),0) AS cost FROM usage_events WHERE ${where}`).get(...args)
  const by_provider = db.prepare(`SELECT provider, COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens,
    COALESCE(SUM(cost_usd),0) AS cost FROM usage_events WHERE ${where} GROUP BY provider ORDER BY cost DESC`).all(...args)
  const by_feature = db.prepare(`SELECT feature, COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens,
    COALESCE(SUM(cost_usd),0) AS cost FROM usage_events WHERE ${where} GROUP BY feature ORDER BY cost DESC`).all(...args)
  return { total, by_provider, by_feature }
}

// Log one usage event. NEVER throws — usage tracking must not break a feature.
export function recordUsage({ orgId, userId = null, provider, feature, model = null, inputTokens = 0, outputTokens = 0 }) {
  try {
    if (!orgId || !provider || !feature) return
    const inTok = Math.max(0, Math.round(inputTokens || 0))
    const outTok = Math.max(0, Math.round(outputTokens || 0))
    const cost = estimateCost({ provider, model, inputTokens: inTok, outputTokens: outTok })
    db.prepare(`INSERT INTO usage_events
      (id, org_id, user_id, provider, feature, model, input_tokens, output_tokens, total_tokens, cost_usd, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id('use'), orgId, userId, provider, feature, model, inTok, outTok, inTok + outTok, cost, now())
  } catch (err) {
    console.warn('[usage] failed to record event:', err.message)
  }
}
