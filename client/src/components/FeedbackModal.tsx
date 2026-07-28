import { useEffect, useState } from 'react'
import { api, userAvatarUrl } from '../api'
import { useAuth } from '../auth'
import { Avatar, Ic, EmptyState } from '../ui'
import { useEscape } from '../lib/useEscape'
import { toast } from '../lib/toast'

// In-app feedback. Everyone can leave a star rating + comment about the app (and
// update it later). Managers/admins also see the whole org's reviews and the
// average, so they can gauge how the team rates the product. Opens from the
// sidebar and the profile menu.

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

export default function FeedbackModal({ onClose }: { onClose: () => void }) {
  const { user } = useAuth()
  useEscape(onClose)
  const isManager = user?.role !== 'employee'

  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [existing, setExisting] = useState(false)   // has the user rated before?
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<any>(null)  // manager view
  const [loaded, setLoaded] = useState(false)

  // Load the user's own rating (pre-fill) and, for managers, the org summary.
  useEffect(() => {
    api.get('/feedback/mine').then((r) => {
      if (r) { setRating(r.rating); setComment(r.comment || ''); setExisting(true) }
    }).catch(() => {}).finally(() => setLoaded(true))
    if (isManager) api.get('/feedback').then(setSummary).catch(() => {})
  }, [isManager])

  const submit = async () => {
    if (rating < 1) { toast.error('Please pick a star rating first.'); return }
    setBusy(true)
    try {
      await api.post('/feedback', { rating, comment: comment.trim() })
      toast.success(existing ? 'Feedback updated — thank you!' : 'Thanks for your feedback!')
      setExisting(true)
      if (isManager) api.get('/feedback').then(setSummary).catch(() => {}) // refresh the list
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

          {/* Manager view: the whole team's reviews */}
          {isManager && summary && (
            <section className="fb-reviews">
              <div className="fb-section-lbl">Team feedback</div>
              {summary.count === 0 ? (
                <div className="muted" style={{ fontSize: 13 }}>No one has rated the app yet.</div>
              ) : (
                <>
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
                        <Avatar name={rv.user_name} color={rv.avatar_color} size={30} src={rv.avatar_file ? userAvatarUrl(rv.id, rv.avatar_file) : undefined} />
                        <div className="fb-review-body">
                          <div className="fb-review-top">
                            <span className="fb-review-name">{rv.user_name}</span>
                            <Stars value={rv.rating} size={12} />
                            <span className="muted fb-review-time">{timeAgo(rv.updated_at)}</span>
                          </div>
                          {rv.comment && <div className="fb-review-comment">{rv.comment}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
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
