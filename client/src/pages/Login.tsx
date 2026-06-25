import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth'

// Clean line-art eye / eye-off for the password reveal toggle.
const EyeIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
)
const EyeOffIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.45M6.6 6.6A13.2 13.2 0 0 0 2 11s3.5 7 10 7a9.1 9.1 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2" /><line x1="2" y1="2" x2="22" y2="22" /></svg>
)

export default function Login() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [emailFocused, setEmailFocused] = useState(false)
  const [pwFocused, setPwFocused] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [shake, setShake] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(''); setBusy(true)
    try { await login(email, password) }
    catch (e: any) { setErr(e.message); setShake(true); setTimeout(() => setShake(false), 500) }
    finally { setBusy(false) }
  }

  // Mascot state: covering eyes while typing a hidden password, peeking when revealed.
  const covering = pwFocused && !showPw
  const peeking = pwFocused && showPw
  // Pupils glance toward whatever field is active.
  const lookY = emailFocused ? 3 : pwFocused ? -1 : 0
  const lookX = emailFocused ? Math.min(4, email.length * 0.12) - 2 : 0

  return (
    <div className="login-wrap login-wrap--panda">
      <div className={`login-stage ${shake ? 'shake' : ''}`}>
        <Mascot covering={covering} peeking={peeking} lookX={lookX} lookY={lookY} happy={busy} />
        <form className="login-card login-card--panda" onSubmit={submit}>
          <div className="brand" style={{ padding: 0, marginBottom: 14, marginTop: 26, justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="brand-name" style={{ color: '#1f1a16' }}>Befach Task Manager</div>
              <div className="muted" style={{ fontSize: 12 }}>Meeting-to-Task Platform</div>
            </div>
            <img src="/logo.png" alt="Befach" className="brand-logo-img" />
          </div>

          <div className="field">
            <label>Enter your email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onFocus={() => setEmailFocused(true)}
              onBlur={() => setEmailFocused(false)}
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              placeholder="you@befach.com"
              autoFocus
            />
          </div>

          <div className="field">
            <label>Enter your password</label>
            <div className="pw-row">
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onFocus={() => setPwFocused(true)}
                onBlur={() => setPwFocused(false)}
                type={showPw ? 'text' : 'password'}
                name="password"
                autoComplete="current-password"
                placeholder="Password"
              />
              <button
                type="button"
                className="pw-toggle"
                onClick={() => setShowPw((s) => !s)}
                tabIndex={-1}
                aria-label={showPw ? 'Hide password' : 'Show password'}
              >
                {showPw ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </div>

          {err && <div className="login-err">{err}</div>}

          <button className="btn btn-primary login-btn" disabled={busy}>
            {busy ? <span className="spinner" /> : 'LOGIN'}
          </button>

          <div className="muted" style={{ fontSize: 12.5, marginTop: 14, textAlign: 'center', lineHeight: 1.8 }}>
            <Link to="/forgot-password" style={{ color: 'var(--primary)', fontWeight: 600 }}>Forgot password?</Link>
            <br />
            New here? <Link to="/signup" style={{ color: 'var(--primary)', fontWeight: 600 }}>Create your company</Link>
          </div>
        </form>
        <div className="paws-bottom">
          <Paw /><Paw />
        </div>
      </div>
    </div>
  )
}

function Paw() {
  return (
    <svg className="foot-paw" viewBox="0 0 60 60" width="44" height="44">
      <ellipse cx="30" cy="38" rx="20" ry="16" fill="#2b2440" />
      <ellipse cx="30" cy="40" rx="11" ry="9" fill="#fff" />
      <circle cx="14" cy="22" r="6" fill="#2b2440" />
      <circle cx="30" cy="16" r="6.5" fill="#2b2440" />
      <circle cx="46" cy="22" r="6" fill="#2b2440" />
    </svg>
  )
}

function Mascot({ covering, peeking, lookX, lookY, happy }: {
  covering: boolean; peeking: boolean; lookX: number; lookY: number; happy: boolean
}) {
  return (
    <div className="mascot">
      <svg viewBox="0 0 220 170" width="200" height="155">
        {/* ears */}
        <circle cx="62" cy="48" r="26" fill="#2b2440" />
        <circle cx="158" cy="48" r="26" fill="#2b2440" />
        <circle cx="62" cy="48" r="12" fill="#4a4068" />
        <circle cx="158" cy="48" r="12" fill="#4a4068" />
        {/* head */}
        <ellipse cx="110" cy="92" rx="78" ry="70" fill="#fff" stroke="#ece8f5" strokeWidth="2" />
        {/* cheeks (warm orange to match brand) */}
        <circle cx="64" cy="108" r="13" fill="#f6c89a" opacity="0.85" />
        <circle cx="156" cy="108" r="13" fill="#f6c89a" opacity="0.85" />
        {/* eye patches */}
        <ellipse className={`patch ${covering ? 'hidden-eyes' : ''}`} cx="82" cy="84" rx="20" ry="25" fill="#2b2440" transform="rotate(-18 82 84)" />
        <ellipse className={`patch ${covering ? 'hidden-eyes' : ''}`} cx="138" cy="84" rx="20" ry="25" fill="#2b2440" transform="rotate(18 138 84)" />
        {/* eye whites + pupils */}
        <g className={`eyes ${covering ? 'closed' : ''}`}>
          <circle cx="84" cy="86" r="9" fill="#fff" />
          <circle cx="136" cy="86" r="9" fill="#fff" />
          <circle cx={84 + lookX} cy={86 + lookY} r="4.6" fill="#2b2440" />
          <circle cx={136 + lookX} cy={86 + lookY} r="4.6" fill="#2b2440" />
          <circle cx={86 + lookX} cy={84 + lookY} r="1.5" fill="#fff" />
          <circle cx={138 + lookX} cy={84 + lookY} r="1.5" fill="#fff" />
        </g>
        {/* nose + mouth */}
        <ellipse cx="110" cy="112" rx="8" ry="5.5" fill="#2b2440" />
        <path d={happy ? 'M96 122 Q110 138 124 122' : 'M99 124 Q110 132 121 124'} fill="none" stroke="#2b2440" strokeWidth="3" strokeLinecap="round" />

        {/* paws that swing up to cover the eyes */}
        <g className={`mpaw mpaw-left ${covering ? 'cover' : ''} ${peeking ? 'peek' : ''}`}>
          <ellipse cx="78" cy="150" rx="22" ry="17" fill="#2b2440" />
          <ellipse cx="78" cy="152" rx="11" ry="8" fill="#f6c89a" opacity="0.9" />
        </g>
        <g className={`mpaw mpaw-right ${covering ? 'cover' : ''} ${peeking ? 'peek' : ''}`}>
          <ellipse cx="142" cy="150" rx="22" ry="17" fill="#2b2440" />
          <ellipse cx="142" cy="152" rx="11" ry="8" fill="#f6c89a" opacity="0.9" />
        </g>
      </svg>
    </div>
  )
}
