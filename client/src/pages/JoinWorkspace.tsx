import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import PasswordStrength from '../components/PasswordStrength'
import { passwordStrength, isCommonPassword } from '../lib/passwordStrength'

// Public landing for a shareable join link: /join/:code
//
// Unlike /accept-invite, nobody is logged in at the end of this. The form creates
// a REQUEST; a manager approves it before an account exists. That is the whole
// security model of the open link, so the screen says so plainly BEFORE asking
// for a password rather than surprising people afterwards.
export default function JoinWorkspace() {
  const { code = '' } = useParams()
  const navigate = useNavigate()
  // Reached at /join with no code: somebody was TOLD the code rather than sent
  // the link ("our code is 96CKCX"), and until now had nowhere to type it.
  const [codeInput, setCodeInput] = useState('')
  const [org, setOrg] = useState<{ org_name: string; role: string; allowed_domains: string[] } | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [showPw, setShowPw] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  useEffect(() => {
    if (!code) return                       // waiting for a code to be typed
    api.get(`/join/lookup/${encodeURIComponent(code)}`)
      .then(setOrg)
      .catch((e) => setLoadErr(e.message))
  }, [code])

  // Codes are read aloud and written down, so accept what people actually type:
  // any case, and spaces or dashes wherever they fell.
  const goToCode = (e: React.FormEvent) => {
    e.preventDefault()
    const c = codeInput.replace(/[\s-]/g, '').toUpperCase()
    if (!c) { setErr('Enter the code your manager gave you.'); return }
    setErr('')
    navigate(`/join/${encodeURIComponent(c)}`, { replace: true })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    if (!form.name.trim()) { setErr('Please enter your name.'); return }
    if (form.password.length < 8) { setErr('Password must be at least 8 characters.'); return }
    if (isCommonPassword(form.password)) { setErr('That password is too common — please choose a stronger one.'); return }
    if (!passwordStrength(form.password).ok) { setErr('Please choose a stronger password (mix letters, numbers & symbols).'); return }
    setBusy(true)
    try {
      await api.post('/join/request', { code, ...form, name: form.name.trim(), email: form.email.trim() })
      setSent(true)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  if (!code) {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={goToCode}>
          <div className="brand" style={{ padding: 0, marginBottom: 8, gap: 12 }}>
            <img src="/logo.png" alt="" className="brand-logo-img" />
            <div>
              <div className="brand-name" style={{ color: 'var(--text)' }}>Join with a code</div>
              <div className="muted" style={{ fontSize: 12 }}>Ask your manager for your workspace code</div>
            </div>
          </div>
          <div className="field">
            <label htmlFor="join-code">Workspace code</label>
            <input
              id="join-code"
              className="join-code-input"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
              placeholder="ABC123"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={12}
              autoFocus
            />
          </div>
          {err && <div className="login-err" role="alert">{err}</div>}
          <button className="btn btn-primary login-btn">Continue</button>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 14, textAlign: 'center' }}>
            Already have an account? <Link to="/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>Log in</Link>
          </div>
        </form>
      </div>
    )
  }

  if (loadErr) {
    return (
      <div className="login-wrap">
        <div className="login-card" style={{ textAlign: 'center' }}>
          <img src="/logo.png" alt="VoTask" className="brand-logo-img" style={{ margin: '0 auto 14px' }} />
          <h1>This link isn't active</h1>
          <p className="muted" style={{ marginTop: 8, fontSize: 14 }}>{loadErr}</p>
          <Link to="/join" className="btn btn-primary login-btn" style={{ marginTop: 18 }}>Try another code</Link>
          <Link to="/login" className="btn login-btn" style={{ marginTop: 8 }}>Go to sign in</Link>
        </div>
      </div>
    )
  }

  if (!org) return <div className="login-wrap"><span className="spinner" /></div>

  if (sent) {
    return (
      <div className="login-wrap">
        <div className="login-card" style={{ textAlign: 'center' }}>
          <div className="join-tick" aria-hidden="true">✓</div>
          <h1>Request sent</h1>
          <p className="muted" style={{ marginTop: 10, fontSize: 14, lineHeight: 1.6 }}>
            A manager at <b>{org.org_name}</b> needs to approve you before your account is created.
            Once they do, sign in with the email and password you just chose — no confirmation
            email is sent, so check back or ask them directly.
          </p>
          <Link to="/login" className="btn login-btn" style={{ marginTop: 18 }}>Back to sign in</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0, marginBottom: 6, gap: 12 }}>
          <img src="/logo.png" alt="" className="brand-logo-img" />
          <div>
            <div className="brand-name" style={{ color: 'var(--text)' }}>Join {org.org_name}</div>
            <div className="muted" style={{ fontSize: 12 }}>You'll join as {org.role === 'manager' ? 'a manager' : 'an employee'}</div>
          </div>
        </div>

        {/* Said before the form, not after it — being told you are queued only
            once you have already handed over a password reads as a bait. */}
        <div className="join-note">
          A manager approves each request, so your account is created after they say yes — not straight away.
        </div>

        <div className="field">
          <label>Your name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Your full name" autoComplete="name" autoFocus />
        </div>
        <div className="field">
          <label>Work email</label>
          <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} type="email" name="email"
            autoComplete="username" inputMode="email" placeholder="you@company.com" />
          {org.allowed_domains?.length > 0 && (
            <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
              This workspace only accepts {org.allowed_domains.join(', ')} addresses.
            </div>
          )}
        </div>
        <div className="field">
          <label>Choose a password</label>
          <div className="pw-row">
            <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
              type={showPw ? 'text' : 'password'} name="password" autoComplete="new-password" placeholder="At least 8 characters" />
            <button type="button" className="pw-toggle" onClick={() => setShowPw((v) => !v)} tabIndex={-1}
              aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? '🙈' : '👁'}</button>
          </div>
          <PasswordStrength password={form.password} />
        </div>

        {err && <div className="login-err" role="alert">{err}</div>}

        <button className="btn btn-primary login-btn" disabled={busy}>
          {busy ? <span className="spinner" /> : 'Ask to join'}
        </button>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 14, textAlign: 'center' }}>
          Already have an account? <Link to="/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>Log in</Link>
        </div>
      </form>
    </div>
  )
}
