import React, { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api, Suggestion } from '../api'
import { PriorityBadge, StatusBadge, ConfidenceScore, Avatar, dueLabel, LANG_LABEL, defaultDueDate } from '../ui'
import TaskDrawer from '../components/TaskDrawer'

const SUMMARY_SECTIONS: { key: string; label: string; icon: string }[] = [
  { key: 'key_decisions', label: 'Key Decisions', icon: '✓' },
  { key: 'action_items', label: 'Action Items', icon: '→' },
  { key: 'risks', label: 'Risks', icon: '⚠' },
  { key: 'blockers', label: 'Blockers', icon: '⛔' },
  { key: 'follow_ups', label: 'Follow-ups', icon: '↻' },
]

export default function MeetingDetail() {
  const { id } = useParams()
  const [m, setM] = useState<any>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [tab, setTab] = useState<'summary' | 'transcript'>('summary')
  const [review, setReview] = useState(false)
  const load = () => api.get('/meetings/' + id).then(setM)
  useEffect(() => { load() }, [id])
  if (!m) return <span className="spinner" />
  const s = m.summary || {}
  const pending: Suggestion[] = (m.suggestions || []).filter((x: Suggestion) => x.status === 'pending')

  return (
    <>
      <Link to="/meetings" className="muted" style={{ fontSize: 13 }}>← All meetings</Link>
      <div className="spread" style={{ margin: '8px 0 8px' }}>
        <div>
          <h1 style={{ fontSize: 22 }}>{m.title}</h1>
          <div className="muted row" style={{ fontSize: 13 }}>
            {(m.meeting_date || '').slice(0, 10)} · engine: {m.engine}
            <span className="tag-list">{(m.detected_languages || []).map((l: string) => <span key={l} className="lang-tag">{LANG_LABEL[l] || l}</span>)}</span>
          </div>
        </div>
        <div className="row">
          <button className={'btn btn-sm' + (tab === 'summary' ? ' btn-primary' : '')} onClick={() => setTab('summary')}>Summary & Tasks</button>
          <button className={'btn btn-sm' + (tab === 'transcript' ? ' btn-primary' : '')} onClick={() => setTab('transcript')}>Transcript</button>
        </div>
      </div>

      {m.description && <p className="muted" style={{ marginTop: 0, maxWidth: 760 }}>{m.description}</p>}

      {/* Participants */}
      {(m.participants || []).length > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>Participants:</span>
          {m.participants.map((p: any) => (
            <span key={p.id} className="row" style={{ gap: 5, fontSize: 12.5 }}><Avatar name={p.name} color={p.avatar_color} size={20} /> {p.name}</span>
          ))}
        </div>
      )}

      {tab === 'summary' ? (
        <div className="grid grid-2">
          <div>
            <div className="card section">
              <div className="card-head"><h3>✦ Executive Summary</h3></div>
              <div className="card-pad">{s.executive_summary || 'No summary generated.'}</div>
            </div>

            {/* AI Review Queue */}
            {pending.length > 0 && (
              <div className="card section">
                <div className="card-head spread">
                  <h3>🤖 AI Suggested Tasks — Pending Review ({pending.length})</h3>
                  <button className="btn btn-primary btn-sm" onClick={() => setReview(true)}>Review &amp; Assign Tasks</button>
                </div>
                <div className="card-pad grid" style={{ gap: 10 }}>
                  {pending.map((sg) => (
                    <div key={sg.id} style={{ border: '1px solid ' + (sg.confidence < 50 ? '#f59e0b66' : '#e7ddd1'), borderRadius: 10, padding: 12, background: sg.confidence < 50 ? '#fffbeb' : '#fff' }}>
                      <div className="spread">
                        <div style={{ fontWeight: 600 }}>{sg.title}</div>
                        <PriorityBadge p={sg.priority} />
                      </div>
                      <div className="row" style={{ gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
                        <span className="row" style={{ gap: 5, fontSize: 12.5 }}>
                          {sg.suggested_assignee_name
                            ? <><Avatar name={sg.suggested_assignee_name} color={sg.suggested_assignee_color || undefined} size={18} /> {sg.suggested_assignee_name}</>
                            : <span style={{ color: '#b45309' }}>⚠ {sg.suggested_assignee_raw ? `“${sg.suggested_assignee_raw}” (not an attendee)` : 'No owner suggested'}</span>}
                        </span>
                        <ConfidenceScore score={sg.confidence} />
                        <span className="muted" style={{ fontSize: 12 }}>{dueLabel(sg)}</span>
                      </div>
                      {sg.assignee_reasoning && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>💡 {sg.assignee_reasoning}</div>}
                      {sg.source_quote && <div className="muted" style={{ fontSize: 11.5, marginTop: 4, fontStyle: 'italic' }}>“{sg.source_quote}”</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Assigned tasks */}
            <div className="card section">
              <div className="card-head"><h3>Assigned Tasks ({m.tasks.length})</h3></div>
              <table>
                <tbody>
                  {m.tasks.map((t: any) => (
                    <tr key={t.id} className="clickable" onClick={() => setOpenId(t.id)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{t.title}</div>
                        <div className="muted" style={{ fontSize: 11.5 }}>{t.assignee_name || t.assignee_name_raw || 'Unassigned'} · {dueLabel(t)}</div>
                      </td>
                      <td style={{ textAlign: 'right' }}><PriorityBadge p={t.priority} /><br /><StatusBadge s={t.status} /></td>
                    </tr>
                  ))}
                  {m.tasks.length === 0 && <tr><td className="muted">No tasks assigned yet. Review the AI suggestions above.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            {SUMMARY_SECTIONS.map((sec) => {
              const items: string[] = s[sec.key] || []
              if (!items.length) return null
              return (
                <div key={sec.key} className="card section">
                  <div className="card-head"><h3>{sec.icon} {sec.label} ({items.length})</h3></div>
                  <div className="card-pad">
                    <ul style={{ margin: 0, paddingLeft: 18 }}>{items.map((it, i) => <li key={i} style={{ marginBottom: 6, fontSize: 13.5 }}>{it}</li>)}</ul>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-pad">
            {m.segments.map((seg: any) => (
              <div key={seg.id} className="segment">
                <div className="speaker">{seg.speaker}{seg.language && <span className="lang-tag">{seg.language}</span>}</div>
                <div>{seg.text}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {openId && <TaskDrawer taskId={openId} onClose={() => setOpenId(null)} onChange={load} />}
      {review && <ReviewAssignModal meeting={m} pending={pending} onClose={() => setReview(false)} onDone={() => { setReview(false); load() }} />}
    </>
  )
}

const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']

// Manager Review screen: edit / reject / merge AI suggestions, then assign them.
function ReviewAssignModal({ meeting, pending, onClose, onDone }: { meeting: any; pending: Suggestion[]; onClose: () => void; onDone: () => void }) {
  type Row = Suggestion & { _decision: 'approve' | 'reject' | 'merge'; _mergeInto: string }
  // Pre-fill each due date from priority (matching the server default) when the
  // AI didn't capture a deadline, so the manager sees the date before assigning.
  const [rows, setRows] = useState<Row[]>(pending.map((p) => ({
    ...p, due_date: p.due_date || defaultDueDate(p.priority), _decision: 'approve', _mergeInto: '',
  })))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const participants: any[] = meeting.participants || []

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  const willAssign = rows.filter((r) => r._decision === 'approve' && r.suggested_assignee_id)
  const noOwner = rows.filter((r) => r._decision === 'approve' && !r.suggested_assignee_id)

  const apply = async () => {
    setErr(''); setBusy(true)
    try {
      for (const r of rows) {
        if (r._decision === 'reject') {
          await api.post(`/meetings/suggestions/${r.id}/reject`)
        } else if (r._decision === 'merge' && r._mergeInto) {
          await api.post(`/meetings/suggestions/${r.id}/merge`, { into: r._mergeInto })
        } else {
          await api.patch(`/meetings/suggestions/${r.id}`, {
            title: r.title, suggested_assignee_id: r.suggested_assignee_id || null,
            priority: r.priority, due_date: r.due_date || null,
          })
        }
      }
      await api.post(`/meetings/${meeting.id}/assign`, { ids: willAssign.map((r) => r.id) })
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 920, width: '94%' }}>
        <div className="card-head spread"><h3>Review &amp; Assign Tasks</h3><button className="btn btn-ghost" onClick={onClose}>✕</button></div>
        <div className="card-pad grid" style={{ gap: 12, maxHeight: '70vh', overflow: 'auto' }}>
          {rows.map((r, i) => (
            <div key={r.id} style={{ border: '1px solid #e7ddd1', borderRadius: 10, padding: 12, opacity: r._decision === 'approve' ? 1 : 0.6 }}>
              <div className="grid" style={{ gap: 8 }}>
                <div className="spread" style={{ gap: 8 }}>
                  <input value={r.title} onChange={(e) => set(i, { title: e.target.value })} style={{ fontWeight: 600 }} />
                  <ConfidenceScore score={r.confidence} />
                </div>
                <div className="grid grid-3" style={{ gap: 8 }}>
                  <div>
                    <label>Assignee</label>
                    <select value={r.suggested_assignee_id || ''} onChange={(e) => set(i, { suggested_assignee_id: e.target.value || null })}>
                      <option value="">— Unassigned —</option>
                      {participants.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div><label>Priority</label><select value={r.priority} onChange={(e) => set(i, { priority: e.target.value, due_date: defaultDueDate(e.target.value) })}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></div>
                  <div><label>Due date</label><input type="date" value={(r.due_date || '').slice(0, 10)} onChange={(e) => set(i, { due_date: e.target.value })} /></div>
                </div>
                {r.assignee_reasoning && <div className="muted" style={{ fontSize: 12 }}>💡 {r.assignee_reasoning}</div>}
                {r.source_quote && <div className="muted" style={{ fontSize: 11.5, fontStyle: 'italic' }}>“{r.source_quote}”</div>}
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button className={'btn btn-sm' + (r._decision === 'approve' ? ' btn-primary' : '')} onClick={() => set(i, { _decision: 'approve' })}>✓ Approve</button>
                  <button className={'btn btn-sm' + (r._decision === 'reject' ? ' btn-danger' : '')} onClick={() => set(i, { _decision: 'reject' })}>✕ Reject</button>
                  <div className="row" style={{ gap: 4 }}>
                    <button className={'btn btn-sm' + (r._decision === 'merge' ? ' btn-primary' : '')} onClick={() => set(i, { _decision: 'merge' })}>⇉ Merge into</button>
                    {r._decision === 'merge' && (
                      <select value={r._mergeInto} onChange={(e) => set(i, { _mergeInto: e.target.value })}>
                        <option value="">choose task…</option>
                        {rows.filter((o) => o.id !== r.id).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                      </select>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {err && <div style={{ color: '#ef4444', fontSize: 13 }}>{err}</div>}
        </div>
        <div className="card-pad spread" style={{ borderTop: '1px solid #eee' }}>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {willAssign.length} task(s) will be assigned & notified{noOwner.length ? ` · ${noOwner.length} approved without an owner will be skipped` : ''}
          </div>
          <div className="row">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={apply} disabled={busy || !willAssign.length}>{busy ? <span className="spinner" /> : `Assign ${willAssign.length} task(s)`}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
