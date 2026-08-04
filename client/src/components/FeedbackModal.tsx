import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api, userAvatarUrl } from '../api'
import { useAuth } from '../auth'
import { Avatar, Ic, EmptyState } from '../ui'
import { useEscape } from '../lib/useEscape'
import { toast } from '../lib/toast'

// In-app feedback. Everyone can leave a star rating + comment about the app (and
// update it later). Managers/admins also see the whole org's reviews, the
// average, and the submission trail — who sent what, when, from which screen and
// which device. Opens from the corner Feedback tab, the sidebar and the profile
// menu.

// A row of five stars, clickable when interactive.
function Stars({ value, onPick, size = 22 }: { value: number; onPick?: (n: number) => void; size?: number }) {
  const [hover, setHover] = useState(0)
  return (
    <div className="fb-stars" role={onPick ? 'radiogroup' : undefined} aria-label="Star rating">
      {[1, 2, 3, 4, 5].map((n) => {
        const on = (hover || value) >= n
        return (
          <button
            key={n}
            type="button"
            className={'fb-star' + (on ? ' on' : '') + (onPick ? ' interactive' : '')}
            disabled={!onPick}
            onMouseEnter={onPick ? () => setHover(n) : undefined}
            onMouseLeave={onPick ? () => setHover(0) : undefined}
            onClick={onPick ? () => onPick(n) : undefined}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            aria-checked={value === n}
            role={onPick ? 'radio' : undefined}
          >
            <svg viewBox="0 0 24 24" width={size} height={size} fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
              <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18.9 6.1 21.5l1.2-6.5L2.5 9.4l6.6-.9z" />
            </svg>
          </button>
        )
      })}
    </div>
  )
}

const timeAgo = (raw?: string) => {
  if (!raw) return ''
  const s = /\dT|\dZ|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z'
  const ms = Date.parse(s); if (isNaN(ms)) return ''
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (sec < 60) return 'just now'
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago'
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago'
  return Math.floor(sec / 86400) + 'd ago'
}

// Absolute date + time for the trail, where "2d ago" is too vague to act on.
const stamp = (raw?: string) => {
  if (!raw) return ''
  const s = /\dT|\dZ|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z'
  const ms = Date.parse(s); if (isNaN(ms)) return ''
  return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

// The screen / device / build chips shown under a review or a trail entry.
function ContextTags({ page, device, version, sends }: { page?: string; device?: string; version?: string; sends?: number }) {
  if (!page && !device && !version && !sends) return null
  return (
    <div className="fb-meta">
      {page && <span className="fb-tag" title="Screen they were on when they sent it">from <code>{page}</code></span>}
      {device && <span className="fb-tag">{device}</span>}
      {version && <span className="fb-tag">v{version}</span>}
      {!!sends && sends > 1 && <span className="fb-tag">{sends} submissions</span>}
    </div>
  )
}

export default function FeedbackModal({ onClose }: { onClose: () => void }) {
  const { user } = useAuth()
  useEscape(onClose)
  const isManager = user?.role !== 'employee'
  // Where the user was when they opened the form — recorded with the submission
  // so a manager can see which screen prompted the comment.
  const loc = useLocation()

  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [existing, setExisting] = useState(false)   // has the user rated before?
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<any>(null)  // manager view
  const [history, setHistory] = useState<any>(null)  // manager view: the trail
  const [tab, setTab] = useState<'reviews' | 'history'>('reviews')
  const [loaded, setLoaded] = useState(false)

  const loadManagerViews = () => {
    api.get('/feedback').then(setSummary).catch(() => {})
    api.get('/feedback/history').then(setHistory).catch(() => {})
  }

  // Load the user's own rating (pre-fill) and, for managers, the org summary.
  useEffect(() => {
    api.get('/feedback/mine').then((r) => {
      if (r) { setRating(r.rating); setComment(r.comment || ''); setExisting(true) }
    }).catch(() => {}).finally(() => setLoaded(true))
    if (isManager) loadManagerViews()
  }, [isManager])

  const submit = async () => {
    if (rating < 1) { toast.error('Please pick a star rating first.'); return }
    setBusy(true)
    try {
      await api.post('/feedback', {
        rating,
        comment: comment.trim(),
        page: loc.pathname,
        app_version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined,
      })
      toast.success(existing ? 'Feedback updated — thank you!' : 'Thanks for your feedback!')
      setExisting(true)
      if (isManager) loadManagerViews() // refresh the list and the trail
    } catch (err: any) {
      toast.error(err?.message || 'Could not send feedback.')
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal fb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread">
          <h3>Rate this app</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="card-pad">
          {/* Your rating */}
          <section className="fb-rate">
            <div className="fb-rate-q">{existing ? 'Your rating' : 'How would you rate VoTask?'}</div>
            <Stars value={rating} onPick={setRating} size={30} />
            <textarea
              className="fb-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Tell us what's working well or what could be better (optional)"
              rows={3}
              maxLength={2000}
            />
            <button className="btn btn-primary" disabled={busy || !loaded} onClick={submit}>
              {busy ? <span className="spinner" /> : existing ? 'Update feedback' : 'Send feedback'}
            </button>
          </section>

          {/* Manager view: the whole team's reviews + the submission trail */}
          {isManager && summary && (
            <section className="fb-reviews">
              <div className="fb-section-lbl">Team feedback</div>
              {summary.count === 0 ? (
                <div className="muted" style={{ fontSize: 13 }}>No one has rated the app yet.</div>
              ) : (
                <>
                  <div className="fb-tabs" role="tablist" aria-label="Feedback view">
                    <button role="tab" aria-selected={tab === 'reviews'} className={'fb-tab' + (tab === 'reviews' ? ' active' : '')}
                      onClick={() => setTab('reviews')}>Reviews</button>
                    <button role="tab" aria-selected={tab === 'history'} className={'fb-tab' + (tab === 'history' ? ' active' : '')}
                      onClick={() => setTab('history')}>Activity{history?.count ? ` (${history.count})` : ''}</button>
                  </div>
                  {tab === 'reviews' ? <>
                  <div className="fb-summary">
                    <div className="fb-avg">
                      <div className="fb-avg-num">{summary.average}</div>
                      <Stars value={Math.round(summary.average)} size={14} />
                      <div className="muted" style={{ fontSize: 11.5 }}>{summary.count} review{summary.count === 1 ? '' : 's'}</div>
                    </div>
                    <div className="fb-dist">
                      {summary.distribution.map((d: any) => (
                        <div key={d.star} className="fb-dist-row">
                          <span className="fb-dist-star">{d.star}★</span>
                          <span className="fb-dist-track"><span className="fb-dist-fill" style={{ width: `${summary.count ? (d.count / summary.count) * 100 : 0}%` }} /></span>
                          <span className="fb-dist-n muted">{d.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="fb-list">
                    {summary.reviews.map((rv: any) => (
                      <div key={rv.id} className="fb-review">
                        <Avatar name={rv.user_name} color={rv.avatar_color} size={30} src={rv.avatar_file ? userAvatarUrl(rv.user_id, rv.avatar_file) : undefined} />
                        <div className="fb-review-body">
                          <div className="fb-review-top">
                            <span className="fb-review-name">{rv.user_name}</span>
                            <Stars value={rv.rating} size={12} />
                            <span className="muted fb-review-time">{timeAgo(rv.updated_at)}</span>
                          </div>
                          {rv.comment && <div className="fb-review-comment">{rv.comment}</div>}
                          <ContextTags page={rv.page} device={rv.device} sends={rv.submissions} />
                        </div>
                      </div>
                    ))}
                  </div>
                  </> : (
                  /* Activity: every send and edit, newest first — the trail behind
                     the reviews above, including ratings that were later changed. */
                  <div className="fb-list">
                    {!history ? <div className="fb-ev-empty">Loading activity…</div>
                      : history.events.length === 0 ? <div className="fb-ev-empty">No submissions recorded yet.</div>
                      : history.events.map((e: any) => (
                        <div key={e.id} className="fb-ev">
                          <span className={'fb-ev-dot' + (e.kind === 'update' ? ' update' : '')} title={e.kind === 'update' ? 'Updated their feedback' : 'First feedback'}>
                            {e.rating}★
                          </span>
                          <div>
                            <div className="fb-ev-top">
                              <span className="fb-review-name">{e.user_name}</span>
                              <span className="muted" style={{ fontSize: 11.5 }}>
                                {e.kind === 'update' ? 'updated their rating' : 'left feedback'}
                              </span>
                              <span className="fb-ev-when">{stamp(e.created_at)}</span>
                            </div>
                            {e.comment && <div className="fb-review-comment">{e.comment}</div>}
                            <ContextTags page={e.page} device={e.device} version={e.app_version} />
                          </div>
                        </div>
                      ))}
                  </div>
                  )}
                </>
              )}
            </section>
          )}
          {isManager && summary === null && (
            <div className="fb-reviews"><EmptyState icon={<Ic name="star" size={28} />} title="" hint="Loading team feedback…" /></div>
          )}
        </div>
      </div>
    </div>
  )
}
