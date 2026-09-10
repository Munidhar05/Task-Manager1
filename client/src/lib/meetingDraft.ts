// An unanalyzed meeting, kept on disk.
//
// A recorded meeting does not exist anywhere but this browser tab until
// "Analyze & extract tasks" posts it to the server. Everything before that — the
// whole transcript of a forty-minute conversation, the participants, the title —
// is React state and nothing else. A refresh, a phone call that gets Android to
// reclaim the WebView, or swiping the app out of recents takes all of it, and
// there is no way to get it back: the words were spoken once.
//
// This is the same problem [reviewDraft] solves one stage later, and it is solved
// the same way, for the same reason. localStorage rather than the server: a
// meeting is exactly when someone is holding a phone in a room with bad wifi, and
// a half-captured transcript should not be posted anywhere until its owner has
// read it and pressed the button.
//
// One draft per user, because a person records one meeting at a time.

const KEY = 'smarttask_meeting_draft'

// Long enough to survive a weekend, short enough that a transcript nobody ever
// went back to does not sit in storage forever.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

export interface MeetingDraft {
  title: string
  description: string
  participants: string[]
  speaker: string
  lang: string
  transcript: string
  seconds: number
  startedAt: number
  savedAt: number
}

const storeKey = (userId: string) => `${KEY}_${userId || 'anon'}`

// Falls back to ANY saved recording if this user's key has nothing.
//
// The key is per-user so a shared device cannot leak one person's meeting to the
// next. But that means a draft written while the user id was known, and read back
// a moment before it is known again, would look like no draft at all — and the
// only copy of a meeting is far too costly a thing to lose to a naming mismatch.
// So a miss on the exact key sweeps every draft key before giving up.
export function loadMeetingDraft(userId: string): MeetingDraft | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(storeKey(userId))
    if (!raw) {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith(KEY)) { raw = localStorage.getItem(k); break }
      }
    }
  } catch { return null } // storage off
  if (!raw) return null
  try {
    const d = JSON.parse(raw) as MeetingDraft
    // A draft with no transcript is an abandoned empty form, not a lost meeting.
    if (!d || typeof d.savedAt !== 'number' || !d.transcript?.trim()) return null
    if (d.savedAt < Date.now() - MAX_AGE_MS) return null
    return d
  } catch { return null } // corrupt — better to show nothing than to crash the recorder
}

// Returns whether the write actually landed. Swallowing the failure silently was
// wrong: storage being off or full looks identical to "my meeting vanished", and
// the person recording is the only one who can act on it — so the recorder says
// so out loud rather than letting them find out after the meeting is over.
export function saveMeetingDraft(userId: string, d: MeetingDraft): boolean {
  try {
    localStorage.setItem(storeKey(userId), JSON.stringify(d))
    return true
  } catch {
    return false
  }
}

// Clears this user's draft and any stray one the fallback above could resurrect,
// so discarding or analyzing really does mean gone.
export function clearMeetingDraft(userId: string) {
  try {
    localStorage.removeItem(storeKey(userId))
    const stray: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(KEY)) stray.push(k)
    }
    for (const k of stray) localStorage.removeItem(k)
  } catch { /* storage off */ }
}

// Roughly how much was said, for the "you have an unanalyzed meeting" card. Lines
// read better than characters here: a transcript is one line per utterance, so
// this is a count of things people actually said.
export function draftLineCount(d: MeetingDraft): number {
  return d.transcript.split('\n').filter((l) => l.trim()).length
}

export function draftDuration(d: MeetingDraft): string {
  const m = Math.floor(d.seconds / 60)
  if (m < 1) return `${d.seconds}s`
  return `${m} min`
}

export function draftAgo(savedAt: number): string {
  const mins = Math.round((Date.now() - savedAt) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
