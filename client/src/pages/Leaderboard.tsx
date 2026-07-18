import React, { useEffect, useState } from 'react'
import { api, userAvatarUrl } from '../api'
import { useAuth } from '../auth'
import { Avatar, Ic, EmptyState, Bar } from '../ui'

// Performance leaderboard. Everyone in the org is listed; those with enough recent
// activity are ranked by their all-time rating (0-1000, self-correcting). Clicking a
// card opens a breakdown of WHY that score is what it is. Scores come from
// /api/scores (see server/src/performance.js).

const WINDOWS = [
  { d: 7, label: '7d', hint: 'this week (noisy)' },
  { d: 30, label: '30d', hint: 'monthly view' },
  { d: 90, label: '90d', hint: 'quarterly' },
]

// Rating → hue. Green strong, amber middling, red weak. Kept as concrete colors so
// they work in inline SVG/gradient contexts (matches the app's ui.tsx convention).
function ratingColor(r: number | null): string {
  if (r == null) return '#94a3b8'
  if (r >= 750) return '#0f9d6e'
  if (r >= 650) return '#2f9e6e'
  if (r >= 550) return '#d98a0b'
  if (r >= 450) return '#e07a0b'
  return '#e2483a'
}

const medalColor = ['#d4af37', '#a8b3c4', '#c8823c'] // gold / silver / bronze for ranks 1-3

// A tiny inline trophy for the #1 employee (the app avoids emoji in UI chrome).
const Trophy = ({ size = 16, color = '#d4af37' }: { size?: number; color?: string }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z" /><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 0-3 3" />
  </svg>
)

// Weekly trend chip: ▲ +n / ▼ -n / – flat.
function TrendChip({ trend }: { trend: any }) {
  if (!trend || trend.delta == null) return <span className="lb-trend flat" title="Not enough data yet">–</span>
  const up = trend.direction === 'up', down = trend.direction === 'down'
  return (
    <span className={'lb-trend ' + trend.direction} title={`This week vs last: ${trend.delta > 0 ? '+' : ''}${trend.delta} pts`}>
      {up ? '▲' : down ? '▼' : '–'} {trend.delta > 0 ? '+' : ''}{trend.delta}
    </span>
  )
}

// Sparkline of rating over time.
function Spark({ points, color = '#2f6fd0', w = 120, h = 30 }: { points: number[]; color?: string; w?: number; h?: number }) {
  if (!points.length) return <svg width={w} height={h} />
  const min = Math.min(...points), max = Math.max(...points)
  const span = max - min || 1
  const step = points.length > 1 ? w / (points.length - 1) : 0
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${(h - 4 - ((p - min) / span) * (h - 8)).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h} className="lb-spark" aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function Leaderboard() {
  const { user } = useAuth()
  const [win, setWin] = useState(30)
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  // Window switches keep the current list on screen (slightly dimmed) and swap
  // the data in place — nulling it would flash the page back to skeletons.
  const [refreshing, setRefreshing] = useState(false)
  const load = () => {
    setError(false); setRefreshing(true)
    api.get(`/scores/leaderboard?window=${win}`).then(setData).catch(() => setError(true)).finally(() => setRefreshing(false))
  }
  useEffect(load, [win])

  if (!user) return null

  return (
    <>
      <div className="lb-toolbar section">
        <div className="muted" style={{ fontSize: 13 }}>
          Ranked by all-time rating. Employees with fewer than {data?.min_tasks_to_rank ?? 5} tasks in the window aren't ranked.
        </div>
        <div className="lb-winsel" role="tablist" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button key={w.d} role="tab" aria-selected={win === w.d} title={w.hint}
              className={'lb-win-btn' + (win === w.d ? ' active' : '')} onClick={() => setWin(w.d)}>{w.label}</button>
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

      {!error && data && data.ranked.length === 0 && (
        <div className="card section"><EmptyState icon={<Trophy size={40} color="#94a3b8" />} title="No one's ranked yet"
          hint={`Ratings appear once employees have at least ${data.min_tasks_to_rank} tasks in the selected window. Keep completing work and check back.`} /></div>
      )}

      {!error && data && data.ranked.length > 0 && (
        <div className="lb-list section" style={refreshing ? { opacity: 0.6, transition: 'opacity .15s' } : { transition: 'opacity .15s' }}>
          {data.ranked.map((r: any) => (
            <RankCard key={r.id} row={r} onOpen={() => setDetailId(r.id)} />
          ))}
        </div>
      )}

      {!error && data && data.unranked.length > 0 && (
        <div className="card section">
          <div className="card-head"><h3>Not enough activity</h3></div>
          <div className="lb-unranked">
            {data.unranked.map((u: any) => (
              <button key={u.id} className="lb-unranked-chip" onClick={() => setDetailId(u.id)} title="View detail">
                <Avatar name={u.name} color={u.avatar_color} size={22} src={u.avatar_file ? userAvatarUrl(u.id, u.avatar_file) : undefined} />
                <span className="lb-unranked-name">{u.name}</span>
                <span className="muted" style={{ fontSize: 11 }}>{u.assigned_in_window} task{u.assigned_in_window === 1 ? '' : 's'}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {detailId && <DetailModal userId={detailId} window={win} onClose={() => setDetailId(null)} />}
    </>
  )
}

function RankCard({ row, onOpen }: { row: any; onOpen: () => void }) {
  const top3 = row.rank <= 3
  return (
    <button className={'lb-card' + (row.rank === 1 ? ' champ' : '')} onClick={onOpen}>
      <span className="lb-rank" style={{ color: top3 ? medalColor[row.rank - 1] : undefined }}>
        {row.rank === 1 ? <Trophy size={20} /> : `#${row.rank}`}
      </span>
      <Avatar name={row.name} color={row.avatar_color} size={40} src={row.avatar_file ? userAvatarUrl(row.id, row.avatar_file) : undefined} />
      <div className="lb-who">
        <div className="lb-name">{row.name}</div>
        <div className="lb-sub muted">{row.role}{row.latest_score != null ? ` · latest day ${row.latest_score}` : ''}</div>
      </div>
      <div className="lb-rating">
        <div className="lb-rating-num" style={{ color: ratingColor(row.rating) }}>{row.rating}</div>
        <div className="lb-rating-lbl muted">rating</div>
      </div>
      <div className="lb-winscore">
        <div className="lb-winscore-num">{row.window_score ?? '–'}<span className="muted" style={{ fontSize: 11 }}>/100</span></div>
        <div className="muted lb-winscore-lbl">{row.window_days_scored}d scored</div>
      </div>
      <TrendChip trend={row.trend} />
    </button>
  )
}

function DetailModal({ userId, window: win, onClose }: { userId: string; window: number; onClose: () => void }) {
  const [d, setD] = useState<any>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    setD(null); setError(false)
    api.get(`/scores/${userId}?window=${win}`).then(setD).catch(() => setError(true))
  }, [userId, win])

  const agg = d?.aggregate
  const pct = (v: number | null) => (v == null ? null : Math.round(v * 100))
  const comps = agg ? [
    { key: 'On-time', value: pct(agg.on_time_rate), suffix: '%', color: '#0f9d6e', note: 'completed by due date' },
    { key: 'Throughput', value: agg.avg_weighted == null ? null : Math.round(agg.avg_weighted * 10) / 10, suffix: ' wtd/day', color: '#2f6fd0', note: 'priority-weighted output' },
    { key: 'Quality', value: pct(agg.quality_rate), suffix: '%', color: '#8b5cf6', note: 'not reopened / rejected' },
    { key: 'Engagement', value: pct(agg.avg_engagement), suffix: '%', color: '#d98a0b', note: 'meetings, chat, comments' },
    { key: 'Overdue penalty', value: agg.avg_penalty == null ? null : Math.round(agg.avg_penalty * 10) / 10, suffix: ' pts/day', color: '#e2483a', note: 'late open tasks (deduction)' },
  ] : []

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal lb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread">
          <h3>Performance detail</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="card-pad">
        {error && <EmptyState icon={<Ic name="warning" size={36} />} title="Couldn't load this employee" />}
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
                <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1, color: ratingColor(d.rating) }}>{d.rating ?? '–'}</div>
                <div className="muted" style={{ fontSize: 11 }}>all-time rating</div>
              </div>
            </div>

            <div className="lb-modal-stats">
              <div className="lb-stat"><div className="lb-stat-num">{d.window_score ?? '–'}</div><div className="muted lb-stat-lbl">{win}d avg score</div></div>
              <div className="lb-stat"><div className="lb-stat-num">{agg?.tasks_done ?? 0}</div><div className="muted lb-stat-lbl">tasks done ({win}d)</div></div>
              <div className="lb-stat"><TrendChip trend={d.trend} /><div className="muted lb-stat-lbl">weekly trend</div></div>
            </div>

            <div className="lb-section-lbl">Rating over time</div>
            {d.history.length > 1
              ? <div className="lb-trajectory"><Spark points={d.history.map((h: any) => h.rating_after)} color={ratingColor(d.rating)} w={320} h={54} /></div>
              : <div className="muted" style={{ fontSize: 12.5 }}>Not enough history yet to chart.</div>}

            <div className="lb-section-lbl">Why this score ({win}-day averages)</div>
            <div className="lb-comps">
              {comps.map((c) => (
                <div key={c.key} className="lb-comp">
                  <div className="lb-comp-top"><span className="lb-comp-key">{c.key}</span>
                    <span className="lb-comp-val">{c.value == null ? '—' : `${c.value}${c.suffix}`}</span></div>
                  {c.suffix === '%' && c.value != null && <Bar value={c.value} max={100} color={c.color} />}
                  <div className="lb-comp-note muted">{c.note}</div>
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
