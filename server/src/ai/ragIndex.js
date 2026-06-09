// RAG indexer: turns org data (tasks, meetings, transcript segments, chat
// messages) into embedding rows for semantic retrieval. Two ways in:
//   - backfillAll()    one-time / batch (also runnable: `npm run rag:index`)
//   - indexTask(id) etc. incremental hooks called when a row changes
// All incremental hooks are best-effort: they swallow errors and no-op when no
// embedding provider is configured, so they can be sprinkled into routes without
// risk of breaking the main request.
import { db } from '../db.js'
import { now } from '../util.js'
import { embedTexts, hasEmbeddings, hashText, toBlob, embedModel } from './embeddings.js'

const BATCH = 96 // inputs per embedding API call

// --- chunk builders: the text we actually embed for each source type ----------

function taskChunk(t) {
  const bits = [t.title]
  if (t.description && t.description !== t.title) bits.push(t.description)
  const meta = []
  if (t.assignee_name) meta.push(`owner: ${t.assignee_name}`)
  if (t.status) meta.push(`status: ${t.status}`)
  if (t.priority) meta.push(`priority: ${t.priority}`)
  if (t.due_date) meta.push(`due: ${t.due_date}`)
  if (t.project_name) meta.push(`project: ${t.project_name}`)
  if (meta.length) bits.push(`(${meta.join(', ')})`)
  return bits.join('. ')
}

function meetingChunk(m) {
  let summary = ''
  try {
    const s = m.summary_json ? JSON.parse(m.summary_json) : null
    if (s?.executive_summary) summary = s.executive_summary
    else if (Array.isArray(s?.action_items)) summary = s.action_items.join('; ')
  } catch { /* ignore bad JSON */ }
  return [`Meeting: ${m.title} (${m.meeting_date})`, summary].filter(Boolean).join('. ')
}

// --- generic upsert -----------------------------------------------------------

// items: [{ source_type, source_id, org_id, ref_user_id?, ref_convo_id?, text }]
// Embeds only items whose text changed since last index; upserts all touched rows.
// Returns { embedded, skipped }.
export async function indexItems(items) {
  if (!hasEmbeddings() || !items.length) return { embedded: 0, skipped: 0 }

  const existing = db.prepare('SELECT source_type, source_id, content_hash FROM embeddings')
  const seen = new Map()
  for (const r of existing.all()) seen.set(`${r.source_type}:${r.source_id}`, r.content_hash)

  const stale = items.filter((it) => {
    const text = (it.text || '').trim()
    if (!text) return false
    it.text = text
    it.hash = hashText(text)
    return seen.get(`${it.source_type}:${it.source_id}`) !== it.hash
  })
  if (!stale.length) return { embedded: 0, skipped: items.length }

  const model = embedModel()
  const upsert = db.prepare(`
    INSERT INTO embeddings (id, org_id, source_type, source_id, ref_user_id, ref_convo_id,
                            chunk_text, content_hash, dim, vector, model, updated_at)
    VALUES (@id, @org_id, @source_type, @source_id, @ref_user_id, @ref_convo_id,
            @chunk_text, @content_hash, @dim, @vector, @model, @updated_at)
    ON CONFLICT(source_type, source_id) DO UPDATE SET
      org_id=excluded.org_id, ref_user_id=excluded.ref_user_id, ref_convo_id=excluded.ref_convo_id,
      chunk_text=excluded.chunk_text, content_hash=excluded.content_hash, dim=excluded.dim,
      vector=excluded.vector, model=excluded.model, updated_at=excluded.updated_at
  `)

  let embedded = 0
  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = stale.slice(i, i + BATCH)
    const vecs = await embedTexts(batch.map((b) => b.text))
    const write = db.transaction((rows) => {
      rows.forEach((it, j) => {
        const vec = vecs[j]
        if (!vec) return
        upsert.run({
          id: `emb_${it.source_type}_${it.source_id}`,
          org_id: it.org_id,
          source_type: it.source_type,
          source_id: it.source_id,
          ref_user_id: it.ref_user_id || null,
          ref_convo_id: it.ref_convo_id || null,
          chunk_text: it.text,
          content_hash: it.hash,
          dim: vec.length,
          vector: toBlob(vec),
          model,
          updated_at: now(),
        })
        embedded++
      })
    })
    write(batch)
  }
  return { embedded, skipped: items.length - stale.length }
}

// --- collectors: pull rows -> item descriptors -------------------------------

function taskItems(where = '', params = []) {
  return db.prepare(`
    SELECT t.id, t.org_id, t.title, t.description, t.status, t.priority, t.due_date,
           t.assignee_id, u.name AS assignee_name, p.name AS project_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.parent_task_id IS NULL ${where}
  `).all(...params).map((t) => ({
    source_type: 'task', source_id: t.id, org_id: t.org_id,
    ref_user_id: t.assignee_id || null, text: taskChunk(t),
  }))
}

function meetingItems(where = '', params = []) {
  return db.prepare(`SELECT id, org_id, title, meeting_date, summary_json FROM meetings WHERE 1=1 ${where}`)
    .all(...params)
    .map((m) => ({ source_type: 'meeting', source_id: m.id, org_id: m.org_id, text: meetingChunk(m) }))
}

function segmentItems(where = '', params = []) {
  return db.prepare(`
    SELECT s.id, s.text, s.speaker, m.org_id, m.id AS meeting_id, m.title
    FROM transcript_segments s JOIN meetings m ON m.id = s.meeting_id
    WHERE length(s.text) > 0 ${where}
  `).all(...params).map((s) => ({
    source_type: 'segment', source_id: s.id, org_id: s.org_id,
    text: `${s.title}: ${s.speaker ? s.speaker + ': ' : ''}${s.text}`,
  }))
}

function chatItems(where = '', params = []) {
  return db.prepare(`
    SELECT id, org_id, conversation_id, body FROM chat_messages
    WHERE deleted_for_all = 0 AND body IS NOT NULL AND length(trim(body)) > 0 ${where}
  `).all(...params).map((c) => ({
    source_type: 'chat', source_id: c.id, org_id: c.org_id,
    ref_convo_id: c.conversation_id || null, text: c.body,
  }))
}

// --- public API ---------------------------------------------------------------

export async function backfillAll() {
  const items = [...taskItems(), ...meetingItems(), ...segmentItems(), ...chatItems()]
  return indexItems(items)
}

// Incremental hooks (call after the row is created/updated). Best-effort.
async function safeIndex(items) {
  try { if (hasEmbeddings()) await indexItems(items) } catch (e) { console.warn('[rag] index failed:', e.message) }
}
export const indexTask = (taskId) => safeIndex(taskItems('AND t.id = ?', [taskId]))
export const indexMeeting = (meetingId) =>
  safeIndex([...meetingItems('AND id = ?', [meetingId]), ...segmentItems('AND m.id = ?', [meetingId])])
export const indexChatMessage = (msgId) => safeIndex(chatItems('AND id = ?', [msgId]))

// Remove an embedding when its source row is deleted.
export function removeEmbedding(sourceType, sourceId) {
  try { db.prepare('DELETE FROM embeddings WHERE source_type=? AND source_id=?').run(sourceType, sourceId) }
  catch { /* best-effort */ }
}

// Remove all embeddings derived from a meeting (the meeting, its transcript
// segments, and tasks it produced) — call BEFORE the rows are wiped.
export function removeMeetingEmbeddings(meetingId) {
  try {
    db.prepare(`DELETE FROM embeddings WHERE
      (source_type='meeting' AND source_id=?)
      OR (source_type='segment' AND source_id IN (SELECT id FROM transcript_segments WHERE meeting_id=?))
      OR (source_type='task' AND source_id IN (SELECT id FROM tasks WHERE meeting_id=?))`)
      .run(meetingId, meetingId, meetingId)
  } catch { /* best-effort */ }
}
