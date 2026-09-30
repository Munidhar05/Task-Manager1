// Ties every line of a meeting summary back to the sentence that produced it.
//
// A summary a manager cannot check is a summary they have to take on trust, and
// the one question anyone actually asks of an AI summary is "where did that come
// from?". Suggested TASKS already carried a source_quote; the summary did not —
// rules.js built decisions and risks straight out of transcript sentences and
// then threw the sentence away with `.map(d => d.text)`.
//
// This runs AFTER whichever engine produced the analysis, so it works the same
// for the rule-based fallback and for every LLM tier, and needs no change to any
// model prompt. For the rule engine the summary line IS a transcript sentence,
// so the match is exact; for an LLM it is a paraphrase, so the match is the
// best-overlapping segment and the score says how sure that is.
import { parseSegments } from './rules.js'

// Words too common to carry meaning. Kept deliberately short: a long stop list
// starts throwing away the domain words ("order", "site") that make a match.
const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'have', 'has', 'had', 'will', 'would',
  'are', 'was', 'were', 'from', 'they', 'them', 'you', 'your', 'but', 'not', 'can',
  'all', 'our', 'their', 'there', 'then', 'than', 'been', 'being', 'into', 'about',
  'some', 'what', 'when', 'which', 'who', 'how', 'its', 'his', 'her', 'she', 'him',
])

const words = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .filter((w) => w.length > 2 && !STOP.has(w))

/**
 * The transcript segment a summary point most likely came from, or null when
 * nothing matches well enough to be worth showing.
 *
 * Scored on how much of the POINT is accounted for by the segment, not the other
 * way round: a long segment that happens to contain the whole point is a good
 * source, while a short segment sharing one word with a long point is not.
 */
export function bestEvidence(point, segments) {
  const want = words(point)
  if (!want.length) return null
  const wanted = new Set(want)

  let best = null
  let bestScore = 0
  for (const seg of segments) {
    const got = new Set(words(seg.text))
    if (!got.size) continue
    let hits = 0
    for (const w of wanted) if (got.has(w)) hits++
    let score = hits / wanted.size
    // A near-verbatim line (the rule engine's case) should always beat a merely
    // topical one, even when the segment carries a lot of other words.
    if (String(seg.text).toLowerCase().includes(String(point).toLowerCase().trim())) score = 1
    if (score > bestScore) { bestScore = score; best = seg }
  }

  // Below this it is a guess, and a wrong quote is worse than no quote — it
  // would have someone defending a decision against a sentence nobody said.
  if (!best || bestScore < 0.34) return null
  return {
    quote: best.text,
    speaker: best.speaker,
    seq: best.seq,
    language: best.language || 'en',
    match: Math.round(bestScore * 100),
  }
}

// Summary sections that are lists of points worth citing. `executive_summary` is
// deliberately absent: it describes the whole meeting, so no single line is its
// source, and pointing at one would be a lie dressed as provenance.
const CITED = ['key_decisions', 'action_items', 'risks', 'blockers', 'follow_ups']

/**
 * Rewrite a summary's point lists from `string[]` to `{ text, evidence }[]`.
 *
 * Idempotent, and tolerant of an engine that already returned objects, so it is
 * safe to run over any tier's output. Old meetings stored as plain strings keep
 * working — the client normalises either shape.
 */
export function attachEvidence(analysis, transcript) {
  if (!analysis?.summary || !transcript) return analysis
  let segments = []
  try { segments = parseSegments(transcript) } catch { return analysis }
  if (!segments.length) return analysis

  for (const key of CITED) {
    const list = analysis.summary[key]
    if (!Array.isArray(list) || !list.length) continue
    analysis.summary[key] = list.map((item) => {
      const text = typeof item === 'string' ? item : (item?.text ?? '')
      if (item && typeof item === 'object' && item.evidence) return item   // already cited
      return { text, evidence: bestEvidence(text, segments) }
    })
  }
  return analysis
}
