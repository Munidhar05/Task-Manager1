import { useSyncExternalStore } from 'react'

// Where each finished call's write-up has got to — the server's 'call-analysis'
// events (routes/chat.js setAnalysis), held in one place for the three things
// that show it: the card that takes the call window's place when a call ends
// (CallAnalysisCard), the line in that chat's thread, and the Meetings page.
// CallCenter feeds it from its socket, which is open on every page; it also
// asks the server again on every (re)connect, so a reload in the middle of an
// analysis still shows it.

// 'reviewed': nothing left to review — the card has nothing to ask.
export type AnalysisStage = 'waiting' | 'analysing' | 'ready' | 'reviewed' | 'empty' | 'failed'

export interface CallAnalysis {
  callId: string
  conversationId: string
  conversationType: 'direct' | 'group'
  conversationName: string
  kind: 'audio' | 'video'
  joined: { id: string; name: string }[]
  endedAt: string
  stage: AnalysisStage
  at: string
  // ready
  meetingId?: string
  messageId?: string | null
  title?: string
  found?: number   // suggested tasks waiting for review
  owned?: number   // of those, how many already have a suggested owner
  assigned?: number // assigned from it so far, once a review has begun
  // Put up by this device at the moment it hung up, before the server has
  // heard (see CallCenter's hangUp). Anything the server says replaces it.
  provisional?: boolean
}

export const inProgress = (a: CallAnalysis) => a.stage === 'waiting' || a.stage === 'analysing'

let items = new Map<string, CallAnalysis>()
let snapshot: CallAnalysis[] = []
const listeners = new Set<() => void>()
const emit = () => {
  snapshot = [...items.values()].sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1))
  listeners.forEach((l) => l())
}

export function putAnalysis(a: CallAnalysis) {
  // A late copy of an earlier stage (a reconnect's list crossing a live event)
  // must not walk a finished analysis back to "analysing".
  const prev = items.get(a.callId)
  if (prev && (a.provisional ? !prev.provisional : prev.at > a.at)) return
  items = new Map(items).set(a.callId, a)
  emit()
}
export function replaceAnalyses(list: CallAnalysis[]) {
  const next = new Map<string, CallAnalysis>()
  for (const a of list) {
    const prev = items.get(a.callId)
    next.set(a.callId, prev && !prev.provisional && prev.at > a.at ? prev : a)
  }
  // This device's own word on a call the server has not announced yet.
  for (const [k, v] of items) if (v.provisional && !next.has(k)) next.set(k, v)
  items = next
  emit()
}
// The server never took it up — a group call that went on without me, or one
// with nothing to analyse. Only the provisional copy is dropped.
export function dropProvisional(callId: string) {
  if (!items.get(callId)?.provisional) return
  items = new Map(items)
  items.delete(callId)
  emit()
}
export function clearAnalyses() { items = new Map(); emit() }

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export function useCallAnalyses(): CallAnalysis[] {
  return useSyncExternalStore(subscribe, () => snapshot)
}

// "Hide" on the card. Remembered per stage group, so hiding the progress does
// not also hide the result: the moment it is ready is the moment the review
// is asked for, and that must show even if the waiting was waved away.
// Stored per device (a reload must not bring back a card already closed);
// storage that throws (private mode) just means it is remembered until reload.
const KEY = 'votask_call_analysis_hidden'
const phase = (a: CallAnalysis) => (inProgress(a) ? 'progress' : 'done')
let hidden: Set<string> = (() => {
  try { return new Set<string>(JSON.parse(localStorage.getItem(KEY) || '[]')) } catch { return new Set<string>() }
})()
export const isHidden = (a: CallAnalysis) => hidden.has(`${a.callId}:${phase(a)}`)
export function hideAnalysis(a: CallAnalysis) {
  hidden = new Set(hidden).add(`${a.callId}:${phase(a)}`)
  // Only the most recent few matter; the server forgets a call after 30 minutes.
  try { localStorage.setItem(KEY, JSON.stringify([...hidden].slice(-40))) } catch { /* not persisted */ }
  emit()
}

// The review of a call's meeting has been opened, from anywhere (the chat's
// card, the Meetings page): the card asking for it has done its job.
export function hideForMeeting(meetingId: string) {
  for (const a of items.values()) if (a.meetingId === meetingId && !isHidden(a)) hideAnalysis(a)
}

// "your call with Ravi", "the call in Sales" — said from the reader's side,
// so the person on the other end is never told they called themselves, and
// someone who was not on it is not told it was theirs.
export function callLabel(a: CallAnalysis, meId: string): string {
  if (a.conversationType === 'group') return `the ${a.kind} call in ${a.conversationName || 'the group'}`
  const mine = a.joined.some((p) => p.id === meId)
  const other = a.joined.filter((p) => p.id !== meId).map((p) => p.name)
  if (!mine) return `a ${a.kind} call${other.length ? ` between ${other.join(' and ')}` : ''}`
  return `your ${a.kind} call${other.length ? ` with ${other.join(', ')}` : ''}`
}
