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
      {review && <ReviewAssignModal meeting={m} pending={pending} onChanged={load} onClose={() => { setReview(false); load() }} />}
    </>
  )
}

const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']

// Manager Review screen: edit each AI suggestion (priority, assignee, due, title)
// and approve them ONE BY ONE — every approval assigns that task & notifies the
// owner immediately, with no need to wait and assign the whole batch at the end.
type RowStatus = 'pending' | 'busy' | 'assigned' | 'rejected' | 'merged'
function ReviewAssignModal({ meeting, pending, onClose, onChanged }: { meeting: any; pending: Suggestion[]; onClose: () => void; onChanged: () => void }) {
  type Row = Suggestion & { _status: RowStatus; _error: string; _showMerge: boolean; _mergeInto: string }
  // Pre-fill each due date from priority (matching the server default) when the
  // AI didn't capture a deadline, so the manager sees the date before assigning.
  const [rows, setRows] = useState<Row[]>(pending.map((p) => ({
    ...p, due_date: p.due_date || defaultDueDate(p.priority), _status: 'pending', _error: '', _showMerge: false, _mergeInto: '',
  })))
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkErr, setBulkErr] = useState('')
  const participants: any[] = meeting.participants || []

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  // Approve ONE suggestion: save the manager's edits, then assign it right away.
  const approveAssign = async (i: number) => {
    const r = rows[i]
    if (!r.suggested_assignee_id) { set(i, { _error: 'Pick an assignee before approving.' }); return }
    set(i, { _status: 'busy', _error: '' })
    try {
      await api.patch(`/meetings/suggestions/${r.id}`, {
        title: r.title, suggested_assignee_id: r.suggested_assignee_id,
        priority: r.priority, due_date: r.due_date || null,
      })
      const res = await api.post(`/meetings/${meeting.id}/assign`, { ids: [r.id] })
      if (!res.assigned) { set(i, { _status: 'pending', _error: 'Could not assign — check the owner.' }); return }
      set(i, { _status: 'assigned' })
      onChanged() // refresh the meeting's "Assigned Tasks" list in the background
    } catch (e: any) { set(i, { _status: 'pending', _error: e.message }) }
  }

  const reject = async (i: number) => {
    const r = rows[i]
    set(i, { _status: 'busy', _error: '' })
    try { await api.post(`/meetings/suggestions/${r.id}/reject`); set(i, { _status: 'rejected' }); onChanged() }
    catch (e: any) { set(i, { _status: 'pending', _error: e.message }) }
  }

  const doMerge = async (i: number) => {
    const r = rows[i]
    if (!r._mergeInto) return
    set(i, { _status: 'busy', _error: '' })
    try { await api.post(`/meetings/suggestions/${r.id}/merge`, { into: r._mergeInto }); set(i, { _status: 'merged' }); onChanged() }
    catch (e: any) { set(i, { _status: 'pending', _error: e.message }) }
  }

  // Batch shortcut: save edits for every still-pending row that has an owner and
  // assign them all at once — so the manager isn't forced to click 20 rows.
  const assignAllRemaining = async () => {
    const targets = rows.filter((r) => r._status === 'pending' && r.suggested_assignee_id)
    if (!targets.length) return
    setBulkErr(''); setBulkBusy(true)
    const ids = new Set(targets.map((t) => t.id))
    setRows((rs) => rs.map((r) => (ids.has(r.id) ? { ...r, _status: 'busy', _error: '' } : r)))
    try {
      for (const r of targets) {
        await api.patch(`/meetings/suggestions/${r.id}`, {
          title: r.title, suggested_assignee_id: r.suggested_assignee_id,
          priority: r.priority, due_date: r.due_date || null,
        })
      }
      await api.post(`/meetings/${meeting.id}/assign`, { ids: targets.map((t) => t.id) })
      setRows((rs) => rs.map((r) => (ids.has(r.id) ? { ...r, _status: 'assigned' } : r)))
      onChanged()
    } catch (e: any) {
      setBulkErr(e.message)
      setRows((rs) => rs.map((r) => (ids.has(r.id) ? { ...r, _status: 'pending' } : r)))
    } finally { setBulkBusy(false) }
  }

  const done = rows.filter((r) => r._status === 'assigned' || r._status === 'rejected' || r._status === 'merged').length
  const assignedCount = rows.filter((r) => r._status === 'assigned').length
  const remaining = rows.length - done
  const pendingWithOwner = rows.filter((r) => r._status === 'pending' && r.suggested_assignee_id).length
  const noOwnerCount = rows.filter((r) => r._status === 'pending' && !r.suggested_assignee_id).length

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 920, width: '94%' }}>
        <div className="card-head spread"><h3>Review &amp; Assign Tasks</h3><button className="btn btn-ghost" onClick={onClose}>✕</button></div>
        <div className="card-pad grid" style={{ gap: 12, maxHeight: '70vh', overflow: 'auto' }}>
          {rows.map((r, i) => {
            // Once a row is acted on, collapse it into a compact confirmation strip.
            if (r._status === 'assigned' || r._status === 'rejected' || r._status === 'merged') {
              const label = r._status === 'assigned' ? '✓ Assigned & notified' : r._status === 'rejected' ? '✕ Rejected' : '⇉ Merged'
              const color = r._status === 'assigned' ? '#10b981' : r._status === 'rejected' ? '#ef4444' : '#7a6f63'
              return (
                <div key={r.id} className="spread" style={{ border: '1px solid #e7ddd1', borderRadius: 10, padding: '10px 12px', background: '#faf7f2' }}>
                  <span style={{ fontWeight: 600, textDecoration: r._status === 'assigned' ? 'none' : 'line-through', color: r._status === 'assigned' ? 'inherit' : '#9c9082' }}>{r.title}</span>
                  <span style={{ color, fontWeight: 700, fontSize: 13 }}>{label}</span>
                </div>
              )
            }
            const busy = r._status === 'busy'
            return (
              <div key={r.id} style={{ border: '1px solid ' + (r._error ? '#ef444466' : '#e7ddd1'), borderRadius: 10, padding: 12 }}>
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
                  {r._error && <div style={{ color: '#ef4444', fontSize: 12.5 }}>{r._error}</div>}
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => approveAssign(i)}>{busy ? <span className="spinner" /> : '✓ Approve & Assign'}</button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => reject(i)}>✕ Reject</button>
                    {!r._showMerge
                      ? <button className="btn btn-sm" disabled={busy} onClick={() => set(i, { _showMerge: true })}>⇉ Merge into…</button>
                      : (
                        <span className="row" style={{ gap: 4 }}>
                          <select value={r._mergeInto} onChange={(e) => set(i, { _mergeInto: e.target.value })}>
                            <option value="">choose task…</option>
                            {rows.filter((o) => o.id !== r.id && o._status === 'pending').map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                          </select>
                          <button className="btn btn-sm" disabled={busy || !r._mergeInto} onClick={() => doMerge(i)}>Merge</button>
                          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => set(i, { _showMerge: false, _mergeInto: '' })}>↩</button>
                        </span>
                      )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <div className="card-pad spread" style={{ borderTop: '1px solid #eee' }}>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {assignedCount} assigned · {remaining} left{noOwnerCount ? ` · ${noOwnerCount} need an owner` : ''}
            {bulkErr && <span style={{ color: '#ef4444', marginLeft: 8 }}>{bulkErr}</span>}
          </div>
          <div className="row">
            <button className="btn" onClick={onClose}>{remaining === 0 ? 'Close' : 'Done'}</button>
            <button className="btn btn-primary" disabled={bulkBusy || !pendingWithOwner} onClick={assignAllRemaining}>
              {bulkBusy ? <span className="spinner" /> : `Assign all remaining (${pendingWithOwner})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
