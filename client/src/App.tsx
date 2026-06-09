import React, { useRef, useState } from 'react'
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './auth'
import { api, userAvatarUrl, getToken } from './api'
import { Avatar } from './ui'
import NotificationBell from './components/NotificationBell'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Meetings from './pages/Meetings'
import MeetingDetail from './pages/MeetingDetail'
import Tasks from './pages/Tasks'
import Assistant from './pages/Assistant'
import Chats from './pages/Chats'
import Admin from './pages/Admin'

// The Manager is the Admin of the org: it owns the Administration hub
// (org metrics, full user management & audit log).
const NAV = [
  { to: '/', label: 'Dashboard', icon: '◧', roles: ['manager'] },
  { to: '/tasks', label: 'Tasks', icon: '✓', roles: ['manager', 'employee'] },
  { to: '/chats', label: 'Chats', icon: '💬', roles: ['manager', 'employee'] },
  { to: '/meetings', label: 'Meetings', icon: '🎙', roles: ['manager'] },
  { to: '/assistant', label: 'AI Assistant', icon: '✦', roles: ['manager'] },
  { to: '/admin', label: 'Administration', icon: '⚙', roles: ['manager'] },
]

const TITLES: Record<string, { t: string; s: string }> = {
  '/': { t: 'Dashboard', s: 'Your meeting-to-task command center' },
  '/tasks': { t: 'Tasks', s: 'Track the full task lifecycle' },
  '/chats': { t: 'Chats', s: 'Message your manager and teammates' },
  '/meetings': { t: 'Meetings', s: 'Upload conversations, get structured work' },
  '/assistant': { t: 'AI Assistant', s: 'Ask anything about your tasks' },
  '/admin': { t: 'Administration', s: 'Users, audit logs & org metrics' },
}

function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout, refresh } = useAuth()
  const avatarInput = useRef<HTMLInputElement>(null)
  const uploadAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { alert('Please choose an image'); return }
    if (file.size > 5 * 1024 * 1024) { alert('Image too large (max 5 MB)'); return }
    try {
      const form = new FormData(); form.append('file', file)
      const headers: Record<string, string> = {}; const t = getToken(); if (t) headers.authorization = `Bearer ${t}`
      const res = await fetch('/api/users/me/avatar', { method: 'POST', headers, body: form })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Upload failed')
      await refresh()
    } catch (err: any) { alert('Could not set photo: ' + err.message) }
  }
  const loc = useLocation()
  const [open, setOpen] = useState(false)
  const [engine, setEngine] = useState('')
  const [chatUnread, setChatUnread] = useState(0)
  React.useEffect(() => { fetch('/api/health').then(r => r.json()).then(d => setEngine(d.ai_engine)).catch(() => {}) }, [])
  // Poll the unread chat count so the Chats nav item shows a live badge.
  React.useEffect(() => {
    const load = () => api.get('/chat/unread').then((d) => setChatUnread(d.unread)).catch(() => {})
    load()
    const iv = setInterval(load, 10000)
    const onPing = () => load()
    window.addEventListener('chat-unread-changed', onPing)
    return () => { clearInterval(iv); window.removeEventListener('chat-unread-changed', onPing) }
  }, [])
  const base = '/' + (loc.pathname.split('/')[1] || '')
  const meta = TITLES[base] || TITLES['/']
  if (!user) return null
  return (
    <div className="app">
      <aside className={'sidebar' + (open ? ' open' : '')}>
        <div className="brand">
          <div className="brand-logo">B</div>
          <div>
            <div className="brand-name">Befach Task Manager</div>
            <div className="brand-sub">Meeting → Task</div>
          </div>
        </div>
        <nav className="nav" onClick={() => setOpen(false)}>
          {NAV.filter((n) => n.roles.includes(user.role)).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="nav-icon">{n.icon}</span>{n.label}
              {n.to === '/chats' && chatUnread > 0 && <span className="nav-badge">{chatUnread > 9 ? '9+' : chatUnread}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-user">
          <input ref={avatarInput} type="file" accept="image/*" style={{ display: 'none' }} onChange={uploadAvatar} />
          <button className="avatar-edit-btn" title="Change profile photo" onClick={() => avatarInput.current?.click()}>
            <Avatar name={user.name} color={user.avatar_color} size={36} src={user.avatar_file ? userAvatarUrl(user.id, user.avatar_file) : undefined} />
            <span className="avatar-edit-icon">✎</span>
          </button>
          <div className="meta">
            <div className="n">{user.name}</div>
            <div className="r">{user.role}</div>
          </div>
          <button className="btn btn-ghost btn-sm logout-btn" onClick={logout} title="Log out" aria-label="Log out">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v9" />
              <path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
            </svg>
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn btn-ghost" style={{ display: 'none' }} onClick={() => setOpen((o) => !o)}>☰</button>
          <div>
            <h1>{meta.t}</h1>
            <div className="sub">{meta.s}</div>
          </div>
          <div className="row" style={{ marginLeft: 'auto', gap: 12 }}>
            {engine && <span className="engine-pill">● AI: {engine}</span>}
            <NotificationBell key={user.id} />
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  )
}

function Protected({ children, roles }: { children: React.ReactNode; roles?: string[] }) {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}><span className="spinner" /></div>
  if (!user) return <Navigate to="/login" replace />
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />
  return <Layout>{children}</Layout>
}

// Home routes employees straight to their Tasks; the manager (admin) sees the Dashboard.
function Home() {
  const { user } = useAuth()
  if (user?.role === 'employee') return <Navigate to="/tasks" replace />
  return <Dashboard />
}

export default function App() {
  const { user } = useAuth()
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/" element={<Protected><Home /></Protected>} />
      <Route path="/tasks" element={<Protected><Tasks /></Protected>} />
      <Route path="/chats" element={<Protected><Chats /></Protected>} />
      <Route path="/meetings" element={<Protected roles={['manager']}><Meetings /></Protected>} />
      <Route path="/meetings/:id" element={<Protected roles={['manager']}><MeetingDetail /></Protected>} />
      <Route path="/assistant" element={<Protected roles={['manager']}><Assistant /></Protected>} />
      <Route path="/admin" element={<Protected roles={['manager']}><Admin /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
