import { useEffect, useState } from 'react'
import { api, userAvatarUrl } from '../api'
import { Avatar, Ic, EmptyState } from '../ui'

// The manager/admin view of app feedback: the average, the star histogram, one
// card per person, and the append-only submission trail behind it.
//
// Lives here rather than inside FeedbackModal because it now has two homes — the
// modal (under your own rating form) and the Administration › Feedback tab. Two
// copies would drift the moment either one gained a column.
//
// Both endpoints are manager/admin-only server-side, so an employee rendering
// this just sees the empty state; the gate is not this component's job.

// A row of five stars, clickable when interactive.
export function Stars({ value, onPick, size = 22 }: { value: number; onPick?: (n: number) => void; size?: number }) {
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

// SQLite timestamps come back without a zone; treat a bare one as UTC or every
// reading is off by the viewer's offset.
const asDate = (raw?: string) => {
  if (!raw) return NaN
  const s = /\dT|\dZ|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z'
  return Date.parse(s)
}
export const timeAgo = (raw?: string) => {
  const ms = asDate(raw); if (isNaN(ms)) return ''
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (sec < 60) return 'just now'
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago'
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago'
  return Math.floor(sec / 86400) + 'd ago'
}
// Absolute date + time for the trail, where "2d ago" is too vague to act on.
export const stamp = (raw?: string) => {
  const ms = asDate(raw); if (isNaN(ms)) return ''
  return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

// The screen / device / build chips shown under a review or a trail entry.
export function ContextTags({ page, device, version, sends }: { page?: string; device?: string; version?: string; sends?: number }) {
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

// `reloadKey` — bump it to refetch. The modal does that after a submit so the
// list below the form reflects what was just sent.
export default function FeedbackReviews({ reloadKey = 0 }: { reloadKey?: number }) {
  const [summary, setSummary] = useState<any>(null)
  const [history, setHistory] = useState<any>(null)
  const [tab, setTab] = useState<'reviews' | 'history'>('reviews')

  useEffect(() => {
    api.get('/feedback').then(setSummary).catch(() => setSummary({ count: 0, average: null, distribution: [], reviews: [] }))
    api.get('/feedback/history').then(setHistory).catch(() => setHistory({ count: 0, events: [] }))
  }, [reloadKey])

  if (summary === null) return <EmptyState icon={<Ic name="star" size={28} />} title="" hint="Loading team feedback…" />
  if (summary.count === 0) {
    return <EmptyState icon={<Ic name="star" size={28} />} title="No feedback yet" hint="Ratings people leave through the Feedback tab will show up here." />
  }

  return (
    <>
      <div className="fb-tabs" role="tablist" aria-label="Feedback view">
        <button role="tab" aria-selected={tab === 'reviews'} className={'fb-tab' + (tab === 'reviews' ? ' active' : '')}
          onClick={() => setTab('reviews')}>Reviews</button>
        <button role="tab" aria-selected={tab === 'history'} className={'fb-tab' + (tab === 'history' ? ' active' : '')}
          onClick={() => setTab('history')}>Activity{history?.count ? ` (${history.count})` : ''}</button>
      </div>

      {tab === 'reviews' ? (
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
                <Avatar name={rv.user_name} color={rv.avatar_color} size={30} src={rv.avatar_file ? userAvatarUrl(rv.user_id, rv.avatar_file) : undefined} />
                <div className="fb-review-body">
                  <div className="fb-review-top">
                    <span className="fb-review-name">{rv.user_name}</span>
                    <Stars value={rv.rating} size={12} />
                    <span className="muted fb-review-time">{timeAgo(rv.updated_at)}</span>
                  </div>
                  {rv.comment && <div className="fb-review-comment">{rv.comment}</div>}
                  {rv.tags?.length > 0 && (
                    <div className="fb-review-tags">{rv.tags.map((t: string) => <span key={t} className="fb-review-tag">{t}</span>)}</div>
                  )}
                  <ContextTags page={rv.page} device={rv.device} sends={rv.submissions} />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        /* Activity: every send and edit, newest first — the trail behind the
           reviews above, including ratings that were later changed. */
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
                  {e.tags?.length > 0 && (
                    <div className="fb-review-tags">{e.tags.map((t: string) => <span key={t} className="fb-review-tag">{t}</span>)}</div>
                  )}
                  <ContextTags page={e.page} device={e.device} version={e.app_version} />
                </div>
              </div>
            ))}
        </div>
      )}
    </>
  )
}
