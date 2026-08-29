import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { useEscape } from '../lib/useEscape'
import { toast } from '../lib/toast'
import FeedbackReviews, { Stars } from './FeedbackReviews'

// In-app feedback. Everyone can leave a star rating + comment about the app (and
// update it later). Managers/admins also see the whole org's reviews, the
// average, and the submission trail — who sent what, when, from which screen and
// which device. Opens from the corner Feedback tab, the sidebar and the profile
// menu.

export default function FeedbackModal({ onClose }: { onClose: () => void }) {
  const { user } = useAuth()
  useEscape(onClose)
  const isManager = user?.role !== 'employee'
  // Where the user was when they opened the form — recorded with the submission
  // so a manager can see which screen prompted the comment.
  const loc = useLocation()
  const nav = useNavigate()

  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  // Which chips are picked, and the vocabulary they come from. The list is
  // fetched rather than hard-coded so the form can only offer labels the server
  // will actually accept — a second copy here would drift the moment either moved.
  const [tags, setTags] = useState<string[]>([])
  const [tagOptions, setTagOptions] = useState<{ like: string[]; improve: string[] }>({ like: [], improve: [] })
  const [existing, setExisting] = useState(false)   // has the user rated before?
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // Bumped after a submit so the manager list below re-reads and shows what was
  // just sent — the list owns its own fetching, this is the only lever over it.
  const [reloadKey, setReloadKey] = useState(0)

  // Load the user's own rating, to pre-fill the form.
  useEffect(() => {
    api.get('/feedback/mine').then((r) => {
      if (r) { setRating(r.rating); setComment(r.comment || ''); setTags(r.tags || []); setExisting(true) }
    }).catch(() => {}).finally(() => setLoaded(true))
    api.get('/feedback/tags').then(setTagOptions).catch(() => {})
  }, [])

  // 4-5★ asks what worked, 1-3★ asks what didn't. Nothing is asked until a
  // rating is picked — the question only makes sense once we know which one it is.
  const positive = rating >= 4
  const question = positive ? 'What do you like most?' : 'What could we improve?'
  const options = positive ? tagOptions.like : tagOptions.improve
  // Crossing the 3/4 boundary swaps the question, so keep only the chips that
  // exist in the new list. Without this a 5★ "Easy to use" would silently ride
  // along on a 2★ answer to a question it was never given for.
  const pickRating = (n: number) => {
    const next = n >= 4 ? tagOptions.like : tagOptions.improve
    setTags((cur) => cur.filter((t) => next.includes(t)))
    setRating(n)
  }
  const toggleTag = (t: string) => setTags((cur) => cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t])

  const submit = async () => {
    if (rating < 1) { toast.error('Please pick a star rating first.'); return }
    setBusy(true)
    try {
      await api.post('/feedback', {
        rating,
        comment: comment.trim(),
        tags,
        page: loc.pathname,
        app_version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined,
      })
      toast.success(existing ? 'Feedback updated — thank you!' : 'Thanks for your feedback!')
      setExisting(true)
      setReloadKey((k) => k + 1) // refresh the list and the trail
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
            <Stars value={rating} onPick={pickRating} size={30} />
            {rating > 0 && options.length > 0 && (
              <div className="fb-ask">
                <div className="fb-ask-q" id="fb-ask-q">{question}</div>
                <div className="fb-chips" role="group" aria-labelledby="fb-ask-q">
                  {options.map((t) => {
                    const on = tags.includes(t)
                    return (
                      <button
                        key={t}
                        type="button"
                        className={'fb-chip' + (on ? ' on' : '')}
                        aria-pressed={on}
                        onClick={() => toggleTag(t)}
                      >
                        {t}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            <textarea
              className="fb-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={rating === 0
                ? "Tell us what's working well or what could be better (optional)"
                : positive ? 'Anything else you like? (optional)' : 'Tell us more about what to fix (optional)'}
              rows={3}
              maxLength={2000}
            />
            <button className="btn btn-primary" disabled={busy || !loaded} onClick={submit}>
              {busy ? <span className="spinner" /> : existing ? 'Update feedback' : 'Send feedback'}
            </button>
          </section>

          {/* Manager view: the whole team's reviews + the submission trail. Same
              component as Administration › Feedback, which is the roomier home
              for it — this stays so a manager who just rated can see the effect. */}
          {isManager && (
            <section className="fb-reviews">
              <div className="fb-section-lbl">
                Team feedback
                <button className="fb-section-link" onClick={() => { onClose(); nav('/admin?tab=feedback') }}>
                  Open in Administration
                </button>
              </div>
              <FeedbackReviews reloadKey={reloadKey} />
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
