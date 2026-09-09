import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth'
import { googleEnabled, isNativePlatform, renderGoogleButton, nativeGoogleSignIn } from '../googleAuth'

// Clean line-art eye / eye-off for the password reveal toggle.
const EyeIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
)
const EyeOffIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.45M6.6 6.6A13.2 13.2 0 0 0 2 11s3.5 7 10 7a9.1 9.1 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2" /><line x1="2" y1="2" x2="22" y2="22" /></svg>
)
// Google's four-colour "G" — used only on the native (Android) button; the web
// button is drawn by Google Identity Services itself.
const GoogleG = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
    <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7A21.99 21.99 0 0 0 24 46z" />
    <path fill="#FBBC05" d="M11.69 28.18A13.2 13.2 0 0 1 11 24c0-1.45.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z" />
    <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.94 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
  </svg>
)

// Trust markers shown on the brand panel — each states a capability the product
// actually has (role-based access, audit logging, encryption in transit).
const TrustIcon = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const TRUST = [
  { icon: <TrustIcon><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></TrustIcon>, label: 'Role-based access control' },
  { icon: <TrustIcon><path d="M4 4h16v12H4z" /><path d="M4 20h16" /><path d="M8 8h8M8 12h5" /></TrustIcon>, label: 'Every action written to an audit log' },
  { icon: <TrustIcon><rect x="3" y="11" width="18" height="10" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></TrustIcon>, label: 'Encrypted in transit · your data stays yours' },
]

export default function Login() {
  const { login, loginWithGoogle } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const googleBtnRef = useRef<HTMLDivElement>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(''); setBusy(true)
    try { await login(email, password) }
    catch (e: any) { setErr(e.message) }
    finally { setBusy(false) }
  }

  // Complete a Google sign-in with the ID token from either platform.
  const finishGoogle = async (credential: string) => {
    setErr(''); setBusy(true)
    try { await loginWithGoogle(credential) }
    catch (e: any) { setErr(e.message) }
    finally { setBusy(false) }
  }

  // Native (Android) uses the plugin behind our own button; web renders Google's
  // official button into the container below.
  const onNativeGoogle = async () => {
    setErr('')
    try { const idToken = await nativeGoogleSignIn(); await finishGoogle(idToken) }
    catch (e: any) { if (e?.message) setErr(e.message) }
  }
  useEffect(() => {
    if (!googleEnabled() || isNativePlatform() || !googleBtnRef.current) return
    let cleanup = () => {}
    renderGoogleButton(googleBtnRef.current, finishGoogle, setErr).then((c) => { cleanup = c })
    return () => cleanup()
  }, [])

  return (
    <div className="auth-wrap">
      {/* Brand panel — the value statement and trust signals a buyer reads first. */}
      <aside className="auth-brand">
        <Link to="/welcome" className="auth-brand-top" title="What is VoTask?">
          <img src="/logo.png" alt="VoTask" className="auth-brand-logo" />
          <span className="auth-brand-name">VoTask</span>
        </Link>
        <div className="auth-brand-body">
          <h1 className="auth-headline">Turn multilingual meetings into accountable execution.</h1>
          <p className="auth-sub">VoTask listens to your meeting, extracts the decisions and tasks, resolves owners and deadlines, and routes every item through approval to execution — with the original quote behind each one.</p>
          <ul className="auth-trust">
            {TRUST.map((t) => (
              <li key={t.label}><span className="auth-trust-ic">{t.icon}</span>{t.label}</li>
            ))}
          </ul>
        </div>
        <div className="auth-brand-foot">Meetings → decisions → tasks → execution</div>
      </aside>

      {/* Sign-in panel */}
      <main className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-card-head">
            <h2>Sign in</h2>
            <p className="muted">Welcome back. Sign in to your workspace.</p>
          </div>

          <div className="field">
            <label htmlFor="login-email">Work email</label>
            <input
              id="login-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              placeholder="you@company.com"
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="login-password">Password</label>
            <div className="pw-row">
              <input
                id="login-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type={showPw ? 'text' : 'password'}
                name="password"
                autoComplete="current-password"
                placeholder="Enter your password"
              />
              <button
                type="button"
                className="pw-toggle"
                onClick={() => setShowPw((s) => !s)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
              >
                {showPw ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </div>

          {err && <div className="login-err" role="alert">{err}</div>}

          <button className="btn btn-primary login-btn" disabled={busy}>
            {busy ? <span className="spinner" /> : 'Sign in'}
          </button>

          {googleEnabled() && (
            <>
              <div className="login-or"><span>or</span></div>
              {isNativePlatform() ? (
                <button type="button" className="btn google-btn" disabled={busy} onClick={onNativeGoogle}>
                  <GoogleG /> Continue with Google
                </button>
              ) : (
                // Google Identity Services renders its official button in here.
                <div ref={googleBtnRef} className="google-btn-slot" />
              )}
            </>
          )}

          <div className="auth-links">
            <Link to="/forgot-password">Forgot password?</Link>
            <span>New to VoTask? <Link to="/signup">Create your workspace</Link></span>
            <span>Given a workspace code? <Link to="/join">Join with it</Link></span>
            <Link to="/welcome" className="auth-what">What is VoTask?</Link>
          </div>
        </form>
        <Link to="/privacy" className="auth-legal">Privacy Policy</Link>
      </main>
    </div>
  )
}
