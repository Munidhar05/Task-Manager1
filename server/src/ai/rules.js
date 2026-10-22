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
  // The logistics of real meetings, not just engineering verbs: "can you book
  // the courier" was dropped because 'book' was nobody's action. Ambiguous
  // stems take their article ('print the', not 'print', which is in "sprint").
  'book', 'arrange', 'dispatch', 'deliver', 'follow up', 'coordinate', 'contact', 'email',
  'organise', 'organize', 'approve', 'draft', 'publish', 'upload', 'collect',
  'print the', 'order the', 'ship the', 'pay the', 'call the', 'call back',
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

// First-person commitment cues => assignee is the speaker. The English ones
// are matched as whole words: as raw substrings 'i will' also matched the end
// of "Ravi will" and 'i can' the end of "Sai can", which handed the SPEAKER work
// a third person had just been given (and, once acknowledgements were filtered,
// could drop "Ravi will send it tomorrow" altogether).
const COMMIT_EN_RE = /\b(?:i will|i[’']ll|i can|i am going to|i[’']m going to|let me|i shall)\b/i
const COMMITMENT_CUES = [
  'main karunga', 'main kar dunga', 'mai karunga', 'main bhej dunga',
  'nenu chestanu', 'nenu chesta', 'nenu pampistanu', 'nenu chuskuntanu',
  'నేను చేస్తాను', 'मैं करूंगा',
]

// Everything that carries no task identity: the commitment frame, pronouns,
// politeness, time words, and verbs that mean nothing without an object. What
// survives this is the subject matter of the task.
const ACK_FRAME = /\b(?:yes|yeah|yep|ya|no|sure|ok|okay|okey|fine|right|alright|cool|great|good|perfect|thanks|thank|you|noted|understood|definitely|absolutely|course|haan|han|ji|acha|achha|theek|thik|sari|avunu|ala|alaage|i|we|will|shall|can|could|would|am|is|are|was|be|been|being|going|gonna|to|let|me|my|us|our|it|that|this|these|those|them|they|the|a|an|same|and|so|then|now|also|please|kindly|get|getting|got|do|doing|does|done|take|taking|taken|care|handle|handling|handled|look|looking|see|seeing|sort|sorted|work|working|start|starting|started|begin|finish|complete|check|checking|confirm|update|revert|share|send|fix|on|in|at|by|for|of|from|with|up|out|into|over|away|immediately|straight|asap|eod|today|tomorrow|tonight|morning|evening|soon|shortly|later|first|thing|main|mai|mein|hum|hamara|mera|karunga|karungi|karunga|karna|karke|kar|karo|dunga|dungi|doonga|dena|denge|deta|dete|lunga|loonga|bhej|bhejunga|dekh|dekhunga|dekhta|dekhlunga|likh|raha|rahunga|rahungi|ho|hoga|jayega|jaega|abhi|turant|kal|aaj|parson|bilkul|zaroor|pakka|sir|madam|nenu|nene|naa|memu|chestanu|chesta|chestha|chestaanu|chesthanu|cheddam|cheyyi|cheyyandi|chey|pampistanu|pamputanu|chuskuntanu|chustanu|chuddam|chuste|ventane|repu|ivala|ivaala|ippude|ippudu|sare|andi|avunu)\b/gi
// The same frame, tested one word at a time.
const ACK_WORD = new RegExp(`^${ACK_FRAME.source}$`, 'i')

// "Yes, I will review it today" is an acknowledgement too, though 'review' is not
// frame: its only object is a pronoun pointing back at work somebody else just
// named. These are the pronouns that can do that pointing.
const PRONOUN_OBJECTS = new Set(['it', 'that', 'this', 'them', 'these', 'those', 'both', 'everything', 'all'])
// Words around "<verb> it" that add no second piece of work: a place, the
// speaker themselves, or a time the frame does not already cover.
const ACK_FILLER = new Set(['here', 'there', 'again', 'myself', 'personally', 'before', 'until', 'till', 'within',
  'hour', 'hours', 'minute', 'minutes', 'mins', 'weekend', 'noon', 'lunch', 'pm'])

// Someone speaking for themselves. The pronoun-object rule below is about the
// speaker accepting work ("I will review it"); a third person's "Ravi will send
// it" is an assignment, however short.
const FIRST_PERSON_RE = /\b(?:i|we|me)\b|\b(?:main|mai|hum|nenu|nene|memu)\b|मैं|నేను/i

// "Ravi will send it tomorrow": work taken by a named third person who is not
// a known participant (known ones are found anywhere in the sentence already).
// Only a capitalised name opening the sentence, followed by a future modal and
// not by 'be', and never a pronoun, a filler or a day, so a stray capital is at
// worst an unmatched name for the reviewer to correct, never the speaker.
const THIRD_PERSON_RE = /^([A-Z][\p{L}]+(?:\s[A-Z][\p{L}]+)?)\s+(?:will|shall|can|is going to|has to|needs to)\s+(?!be\b)/u
const NOT_A_SUBJECT = /^(?:i|we|you|he|she|they|it|this|that|there|someone|somebody|anyone|anybody|everyone|everybody|nobody|the|our|my|your|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|january|february|march|april|may|june|july|august|september|october|november|december)$/i
function thirdPersonSubject(sentence) {
  const m = THIRD_PERSON_RE.exec(sentence.trim())
  if (!m) return null
  const first = m[1].split(/\s/)[0].toLowerCase()
  if (NOT_A_SUBJECT.test(first) || NON_NAMES.has(first)) return null
  return m[1]
}

// A commitment whose only object is a pronoun. Set aside the frame, the deadline
// (`dueRaw`, the phrase parseDueDate matched) and the pronouns, and at most one
// word may be left: the verb acting on the pronoun, so it comes BEFORE one. A word
// after the pronoun is a real complement ("send it to the client") or the noun
// the pronoun only introduced ("fix this bug"), and either of those is a task.
function onlyPronounObject(sentence, dueRaw) {
  const due = new Set(String(dueRaw || '').toLowerCase().split(/\s+/))
  const words = sentence.toLowerCase().replace(/['’](?:ll|ve|re|d|m|s)\b/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const pronouns = [], content = []
  words.forEach((w, i) => {
    if (PRONOUN_OBJECTS.has(w)) pronouns.push(i)
    else if (!ACK_WORD.test(w) && !due.has(w) && !ACK_FILLER.has(w) && !/^\d+$/.test(w)) content.push(i)
  })
  if (content.length > 1 || !pronouns.length) return false
  return !content.length || pronouns.some((p) => p > content[0])
}

// Hindi and Telugu are subject-object-verb: "main login bug fix kar dunga" puts
// the work in the MIDDLE of the commitment. A contiguous phrase list like
// COMMITMENT_CUES can therefore only ever match the object-less version -- the
// acknowledgement -- and silently loses the owner on every real one. The subject
// and the future ending have to be allowed to drift apart.
const COMMIT_RE = new RegExp(
  [
    // Hindi: main / mai / mein ... karunga | kar dunga | bhej dunga | dekh lunga
    String.raw`\b(?:main|mai|mein|hum)\b[^.?!]{0,70}?\w*(?:dunga|dungi|doonga|karunga|karungi|lunga|loonga|unga|ungi)\b`,
    // Telugu: nenu ... chestanu | pampistanu | chuskuntanu
    String.raw`\b(?:nenu|nene|memu)\b[^.?!]{0,70}?\w*(?:stanu|sthanu|staanu|kuntanu|tanu|thanu)\b`,
    // Devanagari / Telugu script equivalents
    String.raw`मैं[^।.?!]{0,70}?(?:ूंगा|ूंगी|ूँगा)`,
    String.raw`నేను[^.?!]{0,70}?(?:స్తాను|తాను|కుంటాను)`,
  ].join('|'),
  'i',
)

const PRIORITY_RULES = [
  { p: 'Critical', cues: ['production issue', 'prod down', 'production down', 'critical', 'p0', 'showstopper', 'venatane', 'immediately', 'turant', 'abhi ', 'right now', 'వెంటనే', 'तुरंत'] },
  { p: 'High', cues: ['urgent', 'asap', 'before release', 'before deployment', 'before client demo', 'high priority', 'today', 'eod', 'end of day', 'jaldi', 'twaraga', 'fast', 'జల్ది', 'త్వరగా'] },
  { p: 'Low', cues: ['future', 'later', 'enhancement', 'nice to have', 'whenever', 'no rush', 'baad mein', 'tarvata', 'తర్వాత', 'बाद में', 'optional'] },
]

// A decision is something the room settled, said as settled, so its cues match
// as whole words and phrases. As bare substrings, 'final' fired inside "can you
// finalise the brief?" and filed every request to finish something as a decision
// too. "Finalise" on its own is work still to be done.
//
// Reported as already decided: a decision wherever it appears.
const DECIDED_RE = /(?<![\p{L}\p{N}])(?:we(?:['’]ve|\s+have|\s+had)?\s+decided|decide\s+chesam|tay\s+kiya)(?![\p{L}\p{N}])|फैसला|నిర్ణయించాం/iu
// Settled as it is said: "the decision is", "final decision", "let's go with".
// "Finalised" counts when it is reported ("the vendor is finalised"), not when it
// is asked for ("should be finalised", "get it finalised"); "final" only as the
// verdict that ends its clause ("that's final").
const SETTLED_RE = new RegExp([
  String.raw`(?<![\p{L}\p{N}])decision\s+is(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])final\s+decision(?![\p{L}\p{N}])`,
  String.raw`(?:(?<![\p{L}\p{N}])(?:is|are|was)|['’]s)\s+final(?=\s*(?:[.,;:!?]|$))`,
  String.raw`(?<![\p{L}\p{N}])let(?:['’]s|\s+us)\s+go\s+with(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}]|\b(?:be|being|get|gets|getting)\s+)finali[sz]ed(?![\p{L}\p{N}])`,
].join('|'), 'iu')
// ...unless it is the condition of something else: "Once the design is
// finalised, send it to print" is an instruction waiting on a decision, and a
// decision-only sentence files no task, so reading it as one would lose the work.
const CONDITION_RE = /\b(?:once|when|whenever|if|unless|until|till|after|before|as\s+soon\s+as)\b/i

function hasDecisionCue(sentence) {
  if (DECIDED_RE.test(sentence)) return true
  const m = SETTLED_RE.exec(sentence)
  if (!m) return false
  const lead = sentence.slice(0, m.index)
  return !CONDITION_RE.test(lead.slice(Math.max(lead.lastIndexOf(','), lead.lastIndexOf(';')) + 1))
}

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
  'reviewed', 'set up', 'setup', 'deployed', 'resolved', 'integrated',
  'booked', 'arranged', 'dispatched', 'delivered', 'emailed', 'approved', 'drafted', 'published',
  'uploaded', 'collected', 'printed', 'ordered', 'shipped', 'paid', 'called', 'contacted',
  'coordinated', 'organised', 'organized']

// Forward-looking modals that mark a real (future) action item even if it mentions completion.
const FUTURE_CUES = ['will', "i'll", 'shall', 'going to', 'need to', 'needs to', 'should',
  'must', 'have to', 'has to', "let's", 'let us', 'plan to', 'target', 'by friday', 'by monday',
  'by tuesday', 'by wednesday', 'by thursday', 'by saturday', 'by sunday', 'by tomorrow',
  'by eod', 'next week', 'ready by', 'should be ready', 'will be ready', 'can begin', 'can start']

// Greetings / pleasantries / meeting-procedural filler — never action items.
// A request aimed at somebody: an instruction wearing a question mark.
const REQUEST_RE = /\b(?:can|could|would|will|shall)\s+(?:you|u|we|someone|somebody|anyone|anybody)\b|\bare\s+you\s+able\s+to\b|\bwould\s+you\s+mind\b|\bplease\b|\bkar\s+(?:do|sakte|sakoge)\b|\bcheyyagalara\b|\bcheygalara\b/i
// A question that wants an answer rather than an outcome. Anchored at the start,
// because "fix the crash by Friday, is that ok?" is still an instruction.
// What people ask each other about the call itself, never work.
const CALL_META_RE = /\b(?:hear|see|understand)\s+(?:me|us|my screen|the screen)\b|\b(?:speak up|say that again|repeat (?:that|it|yourself)|unmute|mute (?:yourself|your mic))\b/i

const PROBE_RE = /^(?:what|when|where|which|who|whom|whose|why|how|did|does|do|has|have|had|is|are|was|were|should\s+i|any\s+update|anything\s+else)\b/i

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
// Words that open a sentence followed by a comma but are never somebody's name.
// Without this, "Yes, I will get that done" assigns the task to a person called
// "Yes": the leading token is accepted as a plausible name, and an unrecognised
// name is exactly what a real transcript looks like, so nothing downstream
// catches it.
const NON_NAMES = new Set([
  'yes', 'yeah', 'yep', 'ya', 'no', 'nope', 'ok', 'okay', 'okey', 'sure', 'right',
  'fine', 'alright', 'well', 'so', 'also', 'then', 'now', 'actually', 'basically',
  'honestly', 'obviously', 'anyway', 'however', 'but', 'and', 'first', 'firstly',
  'second', 'secondly', 'third', 'next', 'finally', 'lastly', 'meanwhile',
  'thanks', 'thank', 'please', 'kindly', 'correct', 'exactly', 'true', 'agreed',
  'good', 'great', 'cool', 'perfect', 'nice', 'understood', 'noted', 'done',
  'sorry', 'hi', 'hello', 'hey', 'listen', 'look', 'see', 'again', 'instead',
  // plural address: a room, not a person
  'guys', 'team', 'everyone', 'everybody', 'all', 'folks', 'people',
  // Hindi / Telugu discourse openers
  'haan', 'han', 'ji', 'acha', 'achha', 'theek', 'thik', 'bhai', 'arre', 'arey',
  'matlab', 'phir', 'abhi', 'sari', 'sare', 'avunu', 'kadu', 'ante', 'mari',
  'ippudu', 'tarvata', 'alaage', 'ela',
])

function detectVocative(sentence, knownNames) {
  const m = sentence.match(/^([A-Za-zऀ-ॿఀ-౿][\wऀ-ॿఀ-౿]{1,30})[,:]/)
  if (m) {
    const candidate = m[1].trim()
    // accept if it looks like a name (matches a known participant, else still plausible)
    const known = knownNames.find((n) => n.toLowerCase() === candidate.toLowerCase())
    // A known participant wins outright. An unrecognised leading word is only a
    // name if it is not one of the fillers people habitually open with.
    if (known) return known
    if (!NON_NAMES.has(candidate.toLowerCase())) return candidate
  }
  // else search for a known name anywhere
  for (const n of knownNames) {
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (re.test(sentence)) return n
  }
  return null
}

// Leading conversational filler to strip so titles read as imperative action items.
// "Can you fix the crash" is a request; the task is "Fix the crash". The frame
// is how it was asked, not what has to be done, and it reads wrong in a list.
const TITLE_PREFIXES = /^(?:i will|i'll|i shall|i can|i am going to|i'm going to|i recommend|i think we should|we need to|we should|we will|we have to|let us|let's|please|also|so|now|then|kindly|i would|i'd|can you(?: please)?|could you(?: please)?|would you(?: please| mind)?|will you(?: please)?|can u|could u|can we|could we|shall we|are you able to|do you think you can)\s+/i

// The speaker answering before the work starts: "Yes, ...", "Okay ...". 'right'
// only with its comma, because in "Right-size the cluster" it is the work.
// The opener only goes when it is punctuated as one, or runs straight into the
// speaker's own "I/we will…": "Sure thing, I will send…" must not become
// "Thing, I will send…".
const ANSWER_OPENER = /^(?:(?:yes|yeah|ok|okay|sure(?: thing)?|alright|of course|no problem)(?:\s+(?:sir|madam|ma'?am|ji|boss))?(?:\s*[,.!]+|(?=\s+(?:i|we)\b))|right\s*,)\s*/i

function cleanTitle(sentence, vocative) {
  let s = sentence
  for (let i = 0; i < 2 && ANSWER_OPENER.test(s); i++) s = s.replace(ANSWER_OPENER, '')
  if (vocative) s = s.replace(new RegExp(`^${vocative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,:]\\s*`, 'i'), '')
  // Strip leading filler (may stack, e.g. "So I will…").
  for (let i = 0; i < 3 && TITLE_PREFIXES.test(s); i++) s = s.replace(TITLE_PREFIXES, '')
  s = s.replace(/\s+/g, ' ').trim().replace(/[.!?।]+$/, '')
  if (s.length > 0) s = s[0].toUpperCase() + s.slice(1)
  if (s.length > 120) s = s.slice(0, 117).replace(/\s+\S*$/, '') + '…'
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
    const sentences = splitSentences(seg.text)
    // Which sentences of this turn are about a piece of work: a task, or a
    // commitment even when it is dropped as an acknowledgement. A task whose own
    // words carry no urgency borrows it only from the follow-ups that qualify it
    // ("... by Friday? It is urgent."), up to the next sentence about other work,
    // and never from an earlier sentence: "Yes, I will review it today. Employee
    // 1, please send the PDF" does not make the PDF urgent.
    const aboutWork = []
    const borrowers = []
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i]
      const lower = sentence.toLowerCase()
      const isQuestion = /\?\s*$/.test(sentence)
      const vocative = detectVocative(sentence, nameList.filter((n) => n.toLowerCase() !== seg.speaker.toLowerCase()))

      // collect signals
      // A question asks for a decision, and a request addressed to somebody
      // hands out work: neither one is a decision.
      const isDecision = !isQuestion && !(vocative && REQUEST_RE.test(lower)) && hasDecisionCue(sentence)
      if (isDecision) decisions.push({ text: sentence, by: seg.speaker })
      if (containsAny(lower, BLOCKER_CUES)) blockers.push({ text: sentence, by: seg.speaker })
      if (containsAny(lower, RISK_CUES)) risks.push({ text: sentence, by: seg.speaker })
      if (containsAny(lower, FOLLOWUP_CUES)) followups.push({ text: sentence, by: seg.speaker })

      const actionCue = containsAny(lower, ACTION_CUES)
      // A commitment is either one of the fixed phrases or the drifted-apart
      // subject-object-verb shape above.
      const commitIntent = COMMIT_RE.test(sentence)
      const commitCue = COMMIT_EN_RE.test(sentence) || containsAny(lower, COMMITMENT_CUES) || commitIntent
      if (commitCue) aboutWork[i] = true
      const futureCue = containsAny(lower, FUTURE_CUES)
      const due = parseDueDate(sentence, refDate)

      // --- not-a-task filters ---------------------------------------------
      // A question mark does not mean "not a task". The commonest way work is
      // actually handed out in a meeting is a polite request -- "Employee 1, can
      // you fix the checkout crash by Friday?" -- so dropping every interrogative
      // threw away precisely the clearest assignments and kept the vague ones.
      // What is genuinely not a task is a question that wants information:
      // "what is the status?", "did you finish it?".
      if (isQuestion && !(REQUEST_RE.test(lower) && !PROBE_RE.test(sentence.trim()))) continue
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
      // A bare acknowledgement -- "Yes, I will get that done", "Okay, I'll start
      // tomorrow" -- is somebody ACCEPTING work that was just handed out. The task
      // is the sentence before it, which is already captured. Filed literally it
      // becomes a duplicate titled "Get that done" that nobody can act on.
      //
      // The test is whether there is an object: strip the commitment frame, the
      // pronouns and the time words, and what remains is what the task would be
      // ABOUT. If nothing remains there was never a second task. So "I will fix
      // it" is an acknowledgement and "I will fix the checkout crash" is not, and
      // neither is a verb whose only object is a pronoun: "I will review it today".
      const isBareAck = commitCue && !vocative && (!sentence
        .replace(/'(?:ll|ve|re|d|m|s)\b/gi, ' ')
        .replace(ACK_FRAME, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim() || (FIRST_PERSON_RE.test(sentence) && onlyPronounObject(sentence, due.raw)))
      // A decision with nobody named and nobody volunteering is the room agreeing
      // on something, not work handed to anyone: in "We decided to go with the
      // matte finish" the finish is the boxes', not a verb. It is listed under
      // decisions; filed as a task too, it is an ownerless duplicate to reject.
      // Unless it also asks for something: "..., so please update the print
      // order" is a decision AND a request, and dropping it would lose the work.
      const decisionOnly = isDecision && !vocative && !commitCue && !REQUEST_RE.test(lower)
      if (isDoneReport || isMetaGoal || isBareAck || decisionOnly) continue

      // A sentence is a task if it has an action cue, a forward commitment/modal,
      // or someone is addressed to do something.
      // commitIntent is additive: the future ending IS the forward-looking marker,
      // so a Telugu commitment needs no separate English modal to qualify.
      // A request addressed to someone by name is work whatever its verb: "Employee
      // 6, can you book the courier?" is an assignment even when 'book' is not a
      // listed action. Not the call's own housekeeping ("can you hear me?").
      const isTask = !!actionCue || !!futureCue || (!!vocative && !!commitCue) ||
        (!!commitCue && /\b(will|karunga|chestanu|dunga|can|going to)\b/i.test(lower)) ||
        commitIntent || (!!vocative && REQUEST_RE.test(lower) && !CALL_META_RE.test(lower))
      if (!isTask) continue
      aboutWork[i] = true

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
          if (cpriority === 'Medium') borrowers.push([tasks[tasks.length - 1], i])
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
      if (!assigneeRaw) assigneeRaw = thirdPersonSubject(sentence)
      if (!assigneeRaw) { confidence = 'needs_confirmation'; kind = 'none' }
      else if (!nameList.some((n) => n.toLowerCase() === assigneeRaw.toLowerCase())) { confidence = 'low'; kind = 'low' }
      const score = ownershipScore(kind)

      // Priority: the sentence's own cue. Without one it may be borrowed from a
      // follow-up, once the rest of the turn is known (below).
      const priority = detectPriority(sentence)
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
      if (priority === 'Medium') borrowers.push([tasks[tasks.length - 1], i])
    }
    for (const [task, i] of borrowers) {
      const followUps = []
      for (let j = i + 1; j < sentences.length && !aboutWork[j]; j++) followUps.push(sentences[j])
      if (followUps.length) task.priority = detectPriority(followUps.join(' '))
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

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// The statistics sentence of a rule-based summary. It describes suggestions that
// nobody has reviewed yet, so it says whether each NAMES an owner, never that it
// is "assigned": on the same card the review state uses that word for work a
// manager approved, and "3 assigned" beside nothing assigned is a contradiction.
function statsSentence({ participants, segments, tasks, owned, decisions, blockers, risks }) {
  const unowned = tasks - owned
  const items = plural(tasks, 'action item')
  const out = [`Meeting with ${plural(participants, 'participant')} across ${plural(segments, 'segment')}.`]
  if (!tasks) out.push('No action items found.')
  else if (!unowned) out.push(`${items} found, ${tasks === 1 ? 'with' : 'all with'} a named owner.`)
  else if (!owned) out.push(`${items} found, ${tasks === 1 ? 'without' : 'none with'} a named owner.`)
  else out.push(`${items} found — ${owned} with a named owner, ${unowned} without.`)
  const noted = [[decisions, 'decision'], [blockers, 'blocker'], [risks, 'risk']].filter(([n]) => n).map(([n, w]) => plural(n, w))
  if (noted.length) out.push(`${noted.slice(0, -1).join(', ')}${noted.length > 1 ? ' and ' : ''}${noted[noted.length - 1]} noted.`)
  return out.join(' ')
}

// Rule-based summaries stored before this wording read "... 3 assigned, 1
// needing ownership confirmation ..." about suggestions nobody had approved.
// They are restated where they are shown, from the counts they carry. Any other
// text, including every model-written summary, comes back untouched.
const LEGACY_STATS = /^Meeting with (\d+) participant\(s\) across (\d+) segments\. (\d+) action item\(s\) detected — (\d+) assigned, \d+ needing ownership confirmation\. (\d+) decision\(s\), (\d+) blocker\(s\), (\d+) risk\(s\) noted\.$/
export function restateRuleSummary(text) {
  const m = typeof text === 'string' ? LEGACY_STATS.exec(text.trim()) : null
  if (!m) return text
  const [participants, segments, tasks, owned, decisions, blockers, risks] = m.slice(1).map(Number)
  return statsSentence({ participants, segments, tasks, owned, decisions, blockers, risks })
}

function buildSummary({ segments, tasks, decisions, blockers, risks, followups, participants }) {
  // Owned: the transcript names somebody for it. Not the same as assigned.
  const owned = tasks.filter((t) => t.ownership_confidence !== 'needs_confirmation')
  const unowned = tasks.filter((t) => t.ownership_confidence === 'needs_confirmation')
  const exec = statsSentence({
    participants: participants.length, segments: segments.length, tasks: tasks.length, owned: owned.length,
    decisions: decisions.length, blockers: blockers.length, risks: risks.length,
  })
  return {
    executive_summary: exec,
    key_decisions: decisions.map((d) => d.text),
    action_items: tasks.map((t) => t.title),
    risks: risks.map((r) => r.text),
    blockers: blockers.map((b) => b.text),
    follow_ups: followups.map((f) => f.text),
    assigned_tasks: owned.map((t) => `${t.title} → ${t.assignee_name_raw}`),
    unassigned_tasks: unowned.map((t) => t.title),
  }
}

export { detectLanguages, detectPriority }
