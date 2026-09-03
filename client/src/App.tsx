import React, { useEffect, useRef, useState } from 'react'
import { Routes, Route, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { useAuth } from './auth'
import { confirmLogout } from './lib/confirm'
import { runBackHandlers } from './back'
import { api, getToken, userAvatarUrl } from './api'
import { Avatar, Ic } from './ui'
import NotificationBell from './components/NotificationBell'
import ProfileModal, { SECTIONS, SectionId } from './components/ProfileModal'
import FeedbackModal from './components/FeedbackModal'
import FeedbackButton from './components/FeedbackButton'
import VoiceAssistant from './components/VoiceAssistant'
import ToastHost from './components/ToastHost'
import ConfirmHost from './components/ConfirmHost'
import QuickInvite from './components/QuickInvite'
import Login from './pages/Login'
import Signup from './pages/Signup'
import AcceptInvite from './pages/AcceptInvite'
import ForgotPassword from './pages/ForgotPassword'
import ResetPassword from './pages/ResetPassword'
import VerifyEmail from './pages/VerifyEmail'
import Dashboard from './pages/Dashboard'
import Meetings from './pages/Meetings'
import MeetingDetail from './pages/MeetingDetail'
import Tasks from './pages/Tasks'
import Assistant from './pages/Assistant'
import Chats from './pages/Chats'
import Leaderboard from './pages/Leaderboard'
import Admin from './pages/Admin'
import Platform from './pages/Platform'
import PrivacyPolicy from './pages/PrivacyPolicy'
import Landing from './pages/Landing'
import JoinWorkspace from './pages/JoinWorkspace'
import InviteTeam from './pages/InviteTeam'

// Clean line-style sidebar icons (inherit currentColor, so they turn white when active).
const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
)
const ICONS = {
  dashboard: <Icon><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></Icon>,
  tasks: <Icon><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m8.5 12 2.5 2.5L16 9" /></Icon>,
  mytasks: <Icon><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="m15 11 2 2 4-4" /></Icon>,
  chats: <Icon><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" /></Icon>,
  meetings: <Icon><rect x="9" y="2" width="6" height="11" rx="3" /><path d="M5 10v1a7 7 0 0 0 14 0v-1" /><line x1="12" y1="19" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" /></Icon>,
  assistant: <Icon><path d="M12 2.5 14 8l5.5 2-5.5 2-2 5.5L10 12 4.5 10 10 8z" /><path d="M19 14.5 19.8 17l2.5.8-2.5.8L19 21l-.8-2.4-2.5-.8 2.5-.8z" /></Icon>,
  admin: <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></Icon>,
  platform: <Icon><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18" /><path d="M12 3a14 14 0 0 0 0 18" /></Icon>,
  leaderboard: <Icon><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z" /><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 0-3 3" /></Icon>,
} as const

// The Manager is the Admin of the org: it owns the Administration hub
// (org metrics, full user management & audit log).
// `teamOnly` items are hidden in a personal (solo) workspace — there's no team
// to chat with or administer when it's just one person.
const NAV = [
  { to: '/my-tasks', label: 'My Tasks', icon: ICONS.mytasks, roles: ['manager'] },
  { to: '/', label: 'Dashboard', icon: ICONS.dashboard, roles: ['manager', 'employee'] },
  { to: '/tasks', label: 'Tasks', icon: ICONS.tasks, roles: ['manager', 'employee'] },
  { to: '/chats', label: 'Chats', icon: ICONS.chats, roles: ['manager', 'employee'], teamOnly: true },
  { to: '/leaderboard', label: 'Leaderboard', icon: ICONS.leaderboard, roles: ['manager', 'employee'], teamOnly: true },
  { to: '/meetings', label: 'Meetings', icon: ICONS.meetings, roles: ['manager'] },
  { to: '/assistant', label: 'AI Assistant', icon: ICONS.assistant, roles: ['manager'] },
  { to: '/admin', label: 'Administration', icon: ICONS.admin, roles: ['manager'], teamOnly: true },
  { to: '/platform', label: 'Platform', icon: ICONS.platform, roles: ['manager', 'employee'], platformOnly: true },
]

const TITLES: Record<string, { t: string; s: string }> = {
  '/my-tasks': { t: 'My Tasks', s: 'Your private personal tasks — visible only to you' },
  '/': { t: 'Dashboard', s: 'Your meeting-to-task command center' },
  '/tasks': { t: 'Tasks', s: 'Track the full task lifecycle' },
  '/chats': { t: 'Chats', s: 'Message your manager and teammates' },
  '/leaderboard': { t: 'Leaderboard', s: 'Performance scores across the team' },
  '/meetings': { t: 'Meetings', s: 'Upload conversations, get structured work' },
  '/assistant': { t: 'AI Assistant', s: 'Ask anything about your tasks' },
  '/admin': { t: 'Administration', s: 'Users, audit logs & org metrics' },
  '/platform': { t: 'Platform', s: 'Oversee every organization on the platform' },
}

// Coarse "time since last sync" for the sidebar health line. Kept vague on
// purpose — the poll runs every 10s, so "just now" covers the common case.
function syncAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 20) return 'just now'
  if (s < 90) return 'moments ago'
  const m = Math.floor(s / 60)
  return `${m}m ago`
}

function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth()
  const [showProfile, setShowProfile] = useState(false)
  // The sidebar's "More" list. `profileSection` is which settings screen a click
  // asked for, so the modal can open straight onto it instead of showing its own
  // menu again — the reader already chose.
  const [moreOpen, setMoreOpen] = useState(false)
  const [profileSection, setProfileSection] = useState<SectionId | undefined>(undefined)
  const openProfileAt = (id: SectionId) => { setProfileSection(id); setShowProfile(true); setOpen(false) }
  const [showFeedback, setShowFeedback] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const loc = useLocation()
  // No explicit in-app back button: Android handles "back" via the hardware
  // button / swipe gesture (see useAndroidBackButton), and browsers have their own.
  const [open, setOpen] = useState(false)
  const [chatUnread, setChatUnread] = useState(0)
  // Workspace connection health, derived from the existing unread poll: the last
  // successful sync time, and whether we're currently reconnecting. An honest,
  // always-visible signal that the workspace is live (or that it isn't).
  const [lastSync, setLastSync] = useState<number | null>(null)
  const [online, setOnline] = useState(true)
  // Poll the unread chat count so the Chats nav item shows a live badge.
  React.useEffect(() => {
    const load = () => api.get('/chat/unread')
      .then((d) => { setChatUnread(d.unread); setLastSync(Date.now()); setOnline(true) })
      .catch(() => setOnline(false))
    load()
    const iv = setInterval(load, 10000)
    const onPing = () => load()
    window.addEventListener('chat-unread-changed', onPing)
    return () => { clearInterval(iv); window.removeEventListener('chat-unread-changed', onPing) }
  }, [])
  const base = '/' + (loc.pathname.split('/')[1] || '')
  const meta = TITLES[base] || TITLES['/']
  if (!user) return null
  // The nav items this user can see, filtered once and shared by the sidebar
  // (full list) and the mobile bottom bar (the first few, thumb-reachable).
  const visibleNav = NAV.filter((n) => (n as any).platformOnly
    ? !!user.platform_admin
    : n.roles.includes(user.role) && !(user.workspace_personal && (n as any).teamOnly))
  // One bottom-nav tab (shared by the slots on either side of the center mic).
  const renderBottomTab = (n: typeof NAV[number]) => (
    <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => 'bn-item' + (isActive ? ' active' : '')}>
      <span className="bn-ic">{n.icon}</span>
      <span className="bn-label">{n.label}</span>
      {n.to === '/chats' && chatUnread > 0 && <span className="bn-badge">{chatUnread > 9 ? '9+' : chatUnread}</span>}
    </NavLink>
  )
  return (
    <div className="app">
      <aside className={'sidebar' + (open ? ' open' : '')}>
        <div className="brand">
          <img src="/logo.png" alt="VoTask" className="brand-logo" />
          <div>
            <div className="brand-name">VoTask</div>
            <div className="brand-sub">Execution Platform</div>
          </div>
        </div>
        <nav className="nav" onClick={() => setOpen(false)}>
          {visibleNav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="nav-icon">{n.icon}</span>{n.label}
              {n.to === '/chats' && chatUnread > 0 && <span className="nav-badge">{chatUnread > 9 ? '9+' : chatUnread}</span>}
            </NavLink>
          ))}

          {/* Invite lives here, not in NAV: NAV also feeds the mobile bottom bar
              via slice(), so a new row there would silently push an existing tab
              out of the thumb zone. Managers only — POST /invites refuses
              employees, and a button that always fails is worse than no button. */}
          {user.role !== 'employee' && !user.workspace_personal && (
            <button
              type="button"
              className="nav-invite"
              onClick={(e) => { e.stopPropagation(); setOpen(false); setShowInvite(true) }}
              title="Invite someone to this workspace"
            >
              <span className="nav-icon">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" />
                </svg>
              </span>Invite people
            </button>
          )}

          {/* Settings live under the nav rather than only behind the avatar: the
              rail had the room, and "where do I change my password" is a question
              the menu should answer without a hunt. Collapsed by default so the
              four places you actually navigate to stay the top of the list.
              stopPropagation because <nav> closes the mobile drawer on any click —
              expanding a submenu is not navigating away. */}
          <button
            className={'nav-more' + (moreOpen ? ' open' : '')}
            aria-expanded={moreOpen}
            onClick={(e) => { e.stopPropagation(); setMoreOpen((o) => !o) }}
          >
            <span className="nav-icon"><Ic name="menu" size={17} /></span>More
            <span className="nav-more-chev" aria-hidden="true">{moreOpen ? '⌄' : '›'}</span>
          </button>
          {moreOpen && (
            <div className="nav-sub">
              {SECTIONS.map((s) => (
                <button key={s.id} className="nav-sub-item" onClick={() => openProfileAt(s.id)}>
                  <span className="nav-icon"><Ic name={s.icon} size={15} /></span>{s.label}
                </button>
              ))}
              <button className="nav-sub-item nav-sub-logout" onClick={async () => { if (await confirmLogout()) logout() }}>
                <span className="nav-icon">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3v9" /><path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
                  </svg>
                </span>Log out
              </button>
            </div>
          )}
        </nav>
        <div className="sidebar-user">
          <button className="avatar-edit-btn" title="Open profile & settings" onClick={() => setShowProfile(true)}>
            <Avatar name={user.name} color={user.avatar_color} size={36} src={user.avatar_file ? userAvatarUrl(user.id, user.avatar_file) : undefined} />
            <span className="avatar-edit-icon"><Ic name="edit" size={10} /></span>
          </button>
          <button className="meta sidebar-user-meta" onClick={() => setShowProfile(true)} title="Open profile & settings">
            <div className="n">{user.name}</div>
            <div className="r">{user.role}</div>
          </button>
          <button className="btn btn-ghost btn-sm logout-btn" onClick={async () => { if (await confirmLogout()) logout() }} title="Log out" aria-label="Log out">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v9" />
              <path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
            </svg>
          </button>
        </div>
        {/* Phones only. The sidebar profile row above (and the power button in
            it) is hidden on mobile, so the drawer had no way to sign out at all
            — the only route was the top-bar avatar into Profile › Security. The
            drawer stays open behind the confirmation, which sits above it, so a
            cancel leaves you exactly where you were. */}
        <button className="sidebar-logout-m" onClick={async () => { if (await confirmLogout()) logout() }}>
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v9" />
            <path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
          </svg>
          Log out
        </button>
        <div className="sidebar-foot">
          <div className={'sidebar-sync' + (online ? '' : ' offline')} title={online ? 'Your workspace is live' : 'Trying to reconnect…'}>
            <span className="sidebar-sync-dot" />
            {online
              ? <span>Synced{lastSync ? ` ${syncAgo(lastSync)}` : ''}</span>
              : <span>Reconnecting…</span>}
          </div>
          <div className="sidebar-legal-row">
            <button className="sidebar-legal sidebar-legal-btn" onClick={() => { setOpen(false); setShowFeedback(true) }}>Rate this app</button>
            <span className="sidebar-legal-sep">·</span>
            <NavLink to="/privacy" className="sidebar-legal" onClick={() => setOpen(false)}>Privacy</NavLink>
          </div>
        </div>
      </aside>
      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button className="nav-toggle" onClick={() => setOpen((o) => !o)} aria-label="Open menu">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div>
            <h1>{meta.t}</h1>
            <div className="sub">{meta.s}</div>
          </div>
          <div className="row" style={{ marginLeft: 'auto', gap: 10 }}>
            <NotificationBell key={user.id} />
            <button className="topbar-avatar" onClick={() => setShowProfile(true)} title="Profile & settings" aria-label="Open profile & settings">
              <Avatar name={user.name} color={user.avatar_color} size={33} src={user.avatar_file ? userAvatarUrl(user.id, user.avatar_file) : undefined} />
              <span className="topbar-avatar-dot" />
            </button>
          </div>
        </header>
        <main className="content"><VerifyEmailBanner /><div>{children}</div></main>
      </div>
      {/* Mobile bottom tab bar — template layout: two tabs, the signature center
          floating AI voice mic, one more tab, then "More" (opens the full drawer).
          The center mic opens the global VoiceAssistant via an 'open-voice' event. */}
      <nav className="bottom-nav" aria-label="Primary">
        {visibleNav.slice(0, 2).map(renderBottomTab)}
        <button
          className="bn-mic"
          onClick={() => window.dispatchEvent(new Event('open-voice'))}
          aria-label="Open voice assistant"
          title="Talk to the AI assistant"
        >
          {/* The halo. Its own element rather than a box-shadow on the orb, because
              a shadow takes one flat colour per layer and this one is a green→orange
              gradient. First child so it paints UNDER the orb by document order —
              no z-index, and so nothing here can escape the tab bar's stacking. */}
          <span className="bn-mic-glow" aria-hidden="true" />
          <span className="bn-mic-btn">
            {/* The orb face: a mic flanked by a live waveform. Both wave groups are
                identical markup — CSS mirrors the right one so the tall bars sit
                inward on both sides. */}
            <span className="bn-mic-face" aria-hidden="true">
              <span className="bn-wave"><i /><i /><i /></span>
              <svg className="bn-mic-glyph" viewBox="0 0 24 24" width="17" height="17">
                <rect x="9" y="2" width="6" height="11.5" rx="3" fill="currentColor" />
                <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="bn-wave"><i /><i /><i /></span>
            </span>
          </span>
          <span className="bn-mic-label">AI</span>
        </button>
        {visibleNav.slice(2, 3).map(renderBottomTab)}
        <button className="bn-item" onClick={() => setOpen(true)} aria-label="More menu">
          <span className="bn-ic">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </span>
          <span className="bn-label">More</span>
        </button>
      </nav>
      {/* The section is cleared on close, so opening from the avatar next time
          lands on the menu rather than wherever the sidebar last sent you. */}
      {showProfile && (
        <ProfileModal
          initialSection={profileSection}
          onClose={() => { setShowProfile(false); setProfileSection(undefined) }}
          onFeedback={() => { setShowProfile(false); setProfileSection(undefined); setShowFeedback(true) }}
        />
      )}
      {/* Corner feedback tab — hidden while the modal is open so it isn't behind it. */}
      {!showFeedback && <FeedbackButton onClick={() => setShowFeedback(true)} />}
      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
      {showInvite && <QuickInvite onClose={() => setShowInvite(false)} />}
      {/* Global hands-free voice assistant — available on every authenticated page. */}
      <VoiceAssistant />
    </div>
  )
}

// Unverified-email nudge. A small floating popup (NOT a top bar that pushes the
// page down) that appears at most once per calendar day — once shown or dismissed,
// it stays hidden until the next day.
function VerifyEmailBanner() {
  const { user } = useAuth()
  const [show, setShow] = useState(false)
  const [sent, setSent] = useState(false)
  useEffect(() => {
    if (!user || user.email_verified) { setShow(false); return }
    const today = new Date().toISOString().slice(0, 10)
    try {
      if (localStorage.getItem('befach_verify_prompt') === today) return // already shown today
      localStorage.setItem('befach_verify_prompt', today)
    } catch { /* storage unavailable — still show it this load */ }
    setShow(true)
  }, [user])
  if (!show || !user || user.email_verified) return null
  const resend = async () => {
    try { await api.post('/auth/resend-verification'); setSent(true) } catch {}
  }
  return (
    <div className="verify-pop" role="status">
      <div className="verify-pop-head">
        <span className="verify-pop-ic"><Ic name="mail" size={18} /></span>
        <div className="verify-pop-body">
          <div className="verify-pop-title">Verify your email</div>
          <div className="verify-pop-sub">Confirm {user.email} to secure your account.</div>
        </div>
        <button className="verify-pop-x" onClick={() => setShow(false)} aria-label="Dismiss">✕</button>
      </div>
      <div className="verify-pop-actions">
        {sent
          ? <span className="muted" style={{ fontSize: 12.5 }}>Sent — check your inbox.</span>
          : <>
              <button className="btn btn-primary btn-sm" onClick={resend}>Resend link</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShow(false)}>Later</button>
            </>}
      </div>
    </div>
  )
}

function Protected({ children, roles, platform }: { children: React.ReactNode; roles?: string[]; platform?: boolean }) {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}><span className="spinner" /></div>
  if (!user) return <Navigate to="/login" replace />
  if (platform && !user.platform_admin) return <Navigate to="/" replace />
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />
  return <Layout>{children}</Layout>
}

// Home renders the role-aware Dashboard: employees see their personal overview,
// the manager (admin) sees the org-wide command center. (Dashboard branches internally.)
function Home() {
  return <Dashboard />
}

const RouteSpinner = () => (
  <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}><span className="spinner" /></div>
)

// "/" is two different pages depending on who is asking. Signed in, it's the
// dashboard. Signed OUT it is the public welcome page — not a bounce to the login
// form, because a first-time visitor arriving at the bare domain has no idea what
// VoTask is yet, and a password box doesn't tell them. Deep links into the app
// (/tasks, /chats, …) still go to /login via Protected: those visitors already
// know where they were headed.
//
// Both gates wait for `loading` rather than reading `user` alone, or a returning
// user with a stored token would see the marketing page flash before /auth/me
// resolves them into the app.
function HomeRoute() {
  const { user, loading } = useAuth()
  if (loading) return <RouteSpinner />
  if (!user) return <Landing />
  return <Protected><Home /></Protected>
}

// The step shown straight after creating a company workspace.
//
// Gated on the TOKEN rather than the resolved user, because two separate races
// otherwise bounce it to /login and from there to "/": a cold load starts with
// user=null while /auth/me is still in flight, and arriving from signup can
// render once with the new location before the new user has propagated. The
// token is written synchronously by signup() and login(), so it is true the
// instant either succeeds and needs no React state to have settled.
function InviteTeamRoute() {
  const { loading } = useAuth()
  if (loading) return <RouteSpinner />
  if (!getToken()) return <Navigate to="/login" replace />
  return <InviteTeam />
}

// The same page under its own stable URL, so the login/signup screens (and any
// link someone shares) have something to point back at.
function WelcomeRoute() {
  const { user, loading } = useAuth()
  if (loading) return <RouteSpinner />
  return user ? <Navigate to="/" replace /> : <Landing />
}

// Make the Android hardware back button step back through the app (close an open
// panel/modal, then go back a screen) instead of quitting the app outright.
function useAndroidBackButton() {
  const navigate = useNavigate()
  const loc = useLocation()
  const pathRef = useRef(loc.pathname)
  useEffect(() => { pathRef.current = loc.pathname }, [loc.pathname])
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let handle: { remove: () => void } | undefined
    import('@capacitor/app').then(({ App: CapApp }) => {
      CapApp.addListener('backButton', () => {
        if (runBackHandlers()) return        // a page closed a modal/panel
        if (pathRef.current !== '/') navigate(-1) // step back a screen
        else CapApp.exitApp()                // already home → leave the app
      }).then((h) => { handle = h })
    }).catch(() => {})
    return () => { handle?.remove() }
  }, [navigate])
}

export default function App() {
  const { user } = useAuth()
  useAndroidBackButton()
  return (
    <>
    <ToastHost />
    <ConfirmHost />
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/signup" element={user ? <Navigate to="/" replace /> : <Signup />} />
      <Route path="/accept-invite" element={user ? <Navigate to="/" replace /> : <AcceptInvite />} />
      <Route path="/forgot-password" element={user ? <Navigate to="/" replace /> : <ForgotPassword />} />
      <Route path="/reset-password" element={user ? <Navigate to="/" replace /> : <ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route path="/welcome" element={<WelcomeRoute />} />
      <Route path="/join" element={<JoinWorkspace />} />
      <Route path="/join/:code" element={<JoinWorkspace />} />
      {/* Signed IN, but outside Layout: the step right after signup should be a
          focused screen, not the app chrome with an empty dashboard behind it. */}
      <Route path="/invite-team" element={<InviteTeamRoute />} />
      <Route path="/" element={<HomeRoute />} />
      <Route path="/my-tasks" element={<Protected roles={['manager']}><Tasks personal /></Protected>} />
      <Route path="/tasks" element={<Protected><Tasks /></Protected>} />
      <Route path="/chats" element={<Protected><Chats /></Protected>} />
      <Route path="/leaderboard" element={<Protected><Leaderboard /></Protected>} />
      <Route path="/meetings" element={<Protected roles={['manager']}><Meetings /></Protected>} />
      <Route path="/meetings/:id" element={<Protected roles={['manager']}><MeetingDetail /></Protected>} />
      <Route path="/assistant" element={<Protected roles={['manager']}><Assistant /></Protected>} />
      <Route path="/admin" element={<Protected roles={['manager']}><Admin /></Protected>} />
      <Route path="/platform" element={<Protected platform><Platform /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  )
}
