// Who the microphone is currently being spoken INTO.
//
// Two parts of this app listen to the same physical microphone, and until this
// module existed neither knew the other was there: the voice assistant (the
// wake-word recogniser plus its per-turn recorder) and the live meeting recorder
// on the Meetings page. Both are correct on their own; together they produce a
// bug with no obvious owner. Saying "hey VoTask, pause the meeting" would pause
// the meeting AND be faithfully written into its transcript — the instruction to
// stop recording became part of the recording — followed by the assistant's own
// spoken reply, picked up off the speaker on its way back in.
//
// The fix is NOT to fight over the device. Both engines can hold the mic (on
// Android they merely degrade each other), and tearing the meeting's recogniser
// down for the length of a command would lose a second of genuine meeting either
// side of it. So the arbitration happens over the TRANSCRIPT instead: the meeting
// keeps capturing and discards whatever arrives while the user is addressing the
// agent. That is the honest semantic — speech aimed at the assistant was never
// part of the meeting.
//
// The tail is as important as the flag. Two things outlive the turn by a moment:
// text-to-speech is still coming out of the speaker and back in through the mic,
// and a recogniser keeps emitting finals for audio it buffered earlier. Reopening
// the gate the instant the assistant goes idle lets both of those through.
const TAIL_MS = 1200

let active = false
let releasedAt = 0
const listeners = new Set<(active: boolean) => void>()

// Called by the conversation loop as its state changes. Idempotent: it is driven
// from a React effect that re-runs on unrelated renders.
export function setAgentTurn(next: boolean): void {
  if (next === active) return
  active = next
  if (!next) releasedAt = Date.now()
  for (const fn of [...listeners]) {
    try { fn(next) } catch (err) { console.error('[agentTurn] listener threw', err) }
  }
}

// True while the user is engaged with the assistant, and briefly after.
export const agentHasMic = (): boolean => active || Date.now() - releasedAt < TAIL_MS

// True if the agent held the mic at any point since `ts`.
//
// Needed because one capture mode batches: the meeting's server-transcription
// path records 12-second segments and uploads them whole. A segment can't be
// trimmed — it is an opaque webm blob — so the only safe test is whether the
// command fell anywhere inside the window, and the only safe action is to drop
// the segment entirely.
export const agentHadMicSince = (ts: number): boolean => active || releasedAt + TAIL_MS > ts

// Subscribe to transitions. Used for UI that has to explain the silence to the
// user; anything making a keep/discard decision should call agentHasMic() at the
// moment of the decision instead, since the tail is time-based and a cached
// boolean would miss it.
export function onAgentTurn(fn: (active: boolean) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
