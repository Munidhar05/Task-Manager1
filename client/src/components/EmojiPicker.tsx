import React, { useEffect, useMemo, useRef, useState } from 'react'

// A full emoji picker with no dependency and no network call.
//
// The obvious alternative — emoji-mart or similar — is ~200 KB of JS plus a data
// file fetched at runtime, on an app that already warns about its bundle size and
// has to work on a phone on a bad connection. A curated set covers what people
// actually reach for in a work chat; the long tail (flags, every skin tone of
// every profession) is what the OS keyboard is for, and typing one still works.

interface Group { name: string; icon: string; emojis: string[] }

const GROUPS: Group[] = [
  {
    name: 'Reactions', icon: '👍',
    emojis: ['👍', '👎', '👏', '🙌', '🙏', '💪', '🤝', '👌', '✌️', '🤞', '👊', '✋', '🫡', '🤙', '👀', '🫶'],
  },
  {
    name: 'Smileys', icon: '😀',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '😘',
      '😗', '😋', '😛', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥳', '😏', '😒', '😞', '😔', '😟', '😕',
      '🙁', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶',
      '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯',
      '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒',
    ],
  },
  {
    name: 'Work', icon: '💼',
    emojis: [
      '💼', '📁', '📂', '🗂️', '📅', '📆', '🗓️', '📊', '📈', '📉', '📋', '📌', '📍', '📎', '🖇️', '📏',
      '✂️', '🗃️', '🗄️', '🗑️', '🔒', '🔓', '🔑', '🔨', '🛠️', '⚙️', '🧰', '🧲', '⏰', '⏱️', '⌛', '🕐',
      '💡', '🔋', '🔌', '💻', '🖥️', '🖨️', '⌨️', '🖱️', '📱', '☎️', '📞', '📠', '📧', '📨', '📩', '📤',
      '📥', '📦', '🏷️', '💰', '💳', '🧾', '💵', '📝', '✏️', '🖊️', '📄', '📃', '📑', '🔍', '🔎', '📢',
    ],
  },
  {
    name: 'Status', icon: '✅',
    emojis: [
      '✅', '☑️', '✔️', '❌', '❎', '⭕', '🚫', '⛔', '⚠️', '❗', '❕', '❓', '❔', '💯', '🔥', '⭐',
      '🌟', '✨', '⚡', '💥', '🎯', '🏆', '🥇', '🥈', '🥉', '🎉', '🎊', '🚀', '📣', '🔔', '🔕', '♻️',
      '🆕', '🆗', '🆒', '🆓', '🔜', '🔝', '⏳', '🛑', '🟢', '🟡', '🔴', '🔵', '⚪', '⚫', '🟠', '🟣',
    ],
  },
  {
    name: 'People', icon: '🧑',
    emojis: [
      '🧑', '👩', '👨', '🧑‍💼', '👩‍💼', '👨‍💼', '🧑‍💻', '👩‍💻', '👨‍💻', '🧑‍🔧', '👮', '🕵️', '🧑‍🏫', '🧑‍🍳', '🧑‍🌾', '🧑‍🔬',
      '👶', '🧒', '👦', '👧', '🧓', '👴', '👵', '🙋', '🙆', '🙅', '💁', '🤦', '🤷', '🚶', '🏃', '🧘',
    ],
  },
  {
    name: 'Things', icon: '🍕',
    emojis: [
      '☕', '🍵', '🧋', '🥤', '🍺', '🍻', '🥂', '🍾', '🍕', '🍔', '🍟', '🌮', '🌯', '🥗', '🍜', '🍛',
      '🍚', '🍞', '🥐', '🧁', '🍰', '🎂', '🍪', '🍫', '🍬', '🍎', '🍌', '🍇', '🍉', '🥭', '🥥', '🍿',
      '🏠', '🏢', '🏭', '🏬', '🚗', '🚕', '🚌', '🚲', '✈️', '🚀', '🚢', '🛺', '🏍️', '🗺️', '🧳', '⛱️',
    ],
  },
  {
    name: 'Nature', icon: '🌱',
    emojis: [
      '🌱', '🌿', '🍀', '🌵', '🌳', '🌴', '🌸', '🌼', '🌻', '🌹', '🥀', '💐', '🍁', '🍂', '🍃', '🌺',
      '☀️', '🌤️', '⛅', '🌧️', '⛈️', '🌩️', '❄️', '☃️', '🌈', '🌊', '🔥', '💧', '⛰️', '🌋', '🌙', '🌞',
      '🐶', '🐱', '🐭', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐥', '🦄',
    ],
  },
  {
    name: 'Hearts', icon: '❤️',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝'],
  },
]

// Search terms, kept short on purpose: this is a lookup people type two letters
// into, not a thesaurus.
const KEYWORDS: Record<string, string> = {
  '👍': 'thumbsup yes ok good approve like',
  '👎': 'thumbsdown no bad reject',
  '👏': 'clap applause wellzdone bravo',
  '🙏': 'thanks please pray thankyou',
  '🙌': 'celebrate hooray praise',
  '🔥': 'fire hot great lit',
  '✅': 'check done tick complete yes',
  '❌': 'cross no wrong fail',
  '⚠️': 'warning careful caution risk',
  '🎉': 'party celebrate congrats launch',
  '🚀': 'rocket ship launch fast growth',
  '💯': 'hundred perfect full',
  '😂': 'laugh lol funny joy cry',
  '❤️': 'heart love red',
  '👀': 'eyes look watching review',
  '🤔': 'think hmm consider question',
  '😅': 'sweat nervous laugh phew',
  '🥳': 'party celebrate birthday',
  '😭': 'cry sob sad tears',
  '💪': 'strong muscle effort',
  '⏰': 'time alarm clock deadline late',
  '📅': 'calendar date schedule meeting',
  '💼': 'work business briefcase job',
  '💻': 'laptop code computer dev',
  '📝': 'note write memo task',
  '🎯': 'target goal aim focus',
  '🏆': 'trophy win award best',
  '🐛': 'bug issue defect',
  '☕': 'coffee break tea',
  '🙋': 'raise hand volunteer question',
  '🤝': 'handshake deal agree partner',
  '🫡': 'salute understood yes sir',
}

const RECENT_KEY = 'smarttask_emoji_recent'

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 24) } catch { return [] }
}
export function rememberEmoji(e: string) {
  try {
    const next = [e, ...loadRecent().filter((x) => x !== e)].slice(0, 24)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch { /* private mode — recents are a convenience, never a requirement */ }
}

export default function EmojiPicker({ onPick, onClose, align = 'left' }: { onPick: (e: string) => void; onClose: () => void; align?: 'left' | 'right' }) {
  const [q, setQ] = useState('')
  const [tab, setTab] = useState(0)
  const recent = useMemo(loadRecent, [])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return null
    const hit = (e: string) => (KEYWORDS[e] || '').includes(needle)
    const all = GROUPS.flatMap((g) => g.emojis)
    // Keyword matches first; if nothing matches, fall back to the raw character
    // so pasting an emoji into the box still finds it.
    const byWord = all.filter(hit)
    return byWord.length ? byWord : all.filter((e) => e.includes(needle))
  }, [q])

  const take = (e: string) => { rememberEmoji(e); onPick(e) }

  return (
    <div className={'emoji-pop ' + align} ref={ref} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.preventDefault()}>
      <input
        className="emoji-search"
        placeholder="Search — try 'done', 'late', 'thanks'"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search emoji"
        autoFocus
      />
      {!results && (
        <div className="emoji-tabs" role="tablist">
          {GROUPS.map((g, i) => (
            <button key={g.name} className={i === tab ? 'active' : ''} title={g.name} aria-label={g.name} aria-selected={i === tab} role="tab" onClick={() => setTab(i)}>{g.icon}</button>
          ))}
        </div>
      )}
      <div className="emoji-grid">
        {results
          ? (results.length
              ? results.map((e, i) => <button key={e + i} onClick={() => take(e)}>{e}</button>)
              : <div className="empty" style={{ gridColumn: '1 / -1', padding: 14, fontSize: 12.5 }}>Nothing matched</div>)
          : (
            <>
              {tab === 0 && recent.length > 0 && (
                <>
                  <div className="emoji-head">Recent</div>
                  {recent.map((e, i) => <button key={'r' + e + i} onClick={() => take(e)}>{e}</button>)}
                  <div className="emoji-head">{GROUPS[0].name}</div>
                </>
              )}
              {GROUPS[tab].emojis.map((e, i) => <button key={e + i} onClick={() => take(e)}>{e}</button>)}
            </>
          )}
      </div>
    </div>
  )
}
