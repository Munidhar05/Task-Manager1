import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import PasswordStrength from '../components/PasswordStrength'
import { passwordStrength, isCommonPassword } from '../lib/passwordStrength'

const EyeIcon = () => (<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>)
const EyeOffIcon = () => (<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.45M6.6 6.6A13.2 13.2 0 0 0 2 11s3.5 7 10 7a9.1 9.1 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2" /><line x1="2" y1="2" x2="22" y2="22" /></svg>)

// Public page reached from an emailed invite link. Confirms the invite, then lets
// the invitee set their name + password and join the org.
export default function AcceptInvite() {
  const { acceptInvite } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token = params.get('token') || ''

  const [loading, setLoading] = useState(true)
  const [info, setInfo] = useState<{ email: string; role: string; org_name: string } | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token) { setErr('This invitation link is missing its token.'); setLoading(false); return }
    api.get(`/invites/lookup?token=${encodeURIComponent(token)}`)
      .then((d) => setInfo(d))
      .catch((e) => setErr(e.message || 'This invitation is invalid or has expired.'))
      .finally(() => setLoading(false))
  }, [token])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    if (password.length < 8) { setErr('Password must be at least 8 characters.'); return }
    if (isCommonPassword(password)) { setErr('That password is too common — please choose a stronger one.'); return }
    if (!passwordStrength(password).ok) { setErr('Please choose a stronger password (mix letters, numbers & symbols).'); return }
    setBusy(true)
    try {
      await acceptInvite({ token, name: name.trim(), password })
      navigate('/', { replace: true })
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="login-wrap login-wrap--panda">
      <div className="login-stage">
        <form className="login-card login-card--panda" onSubmit={submit}>
          <div className="brand" style={{ padding: 0, marginBottom: 14, marginTop: 26, justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="brand-name" style={{ color: '#16191d' }}>{info ? `Join ${info.org_name}` : 'Accept invitation'}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {info ? `Invited as ${info.role} · ${info.email}` : 'Set up your account'}
              </div>
            </div>
            <img src="/logo.png" alt="Befach" className="brand-logo-img" />
          </div>

          {loading && <div style={{ display: 'grid', placeItems: 'center', padding: 24 }}><span className="spinner" /></div>}

          {!loading && !info && (
            <>
              <div className="login-err">{err || 'This invitation is invalid or has expired.'}</div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 14, textAlign: 'center' }}>
                <Link to="/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>Go to login</Link>
              </div>
            </>
          )}

          {!loading && info && (
            <>
              <div className="field">
                <label>Your name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your full name" autoComplete="name" autoFocus />
              </div>
              <div className="field">
                <label>Create a password</label>
                <div className="pw-row">
                  <input value={password} onChange={(e) => setPassword(e.target.value)} type={showPw ? 'text' : 'password'}
                    autoComplete="new-password" placeholder="At least 8 characters" />
                  <button type="button" className="pw-toggle" onClick={() => setShowPw((s) => !s)} tabIndex={-1}
                    aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? <EyeOffIcon /> : <EyeIcon />}</button>
                </div>
                <PasswordStrength password={password} />
              </div>
              {err && <div className="login-err" role="alert">{err}</div>}
              <button className="btn btn-primary login-btn" disabled={busy || !name.trim()}>
                {busy ? <span className="spinner" /> : 'JOIN TEAM'}
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  )
}
