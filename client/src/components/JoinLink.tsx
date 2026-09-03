import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { Ic } from '../ui'
import { toast } from '../lib/toast'
import { confirmDialog } from '../lib/confirm'

type Settings = {
  code: string | null
  link: string | null
  enabled: boolean
  role: string
  expires_at: string | null
  allowed_domains: string[]
}
type Request = { id: string; name: string; email: string; created_at: string }

// Administration → Users. The shareable half of onboarding: one link + a short
// code anyone can use to ASK to join, and the queue of people waiting.
//
// The pending queue is rendered above the settings when it is non-empty: a
// manager opening this screen almost always came because somebody is waiting,
// not to fiddle with the link.
export default function JoinLink() {
  const [s, setS] = useState<Settings | null>(null)
  const [reqs, setReqs] = useState<Request[]>([])
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<'link' | 'code' | null>(null)

  const loadSettings = () => api.get('/join/code').then(setS).catch(() => {})
  const loadRequests = () => api.get('/join/requests').then(setReqs).catch(() => {})
  useEffect(() => { loadSettings(); loadRequests() }, [])

  const patch = async (body: any) => {
    setBusy(true)
    try { setS(await api.patch('/join/code', body)) }
    catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }

  const rotate = async () => {
    if (!(await confirmDialog({
      title: 'Rotate the join code?',
      message: 'The current link and code stop working immediately. Anyone still holding the old one will have to be sent the new one.',
      confirmText: 'Rotate',
    }))) return
    setBusy(true)
    try { setS(await api.post('/join/code/rotate', {})); toast.success('New code generated') }
    catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }

  const copy = async (text: string, what: 'link' | 'code') => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 1500) } catch {}
  }

  const decide = async (r: Request, action: 'approve' | 'deny') => {
    if (action === 'deny' && !(await confirmDialog({
      title: `Deny ${r.name}?`,
      message: `${r.email} will not get an account. They can ask again with the same link.`,
      confirmText: 'Deny',
      danger: true,
    }))) return
    try {
      await api.post(`/join/requests/${r.id}/${action}`, {})
      toast.success(action === 'approve' ? `${r.name} added to the workspace` : `${r.name} denied`)
      loadRequests()
      window.dispatchEvent(new Event('users-changed'))
    } catch (e: any) { toast.error(e.message) }
  }

  if (!s) return null

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head spread">
        <h3 className="row" style={{ gap: 8 }}><Ic name="user" size={16} /> Join link &amp; org code</h3>
        {reqs.length > 0 && <span className="jl-count">{reqs.length} waiting</span>}
      </div>

      <div className="card-pad grid" style={{ gap: 16 }}>
        {reqs.length > 0 && (
          <div className="jl-queue">
            <div className="jl-queue-head">People asking to join</div>
            {reqs.map((r) => (
              <div className="jl-req" key={r.id}>
                <div className="jl-req-who">
                  <div className="jl-req-name">{r.name}</div>
                  <div className="jl-req-mail">{r.email}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-sm btn-done-soft" onClick={() => decide(r, 'approve')}>Approve</button>
                  <button className="btn btn-sm btn-danger" onClick={() => decide(r, 'deny')}>Deny</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <label className="jl-toggle">
          <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span>
            <b>Let people join with a link</b>
            <span className="muted"> — every request still needs your approval before an account exists.</span>
          </span>
        </label>

        {s.enabled && s.code && (
          <>
            <div className="jl-grid">
              <div>
                <div className="jl-label">Org code</div>
                <div className="row" style={{ gap: 8 }}>
                  <code className="jl-code">{s.code}</code>
                  <button className="btn btn-sm" onClick={() => copy(s.code!, 'code')}>{copied === 'code' ? 'Copied!' : 'Copy'}</button>
                </div>
              </div>
              <div>
                <div className="jl-label">New joiners get</div>
                <select value={s.role} disabled={busy} onChange={(e) => patch({ role: e.target.value })}>
                  <option value="employee">Employee</option>
                  <option value="manager">Manager</option>
                </select>
              </div>
            </div>

            <div>
              <div className="jl-label">Shareable link</div>
              <div className="row" style={{ gap: 8 }}>
                <input readOnly value={s.link || ''} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
                <button className="btn btn-sm btn-primary" onClick={() => copy(s.link!, 'link')}>{copied === 'link' ? 'Copied!' : 'Copy'}</button>
                <button className="btn btn-sm" onClick={rotate} disabled={busy} title="Invalidate this link and generate a new one">Rotate</button>
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                {s.allowed_domains?.length > 0
                  ? `Only ${s.allowed_domains.join(', ')} addresses can use it.`
                  : 'Anyone with this link can ask to join — you approve who actually gets in.'}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
