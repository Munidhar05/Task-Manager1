import React, { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import PasswordStrength from '../components/PasswordStrength'
import { passwordStrength, isCommonPassword } from '../lib/passwordStrength'
import { Ic } from '../ui'

const EyeIcon = () => (<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>)
const EyeOffIcon = () => (<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.45M6.6 6.6A13.2 13.2 0 0 0 2 11s3.5 7 10 7a9.1 9.1 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2" /><line x1="2" y1="2" x2="22" y2="22" /></svg>)

// Public page reached from the reset-password email link.
export default function ResetPassword() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    if (!token) { setErr('This reset link is missing its token.'); return }
    if (password.length < 8) { setErr('Password must be at least 8 characters.'); return }
    if (isCommonPassword(password)) { setErr('That password is too common — please choose a stronger one.'); return }
    if (!passwordStrength(password).ok) { setErr('Please choose a stronger password (mix letters, numbers & symbols).'); return }
    setBusy(true)
    try { await api.post('/auth/reset-password', { token, password }); setDone(true) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="login-wrap login-wrap--panda">
      <div className="login-stage">
        <form className="login-card login-card--panda" onSubmit={submit}>
          <div className="brand" style={{ padding: 0, marginBottom: 14, marginTop: 26, justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="brand-name" style={{ color: '#1f1a16' }}>Choose a new password</div>
              <div className="muted" style={{ fontSize: 12 }}>Pick something you'll remember</div>
            </div>
            <img src="/logo.png" alt="Befach" className="brand-logo-img" />
          </div>

          {done ? (
            <>
              <div className="muted row" style={{ gap: 8, fontSize: 13.5, lineHeight: 1.5, background: 'var(--success-bg)', border: '1px solid var(--success-border)', color: 'var(--success-ink)', borderRadius: 8, padding: '12px 14px' }}>
                <Ic name="check" size={16} /> Your password has been updated. You can now log in with it.
              </div>
              <Link to="/login" className="btn btn-primary login-btn" style={{ marginTop: 16, textAlign: 'center', textDecoration: 'none' }}>GO TO LOGIN</Link>
            </>
          ) : (
            <>
              <div className="field">
                <label>New password</label>
                <div className="pw-row">
                  <input value={password} onChange={(e) => setPassword(e.target.value)} type={showPw ? 'text' : 'password'}
                    autoComplete="new-password" placeholder="At least 8 characters" autoFocus />
                  <button type="button" className="pw-toggle" onClick={() => setShowPw((s) => !s)} tabIndex={-1}
                    aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? <EyeOffIcon /> : <EyeIcon />}</button>
                </div>
                <PasswordStrength password={password} />
              </div>
              {err && <div className="login-err">{err}</div>}
              <button className="btn btn-primary login-btn" disabled={busy}>
                {busy ? <span className="spinner" /> : 'UPDATE PASSWORD'}
              </button>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 14, textAlign: 'center' }}>
                <Link to="/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>Back to login</Link>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  )
}
