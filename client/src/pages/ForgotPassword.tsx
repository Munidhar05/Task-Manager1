import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'

// Public page: request a password-reset link. The server always responds OK (it
// never reveals whether an email is registered), so we show the same confirmation
// regardless.
export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(''); setBusy(true)
    try { await api.post('/auth/forgot-password', { email: email.trim() }); setSent(true) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="login-wrap login-wrap--panda">
      <div className="login-stage">
        <form className="login-card login-card--panda" onSubmit={submit}>
          <div className="brand" style={{ padding: 0, marginBottom: 14, marginTop: 26, justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="brand-name" style={{ color: '#1f1a16' }}>Reset password</div>
              <div className="muted" style={{ fontSize: 12 }}>We'll email you a reset link</div>
            </div>
            <img src="/logo.png" alt="Befach" className="brand-logo-img" />
          </div>

          {sent ? (
            <>
              <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.5, background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, padding: '12px 14px' }}>
                If an account exists for <b>{email}</b>, a password‑reset link is on its way. Check your inbox (and spam). The link expires in 24 hours.
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 16, textAlign: 'center' }}>
                <Link to="/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>Back to login</Link>
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label>Your email</label>
                <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username"
                  inputMode="email" placeholder="you@company.com" autoFocus />
              </div>
              {err && <div className="login-err">{err}</div>}
              <button className="btn btn-primary login-btn" disabled={busy || !email.trim()}>
                {busy ? <span className="spinner" /> : 'SEND RESET LINK'}
              </button>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 14, textAlign: 'center' }}>
                Remembered it? <Link to="/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>Log in</Link>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  )
}
