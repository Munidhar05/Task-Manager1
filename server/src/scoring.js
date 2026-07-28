// Engagement scoring — pure math, no DB access.
//
// One point per action. That's the whole policy:
//
//   assign a task to someone  → +1 (to the assigner)
//   complete a task           → +1 (to the assignee who finished it)
//   comment on a task         → +1 (to the commenter, once per task)
//   change a task's status    → +1 (to whoever moved it)
//
// Priority is deliberately ignored — a Critical task and a Low one are worth the
// same point. Assign 10 tasks and you have 10 points; complete 5 and you have 5.
// The score is a running COUNT of work done, not a 0-100 rating, so there is no
// cap, no average and no weighting to reason about.
//
// Two anti-double-count rules are baked into the queries in performance.js:
//   · Commenting twice on the SAME task is one point, not two (points track tasks
//     engaged with, matching "comments on three tasks → 3 points").
//   · Moving a task to Done pays the completion point only — the status-change
//     point skips Done, so finishing a task is worth 1 point, not 2.

// Bump when the scoring POLICY changes. Nothing is persisted any more (points are
// counted live from tasks/task_comments/audit_logs), so this is just a marker for
// anyone comparing behaviour across deploys.
export const SCORING_VERSION = 'flat-points-v1'

// Every rule is worth the same single point. Kept as data (not a hard-coded 1) so
// the UI can render the rules and a future tweak is a one-line change here.
// `label` titles a row in the detail view; `short` is the compact form used in the
// "3 assigned · 2 completed" chips on a leaderboard card (pluralised by the client).
export const POINT_RULES = [
  { key: 'assigned', points: 1, label: 'Tasks assigned', short: 'assigned', hint: 'Gave a task to someone else' },
  { key: 'completed', points: 1, label: 'Tasks completed', short: 'completed', hint: 'Finished a task assigned to them' },
  { key: 'commented', points: 1, label: 'Tasks commented on', short: 'commented', hint: 'Counted once per task' },
  { key: 'status', points: 1, label: 'Status changes', short: 'status change', hint: 'Moved a task along (Done excluded — it pays as a completion)' },
]

export const RULE_KEYS = POINT_RULES.map((r) => r.key)

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
