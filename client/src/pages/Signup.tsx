import React, { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'
import PasswordStrength from '../components/PasswordStrength'
import { passwordStrength, isCommonPassword } from '../lib/passwordStrength'

// Clean line-art icons for the signup mode toggle + password reveal.
const CompanyIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 21h18" /><path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16" /><path d="M15 21v-8h4a1 1 0 0 1 1 1v7" /><path d="M9 7h2M9 11h2M9 15h2" /></svg>
)
const PersonIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
)
const EyeIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
)
const EyeOffIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.45M6.6 6.6A13.2 13.2 0 0 0 2 11s3.5 7 10 7a9.1 9.1 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2" /><line x1="2" y1="2" x2="22" y2="22" /></svg>
)

// Self-serve company onboarding: creates the organization + its first account (a
// manager, the org admin) and logs straight in.
export default function Signup() {
  const { signup } = useAuth()
  const navigate = useNavigate()
  // 'company' = team workspace (current flow); 'personal' = a solo user managing
  // their own tasks (an org of one â€” no company name needed).
  const [mode, setMode] = useState<'company' | 'personal'>('company')
  const [company, setCompany] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [shake, setShake] = useState(false)
  const personal = mode === 'personal'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    if (!personal && !company.trim()) { setErr('Please enter your company name.'); return }
    if (password.length < 8) { setErr('Password must be at least 8 characters.'); return }
    if (isCommonPassword(password)) { setErr('That password is too common â€” please choose a stronger one.'); return }
    if (!passwordStrength(password).ok) { setErr('Please choose a stronger password (mix letters, numbers & symbols).'); return }
    setBusy(true)
    try {
      await signup({ company: company.trim(), name: name.trim(), email: email.trim(), password, personal })
      // A company workspace of one is not a workspace. This is the single moment
      // someone is most willing to bring their team in, so ask here rather than
      // hoping they later find Administration. A solo workspace has nobody to
      // invite, so it goes straight through.
      // Company workspaces detour through the invite step.
      //
      // This leaves via a full location replace, not router navigate(). App.tsx
      // renders /signup as `user ? <Navigate to="/"/> : <Signup/>`, and the
      // instant signup() sets the user that <Navigate> mounts and fires its
      // effect — landing on "/" a beat AFTER we already moved to /invite-team,
      // which is exactly what the navigation trace showed. Reloading at the new
      // URL sidesteps the race entirely instead of trying to out-order it; the
      // token is already in localStorage, so the app comes back up signed in.
      if (personal) navigate('/', { replace: true })
      else window.location.replace('/invite-team?company=' + encodeURIComponent(company.trim()))
    } catch (e: any) {
      setErr(e.message); setShake(true); setTimeout(() => setShake(false), 500)
    } finally { setBusy(false) }
  }

  return (
    <div className="login-wrap login-wrap--panda">
      <div className={`login-stage ${shake ? 'shake' : ''}`}>
        <form className="login-card login-card--panda" onSubmit={submit}>
          <div className="brand" style={{ padding: 0, marginBottom: 14, marginTop: 26, justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="brand-name" style={{ color: '#16191d' }}>{personal ? 'Create your account' : 'Create your company'}</div>
              <div className="muted" style={{ fontSize: 12 }}>{personal ? 'Track and manage your own tasks' : "Set up your team's task workspace"}</div>
            </div>
            <img src="/logo.png" alt="VoTask" className="brand-logo-img" />
          </div>

          {/* Choose: a team company, or a personal (solo) workspace. */}
          <div className="signup-mode">
            <button type="button" className={mode === 'company' ? 'active' : ''} onClick={() => { setMode('company'); setErr('') }}><CompanyIcon /> My company</button>
            <button type="button" className={mode === 'personal' ? 'active' : ''} onClick={() => { setMode('personal'); setErr('') }}><PersonIcon /> Just me</button>
          </div>

          {!personal && (
            <div className="field">
              <label>Company name</label>
              <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Pvt Ltd" autoFocus />
            </div>
          )}

          <div className="field">
            <label>Your name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your full name" autoComplete="name" />
          </div>

          <div className="field">
            <label>Work email</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" name="email"
              autoComplete="username" inputMode="email" placeholder="you@company.com" />
          </div>

          <div className="field">
            <label>Create a password</label>
            <div className="pw-row">
              <input value={password} onChange={(e) => setPassword(e.target.value)} type={showPw ? 'text' : 'password'}
                name="password" autoComplete="new-password" placeholder="At least 8 characters" />
              <button type="button" className="pw-toggle" onClick={() => setShowPw((s) => !s)} tabIndex={-1}
                aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? <EyeOffIcon /> : <EyeIcon />}</button>
            </div>
            <PasswordStrength password={password} />
          </div>

          {err && <div className="login-err" role="alert">{err}</div>}

          <button className="btn btn-primary login-btn" disabled={busy}>
            {busy ? <span className="spinner" /> : (personal ? 'CREATE ACCOUNT' : 'CREATE COMPANY')}
          </button>

          <div className="muted" style={{ fontSize: 12.5, marginTop: 14, textAlign: 'center' }}>
            Already have an account? <Link to="/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>Log in</Link>
            <br />
            By creating an account you agree to our <Link to="/privacy" style={{ color: 'var(--primary)', fontWeight: 600 }}>Privacy Policy</Link>.
            <br />
            <Link to="/welcome" style={{ color: 'var(--primary)', fontWeight: 600 }}>What is VoTask?</Link>
          </div>
        </form>
      </div>
    </div>
  )
}
