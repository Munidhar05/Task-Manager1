import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { PriorityBadge, StatusBadge, dueLabel } from '../ui'
import TaskDrawer from '../components/TaskDrawer'

interface Msg { role: 'user' | 'ai'; text: string; tasks?: any[] }

export default function Assistant() {
  const [msgs, setMsgs] = useState<Msg[]>([{ role: 'ai', text: 'Hi! I\'m your task assistant. Ask me about overdue work, who owns a task, workload, or request a status report.' }])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => { api.get('/assistant/suggestions').then((d) => setSuggestions(d.suggestions)) }, [])
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [msgs])

  const send = async (q: string) => {
    if (!q.trim()) return
    setInput(''); setBusy(true)
    setMsgs((m) => [...m, { role: 'user', text: q }])
    try {
      const r = await api.post('/assistant/query', { query: q })
      setMsgs((m) => [...m, { role: 'ai', text: r.answer, tasks: r.tasks }])
    } catch (e: any) {
      setMsgs((m) => [...m, { role: 'ai', text: 'Error: ' + e.message }])
    } finally { setBusy(false) }
  }

  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="chat">
        <div className="chat-log" ref={logRef}>
          {msgs.map((m, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 8 }}>
              <div className={'bubble ' + m.role}>{m.text}</div>
              {m.tasks && m.tasks.length > 0 && (
                <div className="card" style={{ maxWidth: '80%', width: '100%' }}>
                  <table>
                    <tbody>
                      {m.tasks.map((t: any) => (
                        <tr key={t.id} className="clickable" onClick={() => setOpenId(t.id)}>
                          <td><div style={{ fontWeight: 600, fontSize: 13 }}>{t.title}</div><div className="muted" style={{ fontSize: 11.5 }}>{t.assignee_name || 'Unassigned'} · {dueLabel(t)}</div></td>
                          <td style={{ textAlign: 'right' }}><PriorityBadge p={t.priority} /> <StatusBadge s={t.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
          {busy && <div className="bubble ai"><span className="spinner" /></div>}
        </div>
        <div>
          {suggestions.length > 0 && (
            <div className="suggestions">
              {suggestions.map((s) => <span key={s} className="suggestion" onClick={() => send(s)}>{s}</span>)}
            </div>
          )}
          <div className="chat-input">
            <input placeholder="Ask about your tasks…" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send(input)} autoFocus />
            <button className="btn btn-primary" onClick={() => send(input)} disabled={busy}>Send</button>
          </div>
        </div>
      </div>
      {openId && <TaskDrawer taskId={openId} onClose={() => setOpenId(null)} />}
    </div>
  )
}
