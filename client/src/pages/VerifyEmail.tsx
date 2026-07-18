import React, { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { Ic } from '../ui'

// Public page reached from the verify-email link. Confirms the token on load.
export default function VerifyEmail() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const { user, refresh } = useAuth()
  const [state, setState] = useState<'working' | 'ok' | 'fail'>('working')
  const [msg, setMsg] = useState('')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    if (!token) { setState('fail'); setMsg('This verification link is missing its token.'); return }
    api.post('/auth/verify-email', { token })
      .then(() => { setState('ok'); if (user) refresh() })
      .catch((e) => { setState('fail'); setMsg(e.message || 'This verification link is invalid or has expired.') })
  }, [token])

  return (
    <div className="login-wrap login-wrap--panda">
      <div className="login-stage">
        <div className="login-card login-card--panda">
          <div className="brand" style={{ padding: 0, marginBottom: 18, marginTop: 26, justifyContent: 'space-between', width: '100%' }}>
            <div className="brand-name" style={{ color: '#16191d' }}>Email verification</div>
            <img src="/logo.png" alt="Befach" className="brand-logo-img" />
          </div>

          {state === 'working' && <div style={{ display: 'grid', placeItems: 'center', padding: 24 }}><span className="spinner" /></div>}

          {state === 'ok' && (
            <div className="muted row" style={{ gap: 8, fontSize: 14, lineHeight: 1.5, background: 'var(--success-bg)', border: '1px solid var(--success-border)', color: 'var(--success-ink)', borderRadius: 8, padding: '14px 16px' }}>
              <Ic name="check" size={16} /> Your email is verified. Thank you!
            </div>
          )}
          {state === 'fail' && <div className="login-err">{msg}</div>}

          <div className="muted" style={{ fontSize: 12.5, marginTop: 18, textAlign: 'center' }}>
            <Link to="/" style={{ color: 'var(--primary)', fontWeight: 600 }}>Continue to app</Link>
          </div>
        </div>
      </div>
    </div>
  )
}
