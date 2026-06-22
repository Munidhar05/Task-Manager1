import React, { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'

// Self-serve company onboarding: creates the organization + its first account (a
// manager, the org admin) and logs straight in.
export default function Signup() {
  const { signup } = useAuth()
  const navigate = useNavigate()
  const [company, setCompany] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [shake, setShake] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    if (password.length < 8) { setErr('Password must be at least 8 characters.'); return }
    setBusy(true)
    try {
      await signup({ company: company.trim(), name: name.trim(), email: email.trim(), password })
      navigate('/', { replace: true })
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
              <div className="brand-name" style={{ color: '#1f1a16' }}>Create your company</div>
              <div className="muted" style={{ fontSize: 12 }}>Set up your team's task workspace</div>
            </div>
            <img src="/logo.png" alt="Befach" className="brand-logo-img" />
          </div>

          <div className="field">
            <label>Company name</label>
            <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Pvt Ltd" autoFocus />
          </div>

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
                aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? '🙈' : '👁'}</button>
            </div>
          </div>

          {err && <div className="login-err">{err}</div>}

          <button className="btn btn-primary login-btn" disabled={busy}>
            {busy ? <span className="spinner" /> : 'CREATE COMPANY'}
          </button>

          <div className="muted" style={{ fontSize: 12.5, marginTop: 14, textAlign: 'center' }}>
            Already have an account? <Link to="/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>Log in</Link>
          </div>
        </form>
      </div>
    </div>
  )
}
