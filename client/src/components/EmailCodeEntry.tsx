import React, { useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { toast } from '../lib/toast'

// "Type the code we emailed you" — confirming your OWN address. Shared by the
// once-a-day reminder card and Profile, which differ only in what surrounds it.
//
// The input comes first and the send button second on purpose: by the time
// anyone sees this a code is usually already in their inbox (signup, being
// added by a manager, and changing your address all send one), so asking for a
// new one is the fallback, not the first step.
export default function EmailCodeEntry() {
  const { refresh } = useAuth()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'send' | 'check' | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const send = async () => {
    setBusy('send'); setMsg(null)
    try {
      const r = await api.post('/auth/resend-verification', {})
      setCode('')
      setMsg({ kind: 'ok', text: r.delivered === false ? 'Email isn\'t set up on this server, so the code was written to the server log.' : 'New code sent. Check your inbox (and spam).' })
    } catch (e: any) { setMsg({ kind: 'err', text: e.message || 'Could not send a code.' }) }
    finally { setBusy(null) }
  }

  const check = async () => {
    setBusy('check'); setMsg(null)
    try {
      await api.post('/auth/verify-email-code', { code })
      toast.success('Your email is confirmed.')
      // The confirmed state lives on the user, so refreshing it is what makes
      // the reminder card and Profile both drop the prompt.
      await refresh()
    } catch (e: any) { setMsg({ kind: 'err', text: e.message || 'Could not confirm that code.' }) }
    finally { setBusy(null) }
  }

  return (
    <div className="ec">
      <div className="ec-row">
        <input className="otp-input" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6) check() }}
          inputMode="numeric" autoComplete="one-time-code" placeholder="000000" aria-label="Confirmation code" />
        <button className="btn btn-primary btn-sm" onClick={check} disabled={!!busy || code.length !== 6}>
          {busy === 'check' ? <span className="spinner" /> : 'Confirm'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={send} disabled={!!busy}>
          {busy === 'send' ? <span className="spinner" /> : 'Send new code'}
        </button>
      </div>
      {msg && <div className={'ec-msg ' + msg.kind} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.text}</div>}
    </div>
  )
}
