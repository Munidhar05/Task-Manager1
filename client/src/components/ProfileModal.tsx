import React, { useRef, useState } from 'react'
import { api, getToken, API_BASE, userAvatarUrl } from '../api'
import { useAuth } from '../auth'
import { Avatar, LANG_LABEL } from '../ui'
import { WALLPAPERS, getWallpaperId, applyWallpaper } from '../lib/wallpaper'
import { useEscape } from '../lib/useEscape'

// A self-service profile hub: change photo, edit name, change password, pick an app
// wallpaper, and set the preferred language. Opens from the sidebar avatar.
export default function ProfileModal({ onClose }: { onClose: () => void }) {
  const { user, refresh, logout } = useAuth()
  useEscape(onClose)
  if (!user) return null

  const fileInput = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(user.name)
  const [lang, setLang] = useState(user.preferred_language || 'en')
  const [curPw, setCurPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [wallpaper, setWallpaper] = useState(getWallpaperId())
  const [busy, setBusy] = useState<string | null>(null)
  // Messages are tagged with the section they belong to so each shows next to its
  // own action (e.g. a wrong-password error appears in the Change-password card).
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; section: 'profile' | 'password' } | null>(null)

  const flash = (kind: 'ok' | 'err', text: string, section: 'profile' | 'password' = 'profile') => {
    setMsg({ kind, text, section }); setTimeout(() => setMsg(null), 3500)
  }

  // Upload a new profile photo.
  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { flash('err', 'Please choose an image.'); return }
    if (file.size > 5 * 1024 * 1024) { flash('err', 'Image too large (max 5 MB).'); return }
    setBusy('photo')
    try {
      const form = new FormData(); form.append('file', file)
      const headers: Record<string, string> = {}; const t = getToken(); if (t) headers.authorization = `Bearer ${t}`
      const res = await fetch(`${API_BASE}/api/users/me/avatar`, { method: 'POST', headers, body: form })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Upload failed')
      await refresh()
      flash('ok', 'Profile photo updated.')
    } catch (err: any) { flash('err', err.message || 'Could not update photo.') }
    finally { setBusy(null) }
  }

  // Save name + preferred language.
  const saveProfile = async () => {
    if (!name.trim()) { flash('err', 'Name cannot be empty.'); return }
    setBusy('profile')
    try {
      await api.patch('/users/me', { name: name.trim(), preferred_language: lang })
      await refresh()
      flash('ok', 'Profile saved.')
    } catch (err: any) { flash('err', err.message || 'Could not save profile.') }
    finally { setBusy(null) }
  }

  // Change password (requires the current one).
  const changePassword = async () => {
    if (newPw.length < 8) { flash('err', 'New password must be at least 8 characters.', 'password'); return }
    if (newPw !== confirmPw) { flash('err', 'New passwords do not match.', 'password'); return }
    setBusy('password')
    try {
      await api.patch('/users/me', { current_password: curPw, new_password: newPw })
      setCurPw(''); setNewPw(''); setConfirmPw('')
      flash('ok', 'Password changed.', 'password')
    } catch (err: any) { flash('err', err.message || 'Could not change password.', 'password') }
    finally { setBusy(null) }
  }

  // Apply a wallpaper instantly (live preview) and remember it.
  const pickWallpaper = (id: string) => { setWallpaper(id); applyWallpaper(id) }

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal profile-modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread">
          <h3>My profile</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="card-pad grid" style={{ gap: 18 }}>
          {/* Identity + photo */}
          <div className="profile-id">
            <button className="avatar-edit-btn" onClick={() => fileInput.current?.click()} disabled={busy === 'photo'} title="Change profile photo">
              <Avatar name={user.name} color={user.avatar_color} size={64} src={user.avatar_file ? userAvatarUrl(user.id, user.avatar_file) : undefined} />
              <span className="avatar-edit-icon">{busy === 'photo' ? '…' : '✎'}</span>
            </button>
            <input ref={fileInput} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPhoto} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{user.name}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>{user.email}</div>
              <span className="badge profile-role">{user.role}</span>
            </div>
          </div>

          {msg && msg.section === 'profile' && <div className={'profile-msg ' + msg.kind}>{msg.text}</div>}

          {/* Edit name + language */}
          <section className="profile-section">
            <h4>Account details</h4>
            <div><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" /></div>
            <div>
              <label>Preferred language</label>
              <select value={lang} onChange={(e) => setLang(e.target.value)}>
                {Object.entries(LANG_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <button className="btn btn-primary btn-sm" onClick={saveProfile} disabled={busy === 'profile'}>
              {busy === 'profile' ? <span className="spinner" /> : 'Save changes'}
            </button>
          </section>

          {/* Wallpaper */}
          <section className="profile-section">
            <h4>App wallpaper</h4>
            <div className="wallpaper-grid">
              {WALLPAPERS.map((w) => (
                <button
                  key={w.id}
                  className={'wallpaper-swatch' + (wallpaper === w.id ? ' active' : '')}
                  style={{ background: w.swatch }}
                  onClick={() => pickWallpaper(w.id)}
                  title={w.name}
                  aria-label={w.name}
                >
                  {wallpaper === w.id && <span className="wallpaper-check">✓</span>}
                </button>
              ))}
            </div>
          </section>

          {/* Change password */}
          <section className="profile-section">
            <h4>Change password</h4>
            {msg && msg.section === 'password' && <div className={'profile-msg ' + msg.kind}>{msg.text}</div>}
            <div><label>Current password</label><input type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} autoComplete="current-password" /></div>
            <div><label>New password</label><input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" /></div>
            <div><label>Confirm new password</label><input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" /></div>
            <button className="btn btn-sm" onClick={changePassword} disabled={busy === 'password' || !curPw || !newPw}>
              {busy === 'password' ? <span className="spinner" /> : 'Update password'}
            </button>
          </section>

          {/* Sign out */}
          <button className="btn profile-logout" onClick={() => { onClose(); logout() }}>Log out</button>
        </div>
      </div>
    </div>
  )
}
