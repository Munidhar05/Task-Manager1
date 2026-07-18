// Task categories (business units / brands). A task is auto-tagged with ONE of
// these based on its text, with the AI extractor able to suggest one from meeting
// context too (see the ai/ wrappers). Detection is hybrid: this deterministic
// keyword matcher runs on every task; the AI's suggestion is used only as a
// fallback when no keyword matches.
//
// ⇩⇩ EDIT ME ⇩⇩  Tune each category's `keywords` to your business. Keywords match
// on WHOLE WORDS (case-insensitive), so short aliases like "gs" won't fire inside
// "logs". Multi-word phrases match with flexible spacing ("global shopper" also
// matches "global  shopper"). Order matters: the FIRST category with a hit wins,
// so keep the more specific/!distinctive categories higher.

export const CATEGORIES = [
  {
    id: 'DCAL',
    label: 'DCAL',
    color: '#2f6fd0',
    keywords: ['dcal', 'd-cal', 'd cal'],
  },
  {
    id: '91GI',
    label: '91GI',
    color: '#8b5cf6',
    keywords: ['91gi', '91 gi', '91-gi'],
  },
  {
    id: 'Global Shopper',
    label: 'Global Shopper',
    color: '#0f9d6e',
    keywords: ['global shopper', 'globalshopper', 'global-shopper', 'gs'],
  },
  {
    id: 'Rice',
    label: 'Rice',
    color: '#d98a0b',
    keywords: ['rice', 'basmati', 'paddy', 'rice mill'],
  },
  {
    id: 'Taskmanager',
    label: 'Taskmanager',
    color: '#e2483a',
    keywords: ['taskmanager', 'task manager', 'smarttask', 'smart task', 'befach task', 'btm'],
  },
]

export const CATEGORY_LABELS = CATEGORIES.map((c) => c.label)
const byLabel = new Map(CATEGORIES.map((c) => [c.label.toLowerCase(), c]))

// Escape a keyword for use in a RegExp and let internal spaces match any run of
// whitespace, so phrase keywords survive odd spacing in transcripts.
function keywordRegex(kw) {
  const escaped = kw.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  // \b won't anchor when a keyword starts/ends with a non-word char (e.g. "d-cal"),
  // so guard both sides with "not a word char" lookarounds instead.
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i')
}

// Precompile: [{ label, regexes: [RegExp,...] }] in CATEGORIES order.
const COMPILED = CATEGORIES.map((c) => ({ label: c.label, regexes: c.keywords.map(keywordRegex) }))

// Detect a task's category from its free text (title + description + any quote).
// Returns the category label, or null when nothing matches. First match wins by
// CATEGORIES order.
export function detectCategory(...parts) {
  const text = parts.filter(Boolean).join(' \n ')
  if (!text.trim()) return null
  for (const c of COMPILED) {
    if (c.regexes.some((re) => re.test(text))) return c.label
  }
  return null
}

// Normalise an incoming category value to a known label, or null. Lets the API
// accept a user/AI-supplied category while rejecting anything off-list.
export function normalizeCategory(value) {
  if (!value) return null
  const hit = byLabel.get(String(value).trim().toLowerCase())
  return hit ? hit.label : null
}

// Resolve a task's category with the hybrid rule: an explicit/keyword hit wins,
// otherwise fall back to the AI's suggestion, otherwise null (Uncategorized).
export function resolveCategory({ text = '', explicit = null, aiSuggested = null } = {}) {
  return normalizeCategory(explicit) || detectCategory(text) || normalizeCategory(aiSuggested) || null
}
