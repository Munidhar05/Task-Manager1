import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { PriorityBadge, StatusBadge, dueLabel } from '../ui'
import TaskDrawer from '../components/TaskDrawer'

interface Msg { role: 'user' | 'ai'; text: string; tasks?: any[] }
interface Convo { id: string; title: string; msgs: Msg[]; updated: number }

const GREETING: Msg = { role: 'ai', text: 'Hi! I\'m your task assistant. Ask me anything about your tasks, deadlines, meetings, or your team\'s workload — in plain language.' }

function relTime(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}

export default function Assistant() {
  const { user } = useAuth()
  const [convos, setConvos] = useState<Convo[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem('smarttask_chat_sidebar_collapsed') === '1')
  const logRef = useRef<HTMLDivElement>(null)

  const setSidebar = (c: boolean) => { setCollapsed(c); localStorage.setItem('smarttask_chat_sidebar_collapsed', c ? '1' : '0') }

  const active = useMemo(() => convos.find((c) => c.id === activeId) || convos[0], [convos, activeId])
  const msgs = active?.msgs || []

  // One-time migration of any chats saved in the old localStorage store.
  const migrateLocal = async (serverConvos: Convo[]): Promise<Convo[]> => {
    if (serverConvos.length) return serverConvos
    try {
      const raw = localStorage.getItem(`smarttask_chats_${user?.id}`)
      const local: Convo[] = raw ? JSON.parse(raw) : []
      const meaningful = (local || []).filter((c) => c.msgs?.some((m) => m.role === 'user'))
      if (!meaningful.length) return serverConvos
      const created: Convo[] = []
      for (const c of meaningful) created.push(await api.post('/assistant/conversations', { title: c.title, msgs: c.msgs }))
      localStorage.removeItem(`smarttask_chats_${user?.id}`)
      return created
    } catch { return serverConvos }
  }

  // Load conversations from the server (synced across devices).
  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        let { conversations } = await api.get('/assistant/conversations')
        conversations = await migrateLocal(conversations)
        if (!conversations.length) {
          conversations = [await api.post('/assistant/conversations', { title: 'New chat', msgs: [GREETING] })]
        }
        if (cancel) return
        setConvos(conversations)
        setActiveId(conversations[0].id)
      } catch {
        if (!cancel) { const c: Convo = { id: 'local', title: 'New chat', msgs: [GREETING], updated: Date.now() }; setConvos([c]); setActiveId(c.id) }
      } finally { if (!cancel) setLoading(false) }
    })()
    return () => { cancel = true }
  }, [user?.id])

  useEffect(() => { api.get('/assistant/suggestions').then((d) => setSuggestions(d.suggestions)).catch(() => {}) }, [])
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [msgs, busy])

  const patchActive = (fn: (c: Convo) => Convo) =>
    setConvos((cs) => cs.map((c) => (c.id === activeId ? fn(c) : c)))

  const startNew = async () => {
    setNavOpen(false)
    try {
      const c: Convo = await api.post('/assistant/conversations', { title: 'New chat', msgs: [GREETING] })
      setConvos((cs) => [c, ...cs]); setActiveId(c.id)
    } catch { /* offline — keep current */ }
  }

  const deleteConvo = async (cid: string, e: React.MouseEvent) => {
    e.stopPropagation()
    api.del(`/assistant/conversations/${cid}`).catch(() => {})
    const next = convos.filter((c) => c.id !== cid)
    if (!next.length) { await startNew(); setConvos((cs) => cs.filter((c) => c.id !== cid)); return }
    setConvos(next)
    if (cid === activeId) setActiveId(next[0].id)
  }

  const send = async (q: string) => {
    if (!q.trim() || busy || !active) return
    const conv = active
    setInput(''); setBusy(true)
    const history = conv.msgs.slice(-8).map((m) => ({ role: m.role, text: m.text }))
    const title = conv.title === 'New chat' ? q.slice(0, 48) : conv.title
    const withUser: Msg[] = [...conv.msgs, { role: 'user', text: q }]
    patchActive((c) => ({ ...c, title, msgs: withUser, updated: Date.now() }))
    let finalMsgs = withUser
    try {
      const r = await api.post('/assistant/query', { query: q, history })
      finalMsgs = [...withUser, { role: 'ai', text: r.answer, tasks: r.tasks }]
    } catch (e: any) {
      finalMsgs = [...withUser, { role: 'ai', text: 'Error: ' + e.message }]
    }
    patchActive((c) => ({ ...c, title, msgs: finalMsgs, updated: Date.now() }))
    setBusy(false)
    api.put(`/assistant/conversations/${conv.id}`, { title, msgs: finalMsgs }).catch(() => {})
  }

  if (loading) return <div className="card" style={{ display: 'grid', placeItems: 'center', height: 'calc(100vh - 160px)' }}><span className="spinner" /></div>

  const sorted = [...convos].sort((a, b) => b.updated - a.updated)

  return (
    <div className={'assistant-layout' + (navOpen ? ' nav-open' : '') + (collapsed ? ' collapsed' : '')}>
      <aside className="chat-history">
        <div className="chat-history-head">
          <span className="ch-title">Chats</span>
          <button className="btn btn-ghost btn-sm collapse-btn" title="Hide history" onClick={() => setSidebar(true)}>«</button>
        </div>
        <button className="btn btn-primary new-chat-btn" onClick={startNew}>+ New chat</button>
        <div className="convo-list">
          {sorted.map((c) => (
            <div
              key={c.id}
              className={'convo-item' + (c.id === activeId ? ' active' : '')}
              onClick={() => { setActiveId(c.id); setNavOpen(false) }}
            >
              <div className="convo-meta">
                <div className="convo-title">{c.title}</div>
                <div className="convo-time">{relTime(c.updated)}</div>
              </div>
              <button className="convo-del" title="Delete chat" onClick={(e) => deleteConvo(c.id, e)}>×</button>
            </div>
          ))}
        </div>
      </aside>

      <div className="card chat-pane" style={{ padding: 18 }}>
        <div className="chat">
          <button className="btn btn-ghost btn-sm history-open-btn" title="Show history" onClick={() => setSidebar(false)}>☰ History</button>
          {/* Mobile header: history icon (opens past chats) · current title · quick New */}
          <div className="chat-mobile-bar">
            <button className="chat-list-btn" onClick={() => setNavOpen(true)} title="Chat history" aria-label="Chat history">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l3 3" /></svg>
            </button>
            <span className="convo-current">{active?.title || 'New chat'}</span>
            <button className="btn btn-ghost btn-sm assistant-newchat" onClick={startNew} title="New chat">+ New</button>
          </div>
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
      </div>
      {openId && <TaskDrawer taskId={openId} onClose={() => setOpenId(null)} />}
    </div>
  )
}
