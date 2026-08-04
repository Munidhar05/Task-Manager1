// Engagement scoring — pure math, no DB access.
//
// A fixed number of points per action. That's the whole policy:
//
//   assign a task to someone  → +5  (to the assigner)
//   complete a task           → +10 (to the assignee who finished it)
//   comment on a task         → +1  (to the commenter, once per task)
//   change a task's status    → +1  (to whoever moved it)
//
// Finishing work is worth the most, handing it out next, and chatter least.
// Priority is deliberately ignored — a Critical task and a Low one are worth the
// same. Complete 10 tasks and you have 100 points. The score is a running TALLY
// of work done, not a 0-100 rating, so there is no cap and no average.
//
// Two anti-double-count rules are baked into the queries in performance.js:
//   · Commenting twice on the SAME task is one point, not two (points track tasks
//     engaged with, matching "comments on three tasks → 3 points").
//   · Moving a task to Done pays the completion point only — the status-change
//     point skips Done, so finishing a task is worth 1 point, not 2.

// Bump when the scoring POLICY changes. Nothing is persisted any more (points are
// counted live from tasks/task_comments/audit_logs), so this is just a marker for
// anyone comparing behaviour across deploys.
export const SCORING_VERSION = 'weighted-points-v1'

// What each action pays. Kept as data so the UI can render the rules and a future
// tweak is a one-line change here — nothing else hard-codes a per-action value.
// `label` titles a row in the detail view; `short` is the compact form used in the
// "3 assigned · 2 completed" chips on a leaderboard card (pluralised by the client).
export const POINT_RULES = [
  { key: 'assigned', points: 5, label: 'Tasks assigned', short: 'assigned', hint: 'Gave a task to someone else' },
  { key: 'completed', points: 10, label: 'Tasks completed', short: 'completed', hint: 'Finished a task assigned to them' },
  { key: 'commented', points: 1, label: 'Tasks commented on', short: 'commented', hint: 'Counted once per task' },
  { key: 'status', points: 1, label: 'Status changes', short: 'status change', hint: 'Moved a task along (Done excluded — it pays as a completion)' },
]

export const RULE_KEYS = POINT_RULES.map((r) => r.key)

// key → points, for callers that hold raw counts (the per-day chart).
export const RULE_POINTS = Object.fromEntries(POINT_RULES.map((r) => [r.key, r.points]))

// counts — { assigned, completed, commented, status } of raw action counts.
// Returns { points, breakdown } where breakdown[key] = { count, points, label }.
export function scoreCounts(counts = {}) {
  const breakdown = {}
  let points = 0
  for (const rule of POINT_RULES) {
    const count = counts[rule.key] || 0
    const earned = count * rule.points
    breakdown[rule.key] = { count, points: earned, label: rule.label, per: rule.points }
    points += earned
  }
  return { points, breakdown }
}

// The rules as an ordered list, so the UI renders labels without re-deriving policy.
export function pointRules() {
  return POINT_RULES.map((r) => ({ key: r.key, label: r.label, short: r.short, hint: r.hint, points: r.points }))
}
