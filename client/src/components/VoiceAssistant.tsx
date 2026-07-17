import React, { useEffect, useRef, useState } from 'react'
import { useVoiceAssistant } from '../voice/useVoiceAssistant'
import { useWakeWord, wakeWordConfigured, wakeWordPhrase, WakeStatus } from '../voice/wakeword'
import VoiceCard from './VoiceCard'

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

export default function VoiceAssistant() {
  const v = useVoiceAssistant()
  const logRef = useRef<HTMLDivElement>(null)
  const [wake, setWake] = useState<{ status: WakeStatus; detail?: string }>({ status: 'off' })
  // Per-login coachmark: introduces voice (the app's core feature) once each time
  // the user logs in. The flag is set when it shows (so it doesn't re-pop as they
  // navigate — the assistant remounts per route) and CLEARED on login (see auth.tsx),
  // so a fresh sign-in shows it again. Dismissed by Try it / Got it / ✕, by opening
  // the assistant, or automatically after a while.
  const [coach, setCoach] = useState(false)

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

  return (
    <div className="va-root">
      {v.open && (
        <div className={'va-panel va-panel--' + v.state} role="dialog" aria-label="Voice assistant">
          <div className="va-head">
            <div className="va-title">
              <span className={'va-dot va-dot--' + v.state} />
              BTM Voice
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="va-iconbtn" title={v.ttsOn ? 'Mute voice replies' : 'Unmute voice replies'} onClick={() => v.setTtsOn(!v.ttsOn)}>
                {v.ttsOn ? <SpeakerIcon /> : <SpeakerOffIcon />}
              </button>
              <button className="va-iconbtn" title="Close" onClick={v.close}>✕</button>
            </div>
          </div>

          {/* The glowing orb + big status headline — the immersive focal point. */}
          <div className="va-stage">
            <div className="va-bigstatus">{BIG_STATUS[v.state] || STATUS_LABEL[v.state] || ''}</div>
            <div className={'va-orb va-orb--' + v.state} aria-hidden="true">
              <span className="va-orb-halo" />
              <span className="va-orb-core" />
            </div>
            {v.messages.length === 0 && v.state === 'idle' && (
              <div className="va-substatus">
                {wakeWordConfigured() && wake.status === 'listening'
                  ? <>Say “<b>{wakeWordPhrase()}</b>”, or tap the mic below.</>
                  : 'I can help with tasks, summaries, reports and more — just talk.'}
              </div>
            )}
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
              <div className="va-confirm-summary">{v.pending.summary}</div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={v.confirmPending}>✓ Confirm</button>
                <button className="btn btn-sm va-cancel" onClick={v.cancelPending}>✕ Cancel</button>
              </div>
            </div>
          )}

          <div className="va-foot">
            <button
              className={'va-mic va-mic--' + v.state}
              onClick={v.micButton}
              title={v.state === 'listening' ? 'Stop' : 'Speak'}
            >
              {v.state === 'processing' ? <span className="spinner" /> : <MicIcon size={28} />}
            </button>
          </div>
        </div>
      )}

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

      {/* Wake-word status chip (only while the panel is closed + wake word on), so
          it's visible that the app IS listening for the phrase — and diagnosable if
          it isn't (loading / needs a click / errored). */}
      {!v.open && wakeWordConfigured() && wake.status !== 'off' && (
        <div className={'va-wake-chip va-wake-chip--' + wake.status} role="status">
          <span className="va-wake-dot" />
          {wake.status === 'listening' ? <>Listening for “<b>{wakeWordPhrase()}</b>”</>
            : wake.status === 'loading' ? 'Starting wake word…'
            : wake.status === 'awaiting-gesture' ? <>Tap anywhere to enable “<b>{wakeWordPhrase()}</b>”</>
            : wake.status === 'error' ? 'Wake word off — tap the mic' : ''}
        </div>
      )}

      {/* The signature control — voice is the product's core feature, so it's a
          LABELLED pill (not an anonymous icon) with a gentle live pulse, so users
          notice it and know what it does. Hidden while the panel is open (the panel
          has its own footer mic + header ✕), so there's never a second mic. */}
      {!v.open && (
        <button
          className="va-fab-pill"
          onClick={v.start}
          title="Control the app with your voice"
          aria-label="Open voice assistant"
        >
          <span className="va-fab-ic"><MicIcon size={24} /><span className="va-fab-spark"><SparkleIcon size={12} /></span></span>
          <span className="va-fab-label">
            <span className="va-fab-title">Ask BTM</span>
            <span className="va-fab-sub">AI voice assistant</span>
          </span>
        </button>
      )}
    </div>
  )
}
