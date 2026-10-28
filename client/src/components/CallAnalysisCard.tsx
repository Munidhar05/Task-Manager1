import { ReactNode, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { Ic } from '../ui'
import { toast } from '../lib/toast'
import { replacesEntry } from '../lib/notifTarget'
import {
  useCallAnalyses, inProgress, isHidden, hideAnalysis, callLabel, putAnalysis,
} from '../lib/callAnalysis'

// The card that takes the call window's place when a call ends, and stays
// until its write-up is done: "Analysing your call with Ravi", the step it is
// on, and where the result will land. When it is ready it asks for the review
// — tasks found on a call are never assigned until someone has looked at them
// — and its button opens that review where the call happened: the summary in
// the chat, whose card carries the same Review & assign button.
//
// Only for a call I was on, and everyone on a call may review it
// (canReviewMeeting on the server). Everyone else in the chat sees the quieter
// line in the thread (Chats).

const STEPS = ['Call ended', 'Collecting the transcript', 'Summarising and finding tasks', 'Your review']

export default function CallAnalysisCard({ me }: { me: { id: string } }) {
  const all = useCallAnalyses()
  const navigate = useNavigate()
  const loc = useLocation()
  // The newest call of mine still worth showing. One at a time: two calls
  // ending within a minute is rare, and the second shows when the first goes.
  const a = all.find((x) => x.stage !== 'reviewed' && x.joined.some((p) => p.id === me.id) && !isHidden(x))
  const [, tick] = useState(0)
  const [retrying, setRetrying] = useState(false)

  // A seconds counter while it works, so a long call's analysis visibly is
  // still going rather than looking stuck.
  const working = !!a && inProgress(a)
  useEffect(() => {
    if (!working) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [working])

  // "Nothing was heard" needs no answer; it goes by itself.
  useEffect(() => {
    if (!a || a.stage !== 'empty') return
    const t = setTimeout(() => hideAnalysis(a), 12000)
    return () => clearTimeout(t)
  }, [a?.callId, a?.stage])

  if (!a) return null
  const label = callLabel(a, me.id)
  const Label = label.charAt(0).toUpperCase() + label.slice(1)
  const found = a.found || 0
  const unowned = Math.max(0, found - (a.owned || 0))
  const where = a.conversationType === 'group' ? `in ${a.conversationName || 'the group'}` : 'in your chat'

  const go = (to: string) => navigate(to, { replace: replacesEntry(to, loc.pathname) })
  const openChat = () => {
    const q = new URLSearchParams({ c: a.conversationId })
    if (a.messageId) q.set('msg', a.messageId)
    hideAnalysis(a)
    go(`/chats?${q}`)
  }
  // The chat, with its summary open on the review (Chats reads ?review=).
  const review = () => {
    const q = new URLSearchParams({ c: a.conversationId, review: a.meetingId || '' })
    hideAnalysis(a)
    go(`/chats?${q}`)
  }
  const retry = async () => {
    setRetrying(true)
    try {
      const d = await api.post(`/chat/call/${a.callId}/analyse`)
      // Done already, by another device or an older copy of the app.
      if (d?.existing) putAnalysis({ ...a, stage: 'ready', meetingId: d.meetingId, at: new Date().toISOString() })
    } catch (e: any) {
      toast.error(e.message || 'Could not start the analysis again')
    } finally { setRetrying(false) }
  }

  // Which step is current (the ones before it are done).
  const step = a.stage === 'waiting' ? 1 : a.stage === 'analysing' ? 2 : found > 0 ? 3 : 4
  const secs = Math.max(0, Math.round((Date.now() - new Date(a.endedAt).getTime()) / 1000))
  const elapsed = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

  let icon: ReactNode
  let head: string
  let body: ReactNode
  let actions: ReactNode
  if (working) {
    icon = <span className="ca-spin" aria-hidden="true" />
    head = `Analysing ${label}`
    body = (
      <>
        {a.stage === 'waiting' ? 'Collecting the last words from everyone on the call…' : 'Writing the summary and finding the tasks that were agreed…'}
        {' '}<span className="ca-elapsed">{elapsed}</span>
        <span className="ca-where">
          The summary will appear {where}. Nothing is assigned until you review it there.
        </span>
      </>
    )
    actions = <button type="button" className="btn btn-sm" onClick={() => hideAnalysis(a)}>Hide</button>
  } else if (a.stage === 'ready' && found > 0) {
    icon = <span className="ca-ic ok"><Ic name="ai" size={17} /></span>
    head = `${Label} is analysed`
    body = (
      <>
        {a.assigned
          ? <><b>{found} suggested task{found === 1 ? '' : 's'}</b> still to review — {a.assigned} already assigned. Check each owner and due date, then assign.</>
          : <><b>{found} suggested task{found === 1 ? '' : 's'}</b> — nothing has been assigned yet. Check each owner and due date, then assign.</>}
        {unowned > 0 && <span className="ca-where">{unowned} still need{unowned === 1 ? 's' : ''} an owner.</span>}
      </>
    )
    actions = (
      <>
        <button type="button" className="btn btn-sm" onClick={() => hideAnalysis(a)}>Later</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={review}>Review &amp; assign</button>
      </>
    )
  } else if (a.stage === 'ready') {
    icon = <span className="ca-ic ok"><Ic name="check" size={17} /></span>
    head = `${Label} is analysed`
    body = `No tasks were found in it. The summary is ${where}.`
    actions = (
      <>
        <button type="button" className="btn btn-sm" onClick={() => hideAnalysis(a)}>Close</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={openChat}>See summary</button>
      </>
    )
  } else if (a.stage === 'empty') {
    icon = <span className="ca-ic"><Ic name="micOff" size={17} /></span>
    head = 'Nothing to analyse'
    body = `No speech was captured on ${label}, so there is no summary or task to review.`
    actions = <button type="button" className="btn btn-sm" onClick={() => hideAnalysis(a)}>Close</button>
  } else {
    icon = <span className="ca-ic warn"><Ic name="warning" size={17} /></span>
    head = `Couldn't analyse ${label}`
    body = 'What was said is kept, so it can be tried again.'
    actions = (
      <>
        <button type="button" className="btn btn-sm" onClick={() => hideAnalysis(a)}>Close</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={retry} disabled={retrying}>{retrying ? 'Starting…' : 'Try again'}</button>
      </>
    )
  }

  return (
    <section className={'ca-card ca-' + a.stage} data-call={a.callId} role="status" aria-live="polite" aria-label="Call analysis">
      <div className="ca-head">
        {icon}
        <div className="ca-title">{head}</div>
      </div>
      {(working || (a.stage === 'ready' && found > 0)) && (
        <ol className="ca-steps" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s} className={i < step ? 'done' : i === step ? 'now' : ''} aria-current={i === step ? 'step' : undefined}>
              <span className="ca-dot" aria-hidden="true">{i < step ? <Ic name="check" size={10} /> : null}</span>
              <span className="ca-step">{s}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="ca-body">{body}</div>
      <div className="ca-actions">{actions}</div>
    </section>
  )
}
