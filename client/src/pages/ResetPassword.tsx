import React, { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'

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
              <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.5, background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, padding: '12px 14px' }}>
                ✅ Your password has been updated. You can now log in with it.
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
                    aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? '🙈' : '👁'}</button>
                </div>
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
