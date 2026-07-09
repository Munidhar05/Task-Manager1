import React, { useEffect, useRef } from 'react'
import { useVoiceAssistant } from '../voice/useVoiceAssistant'
import { useWakeWord, wakeWordConfigured } from '../voice/wakeword'

const MicIcon = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v1a7 7 0 0 0 14 0v-1" /><line x1="12" y1="19" x2="12" y2="22" />
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

export default function VoiceAssistant() {
  const v = useVoiceAssistant()
  const logRef = useRef<HTMLDivElement>(null)

  // Wake word ("hey btm") — starts a session when heard. No-op until configured;
  // paused while a session is already open so it doesn't retrigger mid-conversation.
  useWakeWord({ enabled: !v.open, onWake: v.start })

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [v.messages, v.state])

  // Level-driven glow scale for the listening ring.
  const ringScale = 1 + Math.min(0.6, v.level * 0.9)

  return (
    <div className="va-root">
      {v.open && (
        <div className="va-panel" role="dialog" aria-label="Voice assistant">
          <div className="va-head">
            <div className="va-title">
              <span className={'va-dot va-dot--' + v.state} />
              BTM Voice
            </div>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn btn-ghost btn-sm" title={v.ttsOn ? 'Mute voice replies' : 'Unmute voice replies'} onClick={() => v.setTtsOn(!v.ttsOn)}>
                {v.ttsOn ? <SpeakerIcon /> : <SpeakerOffIcon />}
              </button>
              <button className="btn btn-ghost btn-sm" title="Close" onClick={v.close}>✕</button>
            </div>
          </div>

          <div className="va-log" ref={logRef}>
            {v.messages.length === 0 && (
              <div className="va-hint">
                {wakeWordConfigured() ? 'Say “hey BTM”, or tap the mic.' : 'Tap the mic and speak.'}<br />
                Try: “Create a high priority task for Reddy to finish the logo by Friday.”
              </div>
            )}
            {v.messages.map((m, i) => (
              <div key={i} className={'va-msg va-msg--' + m.role}>{m.text}</div>
            ))}
          </div>

          {v.pending && (
            <div className="va-confirm">
              <div className="va-confirm-summary">{v.pending.summary}</div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={v.confirmPending}>✓ Confirm</button>
                <button className="btn btn-sm" onClick={v.cancelPending}>✕ Cancel</button>
              </div>
            </div>
          )}

          <div className="va-foot">
            <div className="va-status">{STATUS_LABEL[v.state] || ''}</div>
            <button
              className={'va-mic va-mic--' + v.state}
              onClick={v.micButton}
              title={v.state === 'listening' ? 'Stop' : 'Speak'}
              style={v.state === 'listening' ? { boxShadow: `0 0 0 ${Math.round(v.level * 16)}px rgba(197,86,15,.12)` } : undefined}
            >
              {v.state === 'processing' ? <span className="spinner" /> : <MicIcon />}
            </button>
          </div>
        </div>
      )}

      <button
        className={'va-fab va-fab--' + v.state + (v.open ? ' va-fab--open' : '')}
        onClick={() => (v.open ? v.close() : v.start())}
        title="Voice assistant"
        aria-label="Voice assistant"
        style={v.state === 'listening' ? { transform: `scale(${ringScale.toFixed(2)})` } : undefined}
      >
        <MicIcon size={22} />
      </button>
    </div>
  )
}
