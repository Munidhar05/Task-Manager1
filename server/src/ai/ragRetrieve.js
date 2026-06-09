// RAG retrieval: given a question and the requesting user, embed the question,
// filter the embedding store down to ONLY what this user is allowed to see, then
// rank by cosine similarity and return the top chunks. RBAC is applied to the
// CANDIDATE SET before ranking — a retrieved chunk can never be one the user
// couldn't otherwise access (the #1 RAG data-leak pitfall).
import { db } from '../db.js'
import { hasEmbeddings, embedQuery, fromBlob, cosineSim } from './embeddings.js'

const DEFAULT_TOP_K = 12
const MIN_SCORE = 0.2 // drop weak matches so unrelated chunks don't pad the prompt

// Build the set of source ids this user may see, per source type.
// Managers/admins see the whole org; employees are scoped down.
function visibility(user) {
  if (user.role !== 'employee') return { all: true }
  const convos = new Set(
    db.prepare('SELECT conversation_id FROM chat_participants WHERE user_id=?')
      .all(user.id).map((r) => r.conversation_id)
  )
  const meetings = new Set(
    db.prepare('SELECT meeting_id FROM meeting_participants WHERE user_id=?')
      .all(user.id).map((r) => r.meeting_id)
  )
  const segments = new Set(
    db.prepare(`SELECT s.id FROM transcript_segments s
                JOIN meeting_participants mp ON mp.meeting_id = s.meeting_id
                WHERE mp.user_id=?`).all(user.id).map((r) => r.id)
  )
  return { all: false, convos, meetings, segments }
}

function canSee(row, user, vis) {
  if (vis.all) return true
  switch (row.source_type) {
    case 'task': return row.ref_user_id === user.id
    case 'chat': return vis.convos.has(row.ref_convo_id)
    case 'meeting': return vis.meetings.has(row.source_id)
    case 'segment': return vis.segments.has(row.source_id)
    default: return false
  }
}

// Returns { hits: [{source_type, source_id, text, score}], used } where `used`
// is true when RAG actually ran (provider configured AND an index exists).
export async function retrieve(query, user, { topK = DEFAULT_TOP_K, types } = {}) {
  if (!hasEmbeddings()) return { hits: [], used: false }

  const count = db.prepare('SELECT COUNT(*) AS n FROM embeddings WHERE org_id=?').get(user.org_id).n
  if (!count) return { hits: [], used: false } // nothing indexed yet — caller keeps its old path

  let qvec
  try { qvec = await embedQuery(query) } catch (e) {
    console.warn('[rag] query embed failed:', e.message)
    return { hits: [], used: false }
  }
  if (!qvec) return { hits: [], used: false }

  const vis = visibility(user)
  const typeFilter = Array.isArray(types) && types.length ? new Set(types) : null

  const rows = db.prepare('SELECT * FROM embeddings WHERE org_id=?').all(user.org_id)
  const scored = []
  for (const row of rows) {
    if (typeFilter && !typeFilter.has(row.source_type)) continue
    if (!canSee(row, user, vis)) continue
    const score = cosineSim(qvec, fromBlob(row.vector))
    if (score < MIN_SCORE) continue
    scored.push({ source_type: row.source_type, source_id: row.source_id, text: row.chunk_text, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return { hits: scored.slice(0, topK), used: true }
}
