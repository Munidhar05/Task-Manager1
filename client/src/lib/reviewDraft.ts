// Reviewing a meeting is the longest-lived piece of unsaved work in this app. A
// long meeting yields twenty-odd suggestions, and a manager fixes owners,
// deadlines and wording across all of them before assigning any — minutes of
// work that until now lived only in React state. Android reclaims a
// backgrounded WebView whenever it likes (a phone call, a swipe out of
// recents), and iOS is no kinder, so that work went with it and the review
// started from scratch.
//
// The suggestions themselves were never actually lost: the server keeps them as
// `pending` until somebody acts on them. What was lost is the *edits*, and any
// sign that a review was underway at all — a cold start lands on the dashboard,
// which said nothing about it. Both of those go on disk here.
//
// localStorage rather than the server, deliberately. The interruption this
// exists for is usually a phone call, which is exactly when the network is
// least reliable; and a half-typed title has no business showing up in anyone
// else's review screen before its author has decided it says what they meant.

const KEY = 'smarttask_review_drafts'

// Drafts describe server rows that someone else may since have assigned or
// deleted, so keeping them forever would resurrect text that no longer applies
// to anything. Two weeks is well past the point where a meeting review is still
// going to be finished.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

// The five fields the review screen lets a manager change. Stored as plain
// strings ('' for empty) so a diff against the server row is one === per field
// and never has to reason about null vs undefined vs ''.
export interface ReviewEdit {
  title: string
  description: string
  suggested_assignee_id: string
  priority: string
  due_date: string
}

export interface ReviewDraft {
  meetingId: string
  meetingTitle: string
  savedAt: number
  // Keyed by suggestion id, and holding ONLY rows the manager actually changed —
  // so an empty map means "opened the screen, touched nothing", which must not
  // count as an unfinished review.
  edits: Record<string, ReviewEdit>
  // The half-typed "task the AI missed" row, which isn't a suggestion yet.
  newTask: ReviewEdit | null
}

type Store = Record<string, ReviewDraft> // meetingId → draft

// One key per user: the dashboard can then list unfinished reviews without a
// network call, and signing in as somebody else on a shared phone can't show
// them the previous manager's half-written tasks.
const storeKey = (userId: string) => `${KEY}_${userId || 'anon'}`

function readStore(userId: string): Store {
  let raw: string | null = null
  try { raw = localStorage.getItem(storeKey(userId)) } catch { return {} } // storage off
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const cutoff = Date.now() - MAX_AGE_MS
    const fresh: Store = {}
    for (const [mid, d] of Object.entries(parsed as Store)) {
      if (d && typeof d.savedAt === 'number' && d.savedAt > cutoff) fresh[mid] = d
    }
    return fresh
  } catch { return {} } // corrupt entry — losing the draft beats breaking the screen
}

function writeStore(userId: string, store: Store) {
  try {
    if (Object.keys(store).length) localStorage.setItem(storeKey(userId), JSON.stringify(store))
    else localStorage.removeItem(storeKey(userId))
  } catch { /* storage off or over quota — the review still works, it just won't survive a kill */ }
}

export function loadReviewDraft(userId: string, meetingId: string): ReviewDraft | null {
  return readStore(userId)[meetingId] || null
}

export function saveReviewDraft(userId: string, draft: ReviewDraft) {
  const store = readStore(userId)
  store[draft.meetingId] = draft
  writeStore(userId, store)
}

export function clearReviewDraft(userId: string, meetingId: string) {
  const store = readStore(userId)
  if (!(meetingId in store)) return
  delete store[meetingId]
  writeStore(userId, store)
}

// Newest first — the resume card offers the review you were most recently in.
export function listReviewDrafts(userId: string): ReviewDraft[] {
  return Object.values(readStore(userId)).sort((a, b) => b.savedAt - a.savedAt)
}

// Coarse on purpose: this appears in a banner whose job is "you were here
// recently", not to be a clock.
export function draftAge(savedAt: number): string {
  const mins = Math.round((Date.now() - savedAt) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
