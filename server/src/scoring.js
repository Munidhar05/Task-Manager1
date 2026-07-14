// Employee performance scoring — pure math, no DB access.
//
// Two layers:
//   1. A DAILY SCORE (0-100) for one employee on one calendar day, built from how
//      they handled their tasks that day (on-time, throughput, quality, engagement,
//      minus a penalty for overdue work sitting open).
//   2. An ALL-TIME RATING (0-1000, self-correcting) that is nudged up or down each
//      active day by that day's score vs a neutral baseline. Good days raise it,
//      bad days lower it; moves shrink near the 0/1000 bounds so it stays bounded
//      and stays comparable across employees regardless of tenure.
//
// Everything here is a pure function of its inputs so it can be tested in isolation
// and so a past day can be recomputed deterministically. The DB-facing service
// (performance.js) gathers the rows and feeds them in.

export const PRIORITY_WEIGHT = { Critical: 4, High: 3, Medium: 2, Low: 1 }
export const priorityWeight = (p) => PRIORITY_WEIGHT[p] || PRIORITY_WEIGHT.Medium

// --- Daily score component weights (sum to 100 when all are present) ----------
// Absent components (e.g. no due-dated task resolved that day) drop out and the
// remaining weights renormalise, so a missing signal never unfairly zeroes a day.
const W = { onTime: 40, throughput: 25, quality: 20, engagement: 15 }

// Throughput target: the weighted output that maxes out the throughput component.
// Expressed PER DAY. Team pace is ~1 task/day for an active employee, so ~1.5
// weighted/day (a single Medium-to-High task) caps it. Auto-calibrated by the
// service from the active-team median; this is the cold-start fallback.
export const DEFAULT_DAILY_TARGET = 1.5

// Overdue penalty: up to this many points come off the daily score for tasks that
// are past due and still open. Scales with priority weight and how late they are.
const MAX_PENALTY = 10
const LATE_RAMP_DAYS = 14 // days overdue at which the penalty ramp maxes out

// --- Rating (all-time) parameters --------------------------------------------
export const RATING_MIN = 0
export const RATING_MAX = 1000
export const RATING_START = 600 // everyone begins here (neutral, room to rise/fall)
const RATING_BASELINE = 60 // a daily score above this raises the rating, below lowers it
const RATING_K = 3 // base sensitivity; larger = the rating moves faster

// Clamp helper.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// Engagement sub-score (0..1) for a single day. Sparse by nature, so each channel
// is capped and they sum toward 1. Rewards showing up and collaborating without
// letting chatter dominate the overall score (engagement is only 15% anyway).
export function engagementScore({ meetingsAttended = 0, messagesSent = 0, commentsPosted = 0, tasksDelegated = 0 } = {}) {
  const meeting = meetingsAttended > 0 ? 0.5 : 0
  const chat = Math.min(0.3, messagesSent * 0.03)
  const comments = Math.min(0.2, commentsPosted * 0.05)
  const initiative = Math.min(0.2, tasksDelegated * 0.1)
  return Math.min(1, meeting + chat + comments + initiative)
}

// Penalty points (0..MAX_PENALTY) for a set of currently-overdue open tasks.
// Each contributes priorityWeight × howLate; the sum is capped so one rough
// stretch can't erase an entire day.
export function overduePenalty(overdueTasks = []) {
  let raw = 0
  for (const t of overdueTasks) {
    const late = clamp((t.daysLate || 0) / LATE_RAMP_DAYS, 0, 1)
    raw += priorityWeight(t.priority) * late
  }
  return Math.min(MAX_PENALTY, raw)
}

// Compute one employee's DAILY score (0-100) from that day's activity.
//
// input:
//   doneOnTime          — # tasks completed that day, on/before their due date
//   doneLate            — # tasks completed that day, after their due date
//   doneNoDue           — # tasks completed that day with no due date (throughput only)
//   weightedThroughput  — Σ priorityWeight over ALL tasks completed that day
//   resolved            — # tasks that reached a terminal state that day (done + reopened/rejected)
//   reopenedOrRejected  — # of those that were reopened/rejected (quality misses)
//   engagement          — 0..1 from engagementScore()
//   overdueTasks        — [{priority, daysLate}] open past-due tasks as of that day
//   dailyTarget         — weighted output that caps throughput (defaults to DEFAULT_DAILY_TARGET)
//
// Returns { score, breakdown } where breakdown holds each component's 0..1 rate,
// its point contribution, and whether it was present (for the UI "why" view).
export function dailyScore(input = {}) {
  const {
    doneOnTime = 0,
    doneLate = 0,
    weightedThroughput = 0,
    resolved = 0,
    reopenedOrRejected = 0,
    engagement = 0,
    overdueTasks = [],
    dailyTarget = DEFAULT_DAILY_TARGET,
  } = input

  const dueResolved = doneOnTime + doneLate // completions that HAD a due date
  const parts = []

  // On-time: only counts when at least one due-dated task was completed that day.
  if (dueResolved > 0) {
    const rate = doneOnTime / dueResolved
    parts.push({ key: 'onTime', weight: W.onTime, rate, present: true })
  }
  // Throughput: always present (0 when nothing was completed).
  const throughputRate = dailyTarget > 0 ? Math.min(1, weightedThroughput / dailyTarget) : 0
  parts.push({ key: 'throughput', weight: W.throughput, rate: throughputRate, present: true })
  // Quality: only when something reached a terminal state that day.
  if (resolved > 0) {
    const rate = 1 - reopenedOrRejected / resolved
    parts.push({ key: 'quality', weight: W.quality, rate: clamp(rate, 0, 1), present: true })
  }
  // Engagement: always present (0 when idle on all channels).
  parts.push({ key: 'engagement', weight: W.engagement, rate: clamp(engagement, 0, 1), present: true })

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0)
  const weighted = parts.reduce((s, p) => s + p.weight * p.rate, 0)
  const base = totalWeight > 0 ? (weighted / totalWeight) * 100 : 0

  const penalty = overduePenalty(overdueTasks)
  const score = clamp(base - penalty, 0, 100)

  // Point contribution of each component AFTER renormalisation, for display.
  const breakdown = {}
  for (const p of parts) breakdown[p.key] = { rate: p.rate, points: (p.weight / totalWeight) * p.rate * 100, present: p.present }
  breakdown.penalty = { points: -penalty, present: penalty > 0 }

  return { score: Math.round(score * 10) / 10, penalty, breakdown }
}

// Advance an all-time rating by one day's score. Moves toward RATING_MAX on good
// days and RATING_MIN on bad days, with the step shrinking as it approaches either
// bound (so it can't run away and a strong newcomer can still overtake a coasting
// veteran). Returns the new rating, clamped to [RATING_MIN, RATING_MAX].
export function advanceRating(prevRating, dayScore, { k = RATING_K, baseline = RATING_BASELINE } = {}) {
  const rating = clamp(prevRating ?? RATING_START, RATING_MIN, RATING_MAX)
  // Raw step, e.g. dayScore 100 vs baseline 60 → +4k; dayScore 0 → -6k.
  const rawStep = (k * (dayScore - baseline)) / 10
  const span = RATING_MAX - RATING_MIN
  // Headroom damping: ×2 so mid-range moves are ~full-strength, tapering near bounds.
  const damp = rawStep >= 0
    ? ((RATING_MAX - rating) / span) * 2
    : ((rating - RATING_MIN) / span) * 2
  return clamp(rating + rawStep * damp, RATING_MIN, RATING_MAX)
}
