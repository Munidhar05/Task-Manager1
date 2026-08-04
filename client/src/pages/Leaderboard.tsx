import { useEffect, useState } from 'react'
import { api, userAvatarUrl } from '../api'
import { useAuth } from '../auth'
import { Avatar, Ic, EmptyState, Bar } from '../ui'

// Points leaderboard. Fixed points per action:
//   complete a task 10 · assign a task 5 · comment on a task 1 · change a status 1
// Complete 10 tasks and you have 100 points. Today / last 30 days / all-time are
// the same tally over a different window. Clicking a card shows which actions
// earned the points. Everything comes from /api/scores, counted live from the task
// tables — the per-action values are the server's `rules`, never hard-coded here.

const PERIODS = [
  { k: 'day', label: 'Today', hint: 'points earned today' },
  { k: 'month', label: 'Monthly', hint: 'points earned in the last 30 days' },
  { k: 'all', label: 'All-time', hint: 'every point ever earned' },
]

// One colour per rule, reused by the card chips and the detail bars so a rule is
// recognisable at a glance. Concrete values (matches the ui.tsx convention).
const RULE_COLORS: Record<string, string> = {
  assigned: '#2f6fd0',
  completed: '#0f9d6e',
  commented: '#8b5cf6',
  status: '#d98a0b',
}
const ruleColor = (k: string) => RULE_COLORS[k] || '#64748b'

// "status change" + 2 → "status changes". Only the noun-phrase rules need it —
// "assigned"/"completed"/"commented" are past participles and never pluralise.
const PLURALISE = new Set(['status change'])
const plural = (word: string, n: number) => (n === 1 || !PLURALISE.has(word) ? word : word + 's')

const medalColor = ['#d4af37', '#a8b3c4', '#c8823c'] // gold / silver / bronze

const Trophy = ({ size = 16, color = '#d4af37' }: { size?: number; color?: string }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z" /><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 0-3 3" />
  </svg>
)

// Points-per-day bars for the detail view.
function DayBars({ history, w = 320, h = 54 }: { history: { day: string; points: number }[]; w?: number; h?: number }) {
  const max = Math.max(1, ...history.map((d) => d.points))
  const gap = 2
  const bw = Math.max(2, (w - gap * (history.length - 1)) / history.length)
  return (
    <svg width={w} height={h} className="lb-spark" aria-hidden="true">
      {history.map((d, i) => {
        const bh = d.points ? Math.max(2, (d.points / max) * (h - 6)) : 1
        return <rect key={d.day} x={i * (bw + gap)} y={h - bh} width={bw} height={bh} rx={1.5}
          fill={d.points ? '#f2622e' : 'var(--n-300)'} />
      })}
    </svg>
  )
}

export default function Leaderboard() {
  const { user } = useAuth()
  const [period, setPeriod] = useState('month')
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = () => {
    setError(false); setRefreshing(true)
    api.get(`/scores/leaderboard?period=${period}`).then(setData).catch(() => setError(true)).finally(() => setRefreshing(false))
  }
  useEffect(load, [period])

  if (!user) return null

  return (
    <>
      <div className="lb-toolbar section">
        <div className="muted" style={{ fontSize: 13 }}>
          {/* Read off the server's rules so the legend can't drift from the scoring. */}
          {data?.rules?.length
            ? data.rules.map((r: any) => `${r.points} ${r.points === 1 ? 'pt' : 'pts'} ${r.short || r.label.toLowerCase()}`).join(' · ')
            : 'Points are awarded for assigning, completing and commenting on tasks.'}
        </div>
        <div className="lb-winsel" role="tablist" aria-label="Time period">
          {PERIODS.map((p) => (
            <button key={p.k} role="tab" aria-selected={period === p.k} title={p.hint}
              className={'lb-win-btn' + (period === p.k ? ' active' : '')} onClick={() => setPeriod(p.k)}>{p.label}</button>
          ))}
        </div>
      </div>

      {error && (
        <div className="card section"><EmptyState icon={<Ic name="warning" size={40} />} title="Couldn't load the leaderboard"
          hint="Check your connection and try again." action={<button className="btn btn-primary btn-sm" onClick={load}>Retry</button>} /></div>
      )}

      {!error && !data && (
        <div className="lb-list section">{Array.from({ length: 6 }).map((_, i) => <span key={i} className="skeleton skel-row" style={{ height: 64 }} />)}</div>
      )}

      {!error && data && data.scored_count === 0 && (
        <div className="card section"><EmptyState icon={<Trophy size={40} color="#94a3b8" />} title="No points yet"
          hint="Points appear as soon as someone assigns, completes or comments on a task — or moves one along." /></div>
      )}

      {!error && data && data.scored_count > 0 && (
        <div className="lb-list section" style={refreshing ? { opacity: 0.6, transition: 'opacity .15s' } : { transition: 'opacity .15s' }}>
          {data.ranked.map((r: any) => (
            <RankCard key={r.id} row={r} rules={data.rules} onOpen={() => setDetailId(r.id)} />
          ))}
        </div>
      )}

      {detailId && <DetailModal userId={detailId} period={period} onClose={() => setDetailId(null)} />}
    </>
  )
}

function RankCard({ row, rules, onOpen }: { row: any; rules: any[]; onOpen: () => void }) {
  const ranked = row.score > 0
  const top3 = ranked && row.rank <= 3
  // The actions behind the total, so the card shows WHY without opening the modal.
  const chips = (rules || []).map((r: any) => ({ ...r, count: row.breakdown?.[r.key]?.count || 0 })).filter((r: any) => r.count > 0)
  return (
    <button className={'lb-card' + (row.rank === 1 ? ' champ' : '') + (ranked ? '' : ' idle')} onClick={onOpen}>
      <span className="lb-rank" style={{ color: top3 ? medalColor[row.rank - 1] : undefined }}>
        {row.rank === 1 ? <Trophy size={20} /> : ranked ? `#${row.rank}` : '–'}
      </span>
      <Avatar name={row.name} color={row.avatar_color} size={40} src={row.avatar_file ? userAvatarUrl(row.id, row.avatar_file) : undefined} />
      <div className="lb-who">
        <div className="lb-name">{row.name}</div>
        <div className="lb-sub muted">
          {chips.length === 0
            ? <span style={{ textTransform: 'capitalize' }}>{row.role}</span>
            : chips.map((c: any) => (
              <span key={c.key} className="lb-chip" style={{ ['--bc' as any]: ruleColor(c.key) }}>
                {c.count} {plural(c.short || c.label.toLowerCase(), c.count)}
              </span>
            ))}
        </div>
      </div>
      <div className="lb-winscore">
        <div className="lb-winscore-num" style={{ color: ranked ? '#f2622e' : '#94a3b8' }}>{row.score}</div>
        <div className="muted lb-winscore-lbl">{row.score === 1 ? 'point' : 'points'}</div>
      </div>
    </button>
  )
}

function DetailModal({ userId, period, onClose }: { userId: string; period: string; onClose: () => void }) {
  const [d, setD] = useState<any>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    setD(null); setError(false)
    api.get(`/scores/${userId}?period=${period}`).then(setD).catch(() => setError(true))
  }, [userId, period])

  // One row per rule: how many times they did it, and the points that earned.
  const rows = (d?.rules || []).map((r: any) => ({
    key: r.key, label: r.label, hint: r.hint,
    per: d?.breakdown?.[r.key]?.per ?? r.points ?? 1,
    count: d?.breakdown?.[r.key]?.count || 0,
    points: d?.breakdown?.[r.key]?.points || 0,
  }))
  const maxPoints = Math.max(1, ...rows.map((r: any) => r.points))
  const periodLabel = period === 'day' ? 'today' : period === 'all' ? 'all-time' : 'last 30 days'

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal lb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread">
          <h3>Points detail</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="card-pad">
        {error && <EmptyState icon={<Ic name="warning" size={36} />} title="Couldn't load this person" />}
        {!error && !d && <div style={{ display: 'grid', placeItems: 'center', height: 200 }}><span className="spinner" /></div>}
        {!error && d && (
          <>
            <div className="lb-modal-head">
              <Avatar name={d.user.name} color={d.user.avatar_color} size={48} src={d.user.avatar_file ? userAvatarUrl(d.user.id, d.user.avatar_file) : undefined} />
              <div style={{ minWidth: 0 }}>
                <div className="lb-modal-name">{d.user.name}</div>
                <div className="muted" style={{ fontSize: 12.5, textTransform: 'capitalize' }}>{d.user.role}</div>
              </div>
              <div className="lb-modal-rating">
                <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1, color: '#f2622e' }}>{d.points}</div>
                <div className="muted" style={{ fontSize: 11 }}>{periodLabel}</div>
              </div>
            </div>

            <div className="lb-modal-stats">
              <div className="lb-stat"><div className="lb-stat-num">{d.points}</div><div className="muted lb-stat-lbl">{periodLabel}</div></div>
              <div className="lb-stat"><div className="lb-stat-num">{d.all_time_points}</div><div className="muted lb-stat-lbl">all-time</div></div>
              <div className="lb-stat"><div className="lb-stat-num">{d.breakdown?.completed?.count ?? 0}</div><div className="muted lb-stat-lbl">tasks completed</div></div>
            </div>

            <div className="lb-section-lbl">Points per day (last 30 days)</div>
            {d.history?.some((h: any) => h.points > 0)
              ? <div className="lb-trajectory"><DayBars history={d.history} /></div>
              : <div className="muted" style={{ fontSize: 12.5 }}>No points earned in the last 30 days.</div>}

            <div className="lb-section-lbl">Where the points came from — {periodLabel}</div>
            <div className="lb-comps">
              {rows.map((s: any) => (
                <div key={s.key} className="lb-comp">
                  <div className="lb-comp-top">
                    <span className="lb-comp-key" title={s.hint}>{s.label}</span>
                    <span className="lb-comp-val">{s.count} × {s.per} = <b>{s.points}</b></span>
                  </div>
                  <Bar value={s.points} max={maxPoints} color={ruleColor(s.key)} />
                </div>
              ))}
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  )
}
