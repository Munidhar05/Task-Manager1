// Meeting lookups for the voice assistant.
//
// Titles repeat a lot in practice ("Marketing Meeting" x4), so resolution matches
// on title AND date, and asks which one when it's still ambiguous rather than
// guessing. Summaries are read straight from the stored summary_json — the model
// never re-invents what a meeting decided.
import { db } from '../db.js'

const rows = (user) => db.prepare(
  `SELECT id, title, meeting_date, status, summary_json
     FROM meetings WHERE org_id = ? ORDER BY meeting_date DESC, created_at DESC`,
).all(user.org_id)

export function listMeetings(user) {
  const all = rows(user)
  if (!all.length) return { meetings: [], say: 'There are no meetings yet.' }
  const latest = all[0]
  return {
    meetings: all,
    say: `There ${all.length === 1 ? 'is 1 meeting' : `are ${all.length} meetings`}. The most recent is "${latest.title}" on ${latest.meeting_date}.`,
  }
}

const norm = (s) => String(s || '').toLowerCase().trim()

// Resolve a spoken reference to one meeting.
// -> { meeting } | { candidates } | { none:true }
export function resolveMeeting(user, { title, date, latest } = {}) {
  const all = rows(user)
  if (!all.length) return { none: true }
  if (latest || (!title && !date)) return { meeting: all[0] }

  let hits = all
  if (date) hits = hits.filter((m) => m.meeting_date === date)
  if (title) {
    const t = norm(title)
    const byTitle = hits.filter((m) => norm(m.title).includes(t) || t.includes(norm(m.title)))
    if (byTitle.length) hits = byTitle
  }
  if (!hits.length) return { none: true }
  if (hits.length === 1) return { meeting: hits[0] }
  return { candidates: hits.slice(0, 4) }
}

const parseSummary = (m) => { try { return JSON.parse(m.summary_json || '{}') } catch { return {} } }

// A short spoken recap: the executive summary plus what came out of it.
export function meetingSummary(meeting) {
  if (meeting.status !== 'processed') {
    return { say: `"${meeting.title}" from ${meeting.meeting_date} is still ${meeting.status}. I'll have a summary once it finishes.` }
  }
  const s = parseSummary(meeting)
  const head = String(s.executive_summary || '').trim()
  const decisions = (s.key_decisions || []).length
  const actions = (s.action_items || []).length
  const tail = []
  if (decisions) tail.push(`${decisions} decision${decisions === 1 ? '' : 's'}`)
  if (actions) tail.push(`${actions} action item${actions === 1 ? '' : 's'}`)

  const openTasks = db.prepare(
    `SELECT COUNT(*) c FROM tasks WHERE meeting_id=? AND status!='Done'`,
  ).get(meeting.id).c

  let say = head || `"${meeting.title}" on ${meeting.meeting_date}.`
  if (tail.length) say += ` It produced ${tail.join(' and ')}.`
  if (openTasks) say += ` ${openTasks} task${openTasks === 1 ? ' is' : 's are'} still open from it.`
  return { say, summary: s }
}

export const askWhichMeeting = (candidates) =>
  `I found ${candidates.length} meetings matching that: ${candidates.map((m) => `"${m.title}" on ${m.meeting_date}`).join(', ')}. Which one?`
