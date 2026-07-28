import React, { useEffect, useRef, useState } from 'react'
import { useVoiceAssistant } from '../voice/useVoiceAssistant'
import { useWakeWord, wakeWordConfigured, wakeWordPhrase, WakeStatus } from '../voice/wakeword'
import { useDraggable } from '../lib/useDraggable'
import VoiceCard from './VoiceCard'

// Where the draggable "Ask BTM" card remembers its spot (per device).
const FAB_POS_KEY = 'befach_voice_fab_pos'
// The card is only shown — and so only draggable — on desktop/tablet; phones use
// the bottom-nav centre mic instead (see the `.va-fab-pill { display: none }` rule).
const CARD_MQ = '(min-width: 721px)'

const MicIcon = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v1a7 7 0 0 0 14 0v-1" /><line x1="12" y1="19" x2="12" y2="22" />
  </svg>
)
// Small AI sparkle — a static accent so the control reads as an intelligent voice
// assistant, not a plain button. Filled, so it registers at small sizes.
const SparkleIcon = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2l1.9 5.6L19.5 9.5 13.9 11.4 12 17l-1.9-5.6L4.5 9.5l5.6-1.9z" />
    <path d="M19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9z" />
  </svg>
)
const SpeakerIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
)
const SpeakerOffIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5 6 9H2v6h4l5 4z" /><line x1="22" y1="9" x2="16" y2="15" /><line x1="16" y1="9" x2="22" y2="15" />
  </svg>
)

const STATUS_LABEL: Record<string, string> = {
  idle: 'Tap the mic and speak',
  listening: 'Listening…',
  processing: 'Thinking…',
  speaking: 'Speaking…',
  confirming: 'Say “yes” to confirm, or “no”',
  error: 'Something went wrong',
}
// Short, large-type headline shown on the immersive voice screen for each state.
const BIG_STATUS: Record<string, string> = {
  idle: 'Tap to talk',
  listening: 'Listening…',
  processing: 'Thinking…',
  speaking: 'Speaking…',
  confirming: 'Confirm?',
  error: 'Try again',
}
// One-line subtitle under the headline.
const SUB_STATUS: Record<string, string> = {
  idle: 'Tap the orb below to start',
  listening: 'Speak now',
  processing: 'Working on it…',
  speaking: 'Playing the response',
  confirming: 'Say “yes” to confirm, or “no”',
  error: 'Please try again',
}
// The four-stage progress rail shown on the voice screen.
const CheckIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
)
const DotsIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
)
const VOICE_STEPS: { key: string; label: string; icon: React.ReactNode }[] = [
  { key: 'listening', label: 'Listening', icon: <MicIcon size={18} /> },
  { key: 'processing', label: 'Thinking', icon: <DotsIcon /> },
  { key: 'speaking', label: 'Speaking', icon: <SpeakerIcon size={18} /> },
  { key: 'complete', label: 'Complete', icon: <CheckIcon /> },
]
const STEP_INDEX: Record<string, number> = { listening: 0, processing: 1, speaking: 2 }
// Six-dot grip — the standard "you can move this" affordance. Decorative only:
// the whole card is the drag handle, this just advertises it on hover.
const GripIcon = () => (
  <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
    <circle cx="2.5" cy="3" r="1.35" /><circle cx="7.5" cy="3" r="1.35" />
    <circle cx="2.5" cy="8" r="1.35" /><circle cx="7.5" cy="8" r="1.35" />
    <circle cx="2.5" cy="13" r="1.35" /><circle cx="7.5" cy="13" r="1.35" />
  </svg>
)

export default function VoiceAssistant() {
  const v = useVoiceAssistant()
  const logRef = useRef<HTMLDivElement>(null)
  const [confirmPw, setConfirmPw] = useState('')
  const [wake, setWake] = useState<{ status: WakeStatus; detail?: string }>({ status: 'off' })
  // Per-login coachmark: introduces voice (the app's core feature) once each time
  // the user logs in. The flag is set when it shows (so it doesn't re-pop as they
  // navigate — the assistant remounts per route) and CLEARED on login (see auth.tsx),
  // so a fresh sign-in shows it again. Dismissed by Try it / Got it / ✕, by opening
  // the assistant, or automatically after a while.
  const [coach, setCoach] = useState(false)

  // The "Ask BTM" card is a free-floating dock the user can park anywhere on the
  // page — dragging is gated to the widths where the card is actually rendered.
  const [canDrag, setCanDrag] = useState(() => window.matchMedia(CARD_MQ).matches)
  useEffect(() => {
    const mq = window.matchMedia(CARD_MQ)
    const sync = () => setCanDrag(mq.matches)
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  const dock = useDraggable({ storageKey: FAB_POS_KEY, enabled: canDrag })

  // Wake word ("hey btm") — starts a session when heard. No-op until configured;
  // paused while a session is already open so it doesn't retrigger mid-conversation.
  useWakeWord({
    enabled: !v.open,
    onWake: v.start,
    onStatus: (status, detail) => setWake({ status, detail }),
  })

  const dismissCoach = () => {
    setCoach(false)
    try { localStorage.setItem('befach_voice_coach', 'seen') } catch { /* storage off */ }
  }

  // Show the coachmark shortly after login (once per login), unless already shown
  // this session. Marking it seen the moment it appears keeps it from re-popping
  // when the assistant remounts on navigation.
  useEffect(() => {
    let seen = false
    try { seen = localStorage.getItem('befach_voice_coach') === 'seen' } catch { seen = false }
    if (seen) return
    const show = setTimeout(() => {
      setCoach(true)
      try { localStorage.setItem('befach_voice_coach', 'seen') } catch { /* storage off */ }
    }, 1400)
    const hide = setTimeout(() => setCoach(false), 16000) // auto-hide so it's never sticky
    return () => { clearTimeout(show); clearTimeout(hide) }
  }, [])

  // Opening the assistant counts as "seen".
  useEffect(() => { if (v.open) dismissCoach() }, [v.open])

  // The mobile bottom-nav center mic (in App's Layout) opens the assistant by
  // firing an 'open-voice' event — listen for it here where the voice state lives.
  useEffect(() => {
    const open = () => v.start()
    window.addEventListener('open-voice', open)
    return () => window.removeEventListener('open-voice', open)
  }, [v])

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [v.messages, v.state])

  // The coachmark hangs off the card, so it has to flip sides once the card is
  // parked near an edge — otherwise it would point off-screen. Approximate sizes
  // cover the first paint, before the dock has been measured.
  const dockAnchor = (() => {
    if (!dock.pos) return ''  // default corner: coachmark above the card, right-aligned
    const w = dock.ref.current?.offsetWidth || 232
    const h = dock.ref.current?.offsetHeight || 62
    return (dock.pos.x + w / 2 < window.innerWidth / 2 ? ' va-dock--left' : '')
      + (dock.pos.y + h / 2 < window.innerHeight / 2 ? ' va-dock--top' : '')
  })()

  return (
    <>
    <div className="va-root">
      {/* Minimized bar — the session stays live over the page, so the user can
          keep giving commands (speak or tap) without re-triggering the wake word. */}
      {v.open && v.minimized && (
        <div className={'va-mini va-mini--' + v.state} role="dialog" aria-label="Voice assistant (minimized)">
          <button className="va-mini-orb" onClick={v.micButton} title={v.state === 'listening' ? 'Stop' : 'Talk'} aria-label={v.state === 'listening' ? 'Stop' : 'Talk'}>
            {v.state === 'processing'
              ? <span className="spinner" />
              : v.state === 'listening'
                ? <span className="va-mini-wave" aria-hidden="true"><i /><i /><i /><i /></span>
                : <MicIcon size={20} />}
          </button>
          <div className="va-mini-text">
            <div className="va-mini-title">BTM</div>
            <div className="va-mini-status">
              {v.state === 'listening' ? 'Listening — say your next command'
                : v.state === 'processing' ? 'Working…'
                : v.state === 'speaking' ? 'Speaking…'
                : 'Tap to talk'}
            </div>
          </div>
          <button className="va-mini-btn" onClick={() => v.setMinimized(false)} title="Expand" aria-label="Expand">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
          </button>
          <button className="va-mini-btn" onClick={v.close} title="Close" aria-label="Close">✕</button>
        </div>
      )}

      {v.open && !v.minimized && (
        <div className={'va-panel va-panel--' + v.state} role="dialog" aria-label="Voice assistant">
          <div className="va-head">
            <button className="va-iconbtn" title="Close" onClick={v.close} aria-label="Close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <div className="va-head-title">AI Voice Assistant</div>
            <button className="va-iconbtn" title={v.ttsOn ? 'Mute voice replies' : 'Unmute voice replies'} onClick={() => v.setTtsOn(!v.ttsOn)}>
              {v.ttsOn ? <SpeakerIcon /> : <SpeakerOffIcon />}
            </button>
          </div>

          {/* Immersive focal point: status → glowing orb → progress rail. */}
          <div className="va-stage">
            <div className="va-online"><span className="va-online-dot" /> Online</div>
            <div className="va-bigstatus">{BIG_STATUS[v.state] || STATUS_LABEL[v.state] || ''}</div>
            <div className="va-substatus">{SUB_STATUS[v.state] || ''}</div>

            <button className={'va-orb va-orb--' + v.state} onClick={v.micButton} aria-label={v.state === 'listening' ? 'Stop listening' : 'Start talking'}>
              <span className="va-orb-ring va-orb-ring--3" />
              <span className="va-orb-ring va-orb-ring--2" />
              <span className="va-orb-ring" />
              {v.state === 'listening'
                ? <span className="va-wave" aria-hidden="true">{Array.from({ length: 15 }).map((_, i) => <i key={i} />)}</span>
                : v.state === 'processing'
                  ? <span className="va-orb-think" aria-hidden="true"><i /><i /><i /></span>
                  : <span className="va-orb-core" aria-hidden="true" />}
            </button>

            <div className="va-orb-action">
              {v.state === 'listening' ? 'Tap to stop' : v.state === 'idle' ? 'Tap to talk' : ' '}
            </div>

            {/* Four-stage progress rail. */}
            <div className="va-steps">
              {VOICE_STEPS.map((s, i) => {
                const active = STEP_INDEX[v.state] ?? (v.messages.length ? 3 : 0)
                return (
                  <React.Fragment key={s.key}>
                    {i > 0 && <span className={'va-step-line' + (i <= active ? ' done' : '')} />}
                    <div className={'va-step' + (i === active ? ' active' : '') + (i < active ? ' done' : '')}>
                      <span className="va-step-ic">{s.icon}</span>
                      <span className="va-step-label">{s.label}</span>
                      <span className="va-step-dot" />
                    </div>
                  </React.Fragment>
                )
              })}
            </div>
          </div>

          {v.messages.length > 0 && (
            <div className="va-log" ref={logRef}>
              {v.messages.map((m, i) => (
                <React.Fragment key={i}>
                  <div className={'va-msg va-msg--' + m.role}>{m.text}</div>
                  {/* Read tools return figures — show them, don't just say them. */}
                  {m.card && <VoiceCard data={m.card} />}
                </React.Fragment>
              ))}
            </div>
          )}

          {v.pending && (
            <div className="va-confirm">
              <div className="va-confirm-summary">
                {v.pending.needsPassword
                  ? <>Remove <b>{v.pending.to_name}</b>’s account? Enter your password to confirm.</>
                  : v.pending.summary}
              </div>
              {v.pending.needsPassword && (
                <input
                  type="password"
                  className="va-confirm-pw"
                  placeholder="Your password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && confirmPw) { v.confirmPending(confirmPw); setConfirmPw('') } }}
                  autoFocus
                />
              )}
              <div className="row" style={{ gap: 8 }}>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!!v.pending.needsPassword && !confirmPw}
                  onClick={() => { const pw = v.pending?.needsPassword ? confirmPw : undefined; setConfirmPw(''); v.confirmPending(pw) }}
                >✓ Confirm</button>
                <button className="btn btn-sm va-cancel" onClick={() => { setConfirmPw(''); v.cancelPending() }}>✕ Cancel</button>
              </div>
            </div>
          )}

          <div className="va-foot">
            {v.state === 'idle' && v.messages.length === 0 ? (
              <button className="va-mic" onClick={v.micButton} aria-label="Start talking"><MicIcon size={28} /></button>
            ) : (
              <button className="va-cancelbtn" onClick={v.close}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>

    {/* The floating "Ask BTM" card — a dock the user can drag anywhere on screen
        (position remembered per device). It carries the coachmark with it, so the
        tip always points at wherever the card currently sits. */}
    <div
      ref={dock.ref}
      className={'va-dock' + dockAnchor + (dock.dragging ? ' va-dock--dragging' : '')}
      style={dock.style}
    >
      {/* One-time first-visit coachmark, sitting just above the pill and pointing
          at it, so people discover voice — the product's main feature. */}
      {!v.open && coach && (
        <div className="va-coach" role="dialog" aria-label="Voice assistant tip">
          <button className="va-coach-x" onClick={dismissCoach} aria-label="Dismiss">✕</button>
          <span className="va-coach-badge">NEW</span>
          <div className="va-coach-title">Control the app with your voice</div>
          <div className="va-coach-sub">Create tasks, check workload, open meetings — just talk. Tap the mic below{wakeWordConfigured() && <>, or say <b>“{wakeWordPhrase()}”</b></>}.</div>
          <div className="va-coach-actions">
            <button className="btn btn-primary btn-sm" onClick={() => { dismissCoach(); v.start() }}>Try it</button>
            <button className="va-coach-later" onClick={dismissCoach}>Got it</button>
          </div>
        </div>
      )}

      {/* The signature control — voice is the product's core feature, so it's a
          LABELLED pill (not an anonymous icon) with a gentle live pulse, so users
          notice it and know what it does. Hidden while the panel is open (the panel
          has its own footer mic + header ✕), so there's never a second mic. */}
      {!v.open && (
        <button
          className="va-fab-pill"
          // A press that travels more than a few px is a drag, not a tap — the hook
          // reports that so the trailing click doesn't also open the assistant.
          onClick={() => { if (dock.consumeClick()) return; v.start() }}
          title={canDrag ? 'Control the app with your voice · drag to move it anywhere' : 'Control the app with your voice'}
          aria-label={canDrag ? 'Open voice assistant. Drag, or use the arrow keys, to move this card.' : 'Open voice assistant'}
          {...dock.handleProps}
        >
          <span className="va-fab-ic"><MicIcon size={24} /><span className="va-fab-spark"><SparkleIcon size={12} /></span></span>
          <span className="va-fab-label">
            <span className="va-fab-title">Ask BTM</span>
            <span className="va-fab-sub">AI voice assistant</span>
          </span>
          {canDrag && <span className="va-fab-grip"><GripIcon /></span>}
        </button>
      )}
    </div>
    </>
  )
}
