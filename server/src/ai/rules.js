// Offline, rule-based multilingual meeting analyzer.
// Handles English + romanized/script Hindi + Telugu and code-mixed lines.
// This is the zero-dependency fallback when no ANTHROPIC_API_KEY is configured.
import { parseDueDate } from './dates.js'

// --- language signal lexicons -------------------------------------------------

// Verb/marker cues that indicate an action item / assignment.
const ACTION_CUES = [
  // English
  'complete', 'finish', 'prepare', 'send', 'fix', 'deploy', 'review', 'create',
  'update', 'make', 'build', 'write', 'schedule', 'ensure', 'check', 'share',
  'submit', 'resolve', 'handle', 'test', 'document', 'set up', 'setup', 'integrate',
  'add', 'assign', 'prioritize', 'include', 'conduct', 'begin', 'start', 'research',
  'notify', 'analyze', 'finalize', 'target', 'implement', 'provide', 'enable',
  'convert', 'identify', 'add to', 'work on', 'ready by', 'ready cheyyandi',
  // Hindi (romanized)
  'karo', 'kar do', 'kar dena', 'banao', 'bhejo', 'bhej do', 'taiyaar', 'tayar',
  'dekh lo', 'likho', 'theek karo', 'complete karo', 'ready karo',
  // Hindi (script)
  'करो', 'बनाओ', 'भेजो', 'तैयार', 'देखो', 'लिखो',
  // Telugu (romanized)
  'cheyyi', 'cheyyandi', 'cheyandi', 'chey', 'pampu', 'pampandi', 'pampincu',
  'ready cheyyandi', 'ready cheyyi', 'complete cheyyi', 'chudandi', 'chudu',
  'raasi', 'set cheyyi', 'fix cheyyi', 'finish cheyyi',
  // Telugu (script)
  'చేయండి', 'చేయి', 'పంపండి', 'రెడీ', 'చూడండి', 'రాయండి',
]

// First-person commitment cues => assignee is the speaker.
const COMMITMENT_CUES = [
  'i will', "i'll", 'i can', 'i am going to', 'let me', 'i shall',
  'main karunga', 'main kar dunga', 'mai karunga', 'main bhej dunga',
  'nenu chestanu', 'nenu chesta', 'nenu pampistanu', 'nenu chuskuntanu',
  'నేను చేస్తాను', 'मैं करूंगा',
]

const PRIORITY_RULES = [
  { p: 'Critical', cues: ['production issue', 'prod down', 'production down', 'critical', 'p0', 'showstopper', 'venatane', 'immediately', 'turant', 'abhi ', 'right now', 'వెంటనే', 'तुरंत'] },
  { p: 'High', cues: ['urgent', 'asap', 'before release', 'before deployment', 'before client demo', 'high priority', 'today', 'eod', 'end of day', 'jaldi', 'twaraga', 'fast', 'జల్ది', 'త్వరగా'] },
  { p: 'Low', cues: ['future', 'later', 'enhancement', 'nice to have', 'whenever', 'no rush', 'baad mein', 'tarvata', 'తర్వాత', 'बाद में', 'optional'] },
]

const DECISION_CUES = ['we decided', 'decision is', 'final', 'let us go with', "let's go with", 'finalize', 'finalized', 'decide chesam', 'tay kiya', 'फैसला', 'నిర్ణయించాం']
const BLOCKER_CUES = ['blocked', 'blocker', 'stuck', 'issue', 'problem', 'not working', 'cannot', "can't", 'depend', 'waiting on', 'atpati', 'problem undi', 'समस्या', 'సమస్య']
const RISK_CUES = ['risk', 'might delay', 'may slip', 'concern', 'worried', 'tight deadline', 'could miss', 'delay avutundi', 'late ho sakta']
const FOLLOWUP_CUES = ['follow up', 'follow-up', 'next meeting', 'discuss later', 'revisit', 'tomorrow we discuss', 'malli matladdam', 'फिर बात']

// Role/title words that may appear alongside a person's name in a speaker label,
// e.g. "Manager (Rahul):" or "Priya (Business Analyst):". Used to pick the human name.
const ROLE_WORDS = [
  'manager', 'lead', 'team lead', 'analyst', 'business analyst', 'developer', 'dev',
  'frontend developer', 'backend developer', 'frontend', 'backend', 'full stack',
  'engineer', 'qa engineer', 'qa', 'ai engineer', 'ml engineer', 'designer', 'tester',
  'pm', 'product manager', 'project manager', 'scrum master', 'architect', 'intern',
  'cto', 'ceo', 'director', 'owner', 'stakeholder', 'consultant',
]

// First-person PAST-tense / completion reports — these are status updates, NOT tasks.
const DONE_VERBS = ['completed', 'finished', 'prepared', 'created', 'made', 'sent', 'wrote',
  'written', 'built', 'did', 'done', 'documented', 'shared', 'submitted', 'fixed', 'tested',
  'reviewed', 'set up', 'setup', 'deployed', 'resolved', 'integrated']

// Forward-looking modals that mark a real (future) action item even if it mentions completion.
const FUTURE_CUES = ['will', "i'll", 'shall', 'going to', 'need to', 'needs to', 'should',
  'must', 'have to', 'has to', "let's", 'let us', 'plan to', 'target', 'by friday', 'by monday',
  'by tuesday', 'by wednesday', 'by thursday', 'by saturday', 'by sunday', 'by tomorrow',
  'by eod', 'next week', 'ready by', 'should be ready', 'will be ready', 'can begin', 'can start']

// Greetings / pleasantries / meeting-procedural filler — never action items.
const CASUAL_RE = /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening|night)|namaste|namaskaram|namaskaaram|thanks?|thank\s+you|welcome|cheers|great\s+work|well\s+done|nice\s+work|let'?s\s+(?:start|begin|get\s+started|kick\s*off)|good\s+to\s+see|how\s+are\s+you)\b/i

// Map a qualitative ownership signal to a numeric confidence (0-100) + reasoning.
function ownershipScore(kind) {
  switch (kind) {
    case 'vocative': return { confidence: 90, reasoning: 'Directly addressed by name in the meeting.' }
    case 'self': return { confidence: 85, reasoning: 'Committed to doing the task themselves.' }
    case 'matched': return { confidence: 80, reasoning: 'Name matched a meeting participant.' }
    case 'low': return { confidence: 40, reasoning: 'Mentioned name did not match a known participant.' }
    default: return { confidence: 25, reasoning: 'No clear owner stated — needs manager confirmation.' }
  }
}

// --- helpers ------------------------------------------------------------------

function detectLanguages(text) {
  const langs = new Set()
  if (/[a-zA-Z]/.test(text)) langs.add('en')
  if (/[ఀ-౿]/.test(text)) langs.add('te') // Telugu script
  if (/[ऀ-ॿ]/.test(text)) langs.add('hi') // Devanagari
  // romanized Hindi/Telugu heuristics
  const lower = text.toLowerCase()
  if (/\b(karo|kar do|jaldi|hai|kal|aaj|theek|nahi)\b/.test(lower)) langs.add('hi')
  if (/\b(cheyyandi|cheyyi|repu|eroju|kavali|undi|chesta|chudandi)\b/.test(lower)) langs.add('te')
  return [...langs]
}

function containsAny(haystack, cues) {
  const h = haystack.toLowerCase()
  return cues.find((c) => h.includes(c.toLowerCase()))
}

function detectPriority(text) {
  for (const rule of PRIORITY_RULES) {
    if (containsAny(text, rule.cues)) return rule.p
  }
  return 'Medium'
}

function isRoleWord(s) {
  const x = (s || '').toLowerCase().trim()
  return ROLE_WORDS.some((r) => x === r || x.includes(r))
}

// From a speaker label, extract the human name, dropping any role.
// "Manager (Rahul)" -> "Rahul"  |  "Priya (Business Analyst)" -> "Priya"  |  "Rahul" -> "Rahul"
function personFromLabel(label) {
  const paren = label.match(/\(([^)]*)\)/)
  const outside = label.replace(/\([^)]*\)/, '').trim()
  const inside = paren ? paren[1].trim() : ''
  if (!inside) return outside || label.trim()
  if (isRoleWord(outside) && !isRoleWord(inside)) return inside
  if (!isRoleWord(outside) && isRoleWord(inside)) return outside
  return outside || inside
}

// Parse "Speaker: text" lines into ordered segments. Speaker may carry a role label.
export function parseSegments(transcript) {
  const lines = transcript.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const segments = []
  let seq = 0
  for (const line of lines) {
    // Allow parentheses in the speaker label: "Name (Role):" or "Role (Name):".
    const m = line.match(/^([A-Za-z][A-Za-z0-9 .'()\-]{0,50}?)\s*:\s*(.+)$/)
    if (m) {
      const speaker = personFromLabel(m[1].trim()) || 'Unknown'
      segments.push({ seq: seq++, speaker, text: m[2].trim(), language: detectLanguages(m[2]).join('+') || 'en' })
    } else if (segments.length) {
      // continuation of previous speaker
      segments[segments.length - 1].text += ' ' + line
    } else {
      segments.push({ seq: seq++, speaker: 'Unknown', text: line, language: detectLanguages(line).join('+') || 'en' })
    }
  }
  return segments
}

function splitSentences(text) {
  return text.split(/(?<=[.!?।])\s+|\n+/).map((s) => s.trim()).filter(Boolean)
}

// Try to find a person being addressed at the start of a sentence: "Munidhar, ..."
function detectVocative(sentence, knownNames) {
  const m = sentence.match(/^([A-Za-zऀ-ॿఀ-౿][\wऀ-ॿఀ-౿]{1,30})[,:]/)
  if (m) {
    const candidate = m[1].trim()
    // accept if it looks like a name (matches a known participant, else still plausible)
    const known = knownNames.find((n) => n.toLowerCase() === candidate.toLowerCase())
    return known || candidate
  }
  // else search for a known name anywhere
  for (const n of knownNames) {
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (re.test(sentence)) return n
  }
  return null
}

// Leading conversational filler to strip so titles read as imperative action items.
const TITLE_PREFIXES = /^(?:i will|i'll|i shall|i can|i am going to|i'm going to|i recommend|i think we should|we need to|we should|we will|we have to|let us|let's|please|also|so|now|then|kindly|i would|i'd)\s+/i

function cleanTitle(sentence, vocative) {
  let s = sentence
  if (vocative) s = s.replace(new RegExp(`^${vocative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,:]\\s*`, 'i'), '')
  // Strip leading filler (may stack, e.g. "So I will…").
  for (let i = 0; i < 3 && TITLE_PREFIXES.test(s); i++) s = s.replace(TITLE_PREFIXES, '')
  s = s.replace(/\s+/g, ' ').trim().replace(/[.!?।]+$/, '')
  if (s.length > 0) s = s[0].toUpperCase() + s.slice(1)
  if (s.length > 80) s = s.slice(0, 77).replace(/\s+\S*$/, '') + '…'
  return s || sentence.slice(0, 60)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Find the earliest-occurring known participant in `text`, matched on first name.
function findAssigneeIn(text, knownNames) {
  let best = null, bestIdx = Infinity
  for (const n of knownNames) {
    const first = (n.split(' ')[0] || n)
    const m = text.match(new RegExp(`\\b${escapeRe(first)}\\b`, 'i'))
    if (m && m.index < bestIdx) { best = n; bestIdx = m.index }
  }
  return best
}

// Turn one assignment clause into a clean task title by stripping the
// "assign [the] [task] to <name>" directive and the assignee's name.
function clauseToTitle(text, assignee) {
  let s = text.replace(/^\s*(?:please\s+)?assign(?:\s+the)?(?:\s+task)?(?:\s+to)?\s*/i, '')
  if (assignee) {
    const first = escapeRe(assignee.split(' ')[0] || assignee)
    s = s.replace(new RegExp(`\\bto\\s+${first}\\b`, 'i'), ' ').replace(new RegExp(`\\b${first}\\b`, 'i'), ' ')
  }
  // Drop a trailing connector left by the split (", ", " and ", "; ").
  s = s.replace(/[\s,;]+(?:and|aur|mariyu|మరియు)?\s*$/i, '').trim()
  return cleanTitle(s, null)
}

// Split a sentence that contains 2+ explicit "assign ... to <name>" directives
// into one clause per assignee. Returns [{ assignee, title, quote }] or null when
// it's a single (or no) assignment — in which case the caller handles it normally.
function splitMultiAssignment(sentence, knownNames) {
  const re = /\bassign(?:\s+the)?(?:\s+task)?\s+to\s+/gi
  const anchors = []
  let m
  while ((m = re.exec(sentence)) !== null) anchors.push(m.index)
  if (anchors.length < 2) return null
  const clauses = []
  for (let i = 0; i < anchors.length; i++) {
    const text = sentence.slice(anchors[i], i + 1 < anchors.length ? anchors[i + 1] : sentence.length).trim()
    const assignee = findAssigneeIn(text, knownNames)
    if (assignee) clauses.push({ assignee, text })
  }
  if (new Set(clauses.map((c) => c.assignee)).size < 2) return null
  return clauses.map((c) => ({ assignee: c.assignee, title: clauseToTitle(c.text, c.assignee), quote: c.text }))
}

// --- main analysis ------------------------------------------------------------

export function analyzeTranscript(transcript, opts = {}) {
  const refDate = opts.meetingDate || new Date().toISOString().slice(0, 10)
  const knownNames = opts.knownNames || []
  const segments = parseSegments(transcript)

  // Build the full participant name set (speakers + known names).
  const participants = new Set(knownNames)
  segments.forEach((s) => { if (s.speaker && s.speaker !== 'Unknown') participants.add(s.speaker) })
  const nameList = [...participants]

  const tasks = []
  const decisions = [], blockers = [], risks = [], followups = [], commitments = []

  for (const seg of segments) {
    for (const sentence of splitSentences(seg.text)) {
      const lower = sentence.toLowerCase()

      // collect signals
      if (containsAny(lower, DECISION_CUES)) decisions.push({ text: sentence, by: seg.speaker })
      if (containsAny(lower, BLOCKER_CUES)) blockers.push({ text: sentence, by: seg.speaker })
      if (containsAny(lower, RISK_CUES)) risks.push({ text: sentence, by: seg.speaker })
      if (containsAny(lower, FOLLOWUP_CUES)) followups.push({ text: sentence, by: seg.speaker })

      const actionCue = containsAny(lower, ACTION_CUES)
      const commitCue = containsAny(lower, COMMITMENT_CUES)
      const futureCue = containsAny(lower, FUTURE_CUES)
      const vocative = detectVocative(sentence, nameList.filter((n) => n.toLowerCase() !== seg.speaker.toLowerCase()))

      // --- not-a-task filters ---------------------------------------------
      // Questions are not action items.
      if (/\?\s*$/.test(sentence)) continue
      // Greetings, thanks, and "let's start" filler are casual — ignore them
      // unless someone is being addressed to do something.
      if (CASUAL_RE.test(sentence.trim()) && !vocative) continue
      // First-person / passive completion reports ("I completed…", "APIs are completed",
      // "UI is 70% complete") are status updates — unless a forward-looking modal makes
      // them a real future action ("ensure docs are shared", "should be ready").
      const isDoneReport =
        (new RegExp(`\\bi (?:have |already )?(?:${DONE_VERBS.join('|')})\\b`, 'i').test(lower) ||
          /\b(is|are|was|were|been|has been|have been)\b[^.]*\b(complete|completed|done|finished|ready)\b/.test(lower) ||
          /%\s*(complete|completed|done)\b/.test(lower)) && !futureCue
      // Meeting-level goals/objectives are not assignable tasks.
      const isMetaGoal =
        /\b(our|the)\s+(goal|objective|aim)\b/.test(lower) ||
        /\bgoal\s+is\s+to\b/.test(lower) ||
        /\b(finalize|complete)\s+(the\s+progress|core\s+modules|the\s+core\s+modules|the\s+project)\b/.test(lower)
      if (isDoneReport || isMetaGoal) continue

      // A sentence is a task if it has an action cue, a forward commitment/modal,
      // or someone is addressed to do something.
      const isTask = !!actionCue || !!futureCue || (!!vocative && !!commitCue) ||
        (!!commitCue && /\b(will|karunga|chestanu|dunga|can|going to)\b/i.test(lower))
      if (!isTask) continue

      if (commitCue) commitments.push({ text: sentence, by: seg.speaker })

      // Multiple people each given distinct work in one sentence
      // ("assign task to Munidhar prepare doc, assign task to Reddeppa close the task")
      // → emit one task per assignee instead of a single merged task.
      const multi = splitMultiAssignment(sentence, nameList)
      if (multi) {
        for (const c of multi) {
          const cdue = parseDueDate(c.quote, refDate)
          let cpriority = detectPriority(c.quote)
          if (cpriority === 'Medium') cpriority = detectPriority(sentence)
          const known = nameList.some((n) => n.toLowerCase() === c.assignee.toLowerCase())
          const score = ownershipScore(known ? 'vocative' : 'low')
          tasks.push({
            title: c.title,
            description: c.quote,
            assignee_name_raw: c.assignee,
            assigned_by_name_raw: seg.speaker !== 'Unknown' ? seg.speaker : null,
            due_date: cdue.date,
            due_date_raw: cdue.raw,
            priority: cpriority,
            ownership_confidence: known ? 'high' : 'low',
            confidence: score.confidence,
            assignee_reasoning: known ? 'Explicitly assigned by name in the meeting.' : score.reasoning,
            source_quote: c.quote,
            language: seg.language,
          })
        }
        continue
      }

      // ownership resolution
      let assigneeRaw = vocative
      let confidence = 'high'
      let kind = 'vocative'
      if (!assigneeRaw && commitCue) {
        assigneeRaw = seg.speaker // self-commitment
        kind = 'self'
      }
      if (!assigneeRaw) { confidence = 'needs_confirmation'; kind = 'none' }
      else if (!nameList.some((n) => n.toLowerCase() === assigneeRaw.toLowerCase())) { confidence = 'low'; kind = 'low' }
      const score = ownershipScore(kind)

      const due = parseDueDate(sentence, refDate)
      // Priority: prefer the sentence; if neutral, fall back to cues in the whole turn.
      let priority = detectPriority(sentence)
      if (priority === 'Medium') priority = detectPriority(seg.text)
      tasks.push({
        title: cleanTitle(sentence, vocative),
        description: sentence,
        assignee_name_raw: assigneeRaw,
        assigned_by_name_raw: seg.speaker !== 'Unknown' ? seg.speaker : null,
        due_date: due.date,
        due_date_raw: due.raw,
        priority,
        ownership_confidence: confidence,
        confidence: score.confidence,
        assignee_reasoning: score.reasoning,
        source_quote: sentence,
        language: seg.language,
      })
    }
  }

  const detected = [...new Set(segments.flatMap((s) => (s.language || '').split('+')).filter(Boolean))]

  const summary = buildSummary({ segments, tasks, decisions, blockers, risks, followups, participants: nameList })

  return {
    engine: 'rule-based',
    segments,
    tasks,
    detected_languages: detected,
    participants: nameList,
    summary,
  }
}

function buildSummary({ segments, tasks, decisions, blockers, risks, followups, participants }) {
  const assigned = tasks.filter((t) => t.ownership_confidence !== 'needs_confirmation')
  const unassigned = tasks.filter((t) => t.ownership_confidence === 'needs_confirmation')
  const exec = `Meeting with ${participants.length} participant(s) across ${segments.length} segments. ` +
    `${tasks.length} action item(s) detected — ${assigned.length} assigned, ${unassigned.length} needing ownership confirmation. ` +
    `${decisions.length} decision(s), ${blockers.length} blocker(s), ${risks.length} risk(s) noted.`
  return {
    executive_summary: exec,
    key_decisions: decisions.map((d) => d.text),
    action_items: tasks.map((t) => t.title),
    risks: risks.map((r) => r.text),
    blockers: blockers.map((b) => b.text),
    follow_ups: followups.map((f) => f.text),
    assigned_tasks: assigned.map((t) => `${t.title} → ${t.assignee_name_raw}`),
    unassigned_tasks: unassigned.map((t) => t.title),
  }
}

export { detectLanguages }
