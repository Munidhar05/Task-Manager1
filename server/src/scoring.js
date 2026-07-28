// Engagement scoring — pure math, no DB access.
//
// One idea, stated once: a person's day is 100 points, split into fixed SECTIONS
// that reflect their ROLE's job. You earn a section's points by doing that kind of
// work, weighted by task priority, until the section's budget is full. Sum the
// filled sections → the day's score (0-100). There are no negatives and nothing
// can exceed 100, because the section budgets sum to exactly 100 and each is
// individually capped.
//
//   Employee (execution):   complete 35 · comment 25 · status 20 · delegate 20
//   Manager  (orchestration): review 30 · assign 25 · comment+status 20 ·
//                             meetings 15 · complete-own 10
//
// Per-task points are priority-weighted so difficulty matters, not raw count:
// one well-handled Critical task nearly fills a section on its own, so a diligent
// person given few tasks still scores well (the whole reason this replaced the old
// rate-average engine, which quietly rewarded doing less).
//
// Everything here is a pure function of its inputs, so a past day recomputes
// deterministically. performance.js gathers the rows and feeds them in.

// Bump when the scoring POLICY changes in a way that makes stored days stale.
// performance.js compares this against a stored marker and rebuilds history when
// they differ, so a deploy re-scores cleanly instead of mixing old and new maths.
export const SCORING_VERSION = 'sections-v1'

export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']
// Fallback for a task whose priority is missing/unknown (e.g. deleted task joined
// from the audit log) — treated as Medium, the product's own default.
const norm = (p) => (PRIORITIES.includes(p) ? p : 'Medium')

// Per-priority point tables. A section is either PRIORITY-weighted (an object of
// per-priority points) or FLAT (a single number per event, e.g. meetings).
const P = (crit, high, med, low) => ({ Critical: crit, High: high, Medium: med, Low: low })

// role → section → { cap, points|flat, label }. The caps sum to 100 per role.
export const RUBRICS = {
  employee: {
    complete: { cap: 35, points: P(12, 10, 8, 5), label: 'Completing tasks' },
    comment: { cap: 25, points: P(8, 6, 5, 3), label: 'Comments' },
    status: { cap: 20, points: P(8, 6, 5, 3), label: 'Status updates' },
    delegate: { cap: 20, points: P(5, 4, 3, 2), label: 'Delegating' },
  },
  manager: {
    review: { cap: 30, points: P(10, 8, 6, 5), label: 'Reviewing / approving' },
    assign: { cap: 25, points: P(5, 4, 3, 2), label: 'Assigning tasks' },
    commstatus: { cap: 20, points: P(5, 4, 3, 2), label: 'Comments & status' },
    meetings: { cap: 15, flat: 5, label: 'Running meetings' },
    complete: { cap: 10, points: P(10, 8, 6, 5), label: 'Completing own tasks' },
  },
}
// Admins are scored on the manager rubric (an admin is the org's manager here).
export const rubricForRole = (role) => (role === 'employee' ? RUBRICS.employee : RUBRICS.manager)

// Which raw contribution feeds each section, per role. A section may draw from
// more than one contribution stream (manager's comment+status is one section fed
// by both). Contribution streams are named the same across roles so performance.js
// can gather once and route here:
//   completions, firstComments, statusChanges, delegations, approvals, meetings
export const SECTION_SOURCES = {
  employee: {
    complete: ['completions'],
    comment: ['firstComments'],
    status: ['statusChanges'],
    delegate: ['delegations'],
  },
  manager: {
    review: ['approvals'],
    assign: ['delegations'],
    commstatus: ['firstComments', 'statusChanges'],
    meetings: ['meetings'],
    complete: ['completions'],
  },
}

// Value of one contribution item in a given section.
function itemPoints(section, item) {
  if (section.flat != null) return section.flat // flat sections ignore priority
  return section.points[norm(item)]
}

// Score one day for one user.
//
//   role          — 'employee' | 'manager' | 'admin'
//   contributions — { completions:[priority,…], firstComments:[…], statusChanges:[…],
//                     delegations:[…], approvals:[…], meetings:<count> }
//                   Priority-weighted streams are arrays of priority strings; the
//                   flat stream (meetings) is a count.
//
// Returns { score, breakdown } where breakdown[section] = { raw, capped, cap }
// for the UI "why" view. score = Σ capped, already ≤ 100.
export function dailyScore(role, contributions = {}) {
  const rubric = rubricForRole(role)
  const sources = role === 'employee' ? SECTION_SOURCES.employee : SECTION_SOURCES.manager
  const breakdown = {}
  let score = 0
  for (const [key, section] of Object.entries(rubric)) {
    let raw = 0
    for (const streamName of sources[key]) {
      const stream = contributions[streamName]
      if (stream == null) continue
      if (section.flat != null) {
        raw += (typeof stream === 'number' ? stream : stream.length) * section.flat
      } else {
        for (const item of stream) raw += itemPoints(section, item)
      }
    }
    const capped = Math.min(section.cap, raw)
    breakdown[key] = { raw: Math.round(raw * 10) / 10, capped: Math.round(capped * 10) / 10, cap: section.cap, label: section.label }
    score += capped
  }
  return { score: Math.round(Math.min(100, score) * 10) / 10, breakdown }
}

// Sections of a role's rubric as an ordered list, for the UI to render labels/caps
// without re-deriving them.
export function rubricSections(role) {
  return Object.entries(rubricForRole(role)).map(([key, s]) => ({ key, label: s.label, cap: s.cap }))
}
