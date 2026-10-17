// Task categories (business units / brands). A task is auto-tagged with ONE of
// these based on its text, with the AI extractor able to suggest one from meeting
// context too (see the ai/ wrappers). Detection is hybrid: this deterministic
// keyword matcher runs on every task; the AI's suggestion is used only as a
// fallback when no keyword matches.
//
// Two sources: the built-in list below, and whatever an org has added itself
// from the task form (the task_categories table, one row per org and name —
// see POST /users/meta/categories). A custom category has no keyword list of
// its own: its NAME is the keyword, so a task that says "furniture" lands in
// Furniture. The AI prompts still list only the built-ins; an org's own names
// reach a meeting's tasks through this keyword pass, not through the model.
//
// ⇩⇩ EDIT ME ⇩⇩  Tune each category's `keywords` to your business. Keywords match
// on WHOLE WORDS (case-insensitive), so short aliases like "gs" won't fire inside
// "logs". Multi-word phrases match with flexible spacing ("global shopper" also
// matches "global  shopper"). Order matters: the FIRST category with a hit wins,
// so keep the more specific/!distinctive categories higher.
import { db } from './db.js'

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

// The org's own categories, oldest first so the list reads in the order people
// added them. Read on every call rather than cached: a handful of rows, and a
// cache would need invalidating from the route that inserts them.
export function orgCategories(orgId) {
  if (!orgId) return []
  return db.prepare('SELECT id, name, color FROM task_categories WHERE org_id=? ORDER BY created_at, name').all(orgId)
}

// Detect a task's category from its free text (title + description + any quote).
// Returns the category label, or null when nothing matches. Built-ins first, in
// CATEGORIES order, then the org's own names; first match wins.
export function detectCategory(text, orgId = null) {
  if (!text || !text.trim()) return null
  for (const c of COMPILED) {
    if (c.regexes.some((re) => re.test(text))) return c.label
  }
  for (const c of orgCategories(orgId)) {
    if (keywordRegex(c.name).test(text)) return c.name
  }
  return null
}

// Normalise an incoming category value to a known label, or null. Lets the API
// accept a user/AI-supplied category while rejecting anything off-list — where
// "the list" is the built-ins plus this org's additions.
export function normalizeCategory(value, orgId = null) {
  if (!value) return null
  const key = String(value).trim().toLowerCase()
  const hit = byLabel.get(key)
  if (hit) return hit.label
  const own = orgCategories(orgId).find((c) => c.name.toLowerCase() === key)
  return own ? own.name : null
}

// Resolve a task's category with the hybrid rule: an explicit/keyword hit wins,
// otherwise fall back to the AI's suggestion, otherwise null (Uncategorized).
export function resolveCategory({ text = '', explicit = null, aiSuggested = null, orgId = null } = {}) {
  return normalizeCategory(explicit, orgId) || detectCategory(text, orgId) || normalizeCategory(aiSuggested, orgId) || null
}
