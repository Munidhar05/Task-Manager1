import { useEffect, useState } from 'react'
import { api, userAvatarUrl } from '../api'
import { useAuth } from '../auth'
import { Avatar, Ic, EmptyState, Bar } from '../ui'

// Engagement leaderboard. Everyone in the org is listed and scored 0-100 by their
// ROLE's rubric (employees on execution, managers on orchestration), then ranked.
// Daily / monthly / all-time; monthly & all-time are averages of daily scores, so
// consistency beats raw volume. Clicking a card shows the section breakdown —
// exactly which parts of the 100 the person earned. Scores come from /api/scores.

const PERIODS = [
  { k: 'day', label: 'Daily', hint: "latest scored day" },
  { k: 'month', label: 'Monthly', hint: '30-day average' },
  { k: 'all', label: 'All-time', hint: 'average of every scored day' },
]

// Score → hue. Green strong, amber middling, red weak. Concrete colours so they
// work in inline SVG/gradient contexts (matches ui.tsx convention).
function scoreColor(s: number | null): string {
  if (s == null) return '#94a3b8'
  if (s >= 75) return '#0f9d6e'
  if (s >= 55) return '#2f9e6e'
  if (s >= 40) return '#d98a0b'
  if (s >= 20) return '#e07a0b'
  return '#e2483a'
}

const medalColor = ['#d4af37', '#a8b3c4', '#c8823c'] // gold / silver / bronze

const Trophy = ({ size = 16, color = '#d4af37' }: { size?: number; color?: string }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z" /><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 0-3 3" />
  </svg>
)

// Sparkline of daily score over time.
function Spark({ points, color = '#2f6fd0', w = 120, h = 30 }: { points: number[]; color?: string; w?: number; h?: number }) {
  if (!points.length) return <svg width={w} height={h} />
  const min = Math.min(...points, 0), max = Math.max(...points, 100)
  const span = max - min || 1
  const step = points.length > 1 ? w / (points.length - 1) : 0
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${(h - 4 - ((p - min) / span) * (h - 8)).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h} className="lb-spark" aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const isManager = (u: any) => u?.role !== 'employee'

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
  const periodLabel = PERIODS.find((p) => p.k === period)?.label ?? ''
  // Active-days is a manager-only stat (how much someone shows up), not scored.
  const showActiveDays = isManager(user)

  return (
    <>
      <div className="lb-toolbar section">
        <div className="muted" style={{ fontSize: 13 }}>
          Everyone scored 0–100 by their role. {period === 'day' ? 'Latest scored day.' : 'Average of daily scores — consistency, not volume.'}
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
        <div className="card section"><EmptyState icon={<Trophy size={40} color="#94a3b8" />} title="No scores yet"
          hint="Scores appear once people start completing, commenting on, and assigning work. Come back after a day of activity." /></div>
      )}

      {!error && data && data.scored_count > 0 && (
        <div className="lb-list section" style={refreshing ? { opacity: 0.6, transition: 'opacity .15s' } : { transition: 'opacity .15s' }}>
          {data.ranked.map((r: any) => (
            <RankCard key={r.id} row={r} period={period} periodLabel={periodLabel}
              showActiveDays={showActiveDays}
              topReceived={data.top_received} topCompleted={data.top_completed}
              onOpen={() => setDetailId(r.id)} />
          ))}
        </div>
      )}

      {detailId && <DetailModal userId={detailId} period={period} onClose={() => setDetailId(null)} />}
    </>
  )
}

function RankCard({ row, period, periodLabel, showActiveDays, topReceived, topCompleted, onOpen }: {
  row: any; period: string; periodLabel: string; showActiveDays: boolean; topReceived: any; topCompleted: any; onOpen: () => void
}) {
  const ranked = row.score != null
  const top3 = ranked && row.rank <= 3
  const badges = []
  if (topCompleted && topCompleted.user_id === row.id && topCompleted.count > 0) badges.push({ t: `Top completer · ${topCompleted.count}`, c: '#0f9d6e' })
  if (topReceived && topReceived.user_id === row.id && topReceived.count > 0) badges.push({ t: `Most assigned · ${topReceived.count}`, c: '#2f6fd0' })
  return (
    <button className={'lb-card' + (row.rank === 1 ? ' champ' : '') + (ranked ? '' : ' idle')} onClick={onOpen}>
      <span className="lb-rank" style={{ color: top3 ? medalColor[row.rank - 1] : undefined }}>
        {row.rank === 1 ? <Trophy size={20} /> : ranked ? `#${row.rank}` : '–'}
      </span>
      <Avatar name={row.name} color={row.avatar_color} size={40} src={row.avatar_file ? userAvatarUrl(row.id, row.avatar_file) : undefined} />
      <div className="lb-who">
        <div className="lb-name">
          {row.name}
          {badges.map((b) => <span key={b.t} className="lb-badge" style={{ ['--bc' as any]: b.c }}>{b.t}</span>)}
        </div>
        <div className="lb-sub muted" style={{ textTransform: 'capitalize' }}>
          {row.role}
          {showActiveDays && row.active_days > 0 ? ` · active ${row.active_days} day${row.active_days === 1 ? '' : 's'}` : ''}
        </div>
      </div>
      <div className="lb-winscore">
        <div className="lb-winscore-num" style={{ color: scoreColor(row.score) }}>{row.score ?? '–'}<span className="muted" style={{ fontSize: 11 }}>/100</span></div>
        <div className="muted lb-winscore-lbl">{period === 'day' ? 'today' : periodLabel.toLowerCase()}</div>
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

  const latest = d?.latest
  const bd = latest?.breakdown || {}
  // Section rows from the person's own rubric, filled with the latest day's points.
  const sections = (d?.sections || []).map((s: any) => ({
    key: s.key, label: s.label, cap: s.cap,
    capped: bd[s.key]?.capped ?? 0,
  }))

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal lb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread">
          <h3>Performance detail</h3>
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
                <div className="muted" style={{ fontSize: 12.5, textTransform: 'capitalize' }}>{d.user.role} · scored on the {isManagerRole(d.user.role) ? 'manager' : 'employee'} rubric</div>
              </div>
              <div className="lb-modal-rating">
                <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1, color: scoreColor(d.period_score) }}>{d.period_score ?? '–'}</div>
                <div className="muted" style={{ fontSize: 11 }}>{period === 'day' ? 'latest day' : period === 'all' ? 'all-time avg' : '30-day avg'}</div>
              </div>
            </div>

            <div className="lb-modal-stats">
              <div className="lb-stat"><div className="lb-stat-num">{latest ? latest.day_score : '–'}</div><div className="muted lb-stat-lbl">latest day</div></div>
              <div className="lb-stat"><div className="lb-stat-num">{d.active_days}</div><div className="muted lb-stat-lbl">active days</div></div>
              <div className="lb-stat"><div className="lb-stat-num">{d.tasks_done_total}</div><div className="muted lb-stat-lbl">tasks completed</div></div>
            </div>

            <div className="lb-section-lbl">Daily score over time</div>
            {d.history.length > 1
              ? <div className="lb-trajectory"><Spark points={d.history.map((h: any) => h.day_score)} color={scoreColor(d.period_score)} w={320} h={54} /></div>
              : <div className="muted" style={{ fontSize: 12.5 }}>Not enough history yet to chart.</div>}

            <div className="lb-section-lbl">Latest day — where the points came from{latest ? ` (${latest.day})` : ''}</div>
            {sections.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>No scored day yet.</div>}
            <div className="lb-comps">
              {sections.map((s: any) => (
                <div key={s.key} className="lb-comp">
                  <div className="lb-comp-top"><span className="lb-comp-key">{s.label}</span>
                    <span className="lb-comp-val">{s.capped} / {s.cap}</span></div>
                  <Bar value={s.capped} max={s.cap} color="#f2622e" />
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

const isManagerRole = (role: string) => role !== 'employee'
