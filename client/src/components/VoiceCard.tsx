import React from 'react'
import { useNavigate } from 'react-router-dom'
import { VoiceCardData } from '../voice/useVoiceAssistant'

// Renders the figures a read tool returned (overview / workload / grouping) as a
// compact card inside the voice panel, so "yesterday's overview" is something you
// can SEE and click into — not just a sentence that scrolls past.
//
// The numbers come straight from the server's SQL; nothing is recomputed here.

// A KPI tile. `to` makes it a drill-through into the matching filtered list.
function Tile({ value, label, color, to }: { value: number; label: string; color?: string; to?: string }) {
  const navigate = useNavigate()
  const clickable = !!to && value > 0
  return (
    <div
      className={'vc-tile' + (clickable ? ' clickable' : '')}
      onClick={clickable ? () => navigate(to!) : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(to!) } } : undefined}
      title={clickable ? `Open ${label.toLowerCase()}` : undefined}
    >
      <div className="vc-tile-value" style={color ? { color } : undefined}>{value}</div>
      <div className="vc-tile-label">{label}</div>
    </div>
  )
}

// A labelled count row with a proportional bar (workload / grouping).
function Bars({ rows }: { rows: { label?: string; name?: string; c: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.c))
  return (
    <div className="vc-bars">
      {rows.slice(0, 8).map((r, i) => (
        <div className="vc-bar-row" key={i}>
          <span className="vc-bar-label">{r.label ?? r.name ?? '—'}</span>
          <span className="vc-bar-track"><span className="vc-bar-fill" style={{ width: `${Math.round((r.c / max) * 100)}%` }} /></span>
          <b className="vc-bar-val">{r.c}</b>
        </div>
      ))}
    </div>
  )
}

export default function VoiceCard({ data }: { data: VoiceCardData }) {
  if (data.type === 'overview') {
    const s = data.stats || {}
    return (
      <div className="vc">
        <div className="vc-head">{data.label} overview</div>
        <div className="vc-grid">
          <Tile value={s.created ?? 0} label="Created" />
          <Tile value={s.assigned ?? 0} label="Assigned" />
          <Tile value={s.completed ?? 0} label="Completed" color="#10b981" to="/tasks?view=completed" />
          <Tile value={s.open ?? 0} label="Open" to="/tasks?view=active" />
          <Tile value={s.overdue ?? 0} label="Overdue" color="#ef4444" to="/tasks?view=overdue" />
          <Tile value={s.blocked ?? 0} label="Blocked" color="#f59e0b" to="/tasks?status=Blocked" />
        </div>
      </div>
    )
  }

  const rows = data.rows || []
  if (!rows.length) return null
  return (
    <div className="vc">
      <div className="vc-head">
        {data.type === 'workload' ? 'Open tasks per person' : data.title}
        {typeof data.total === 'number' && <span className="vc-total">{data.total}</span>}
      </div>
      <Bars rows={rows} />
    </div>
  )
}
