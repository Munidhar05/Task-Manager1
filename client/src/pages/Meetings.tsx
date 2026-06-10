import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, getToken, API_BASE } from '../api'
import { useAuth } from '../auth'
import { LANG_LABEL } from '../ui'
import ParticipantPicker from '../components/ParticipantPicker'
import { startPcmStream, PcmStream } from '../lib/pcmStream'

// Preset meeting titles for the dropdown; "Other" lets the user type a custom one.
const MEETING_TITLES = ['Tech Meeting', 'Marketing Meeting', 'Sales Meeting', 'HR Meeting', 'Both Tech and Marketing']

// Meeting-title field: a dropdown of presets plus an "Other" option that reveals
// a free-text input. An existing custom title (not in the presets) opens as "Other".
function MeetingTitleSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isPreset = MEETING_TITLES.includes(value)
  const [isOther, setIsOther] = useState(value !== '' && !isPreset)
  const selectValue = isOther ? '__other__' : (isPreset ? value : '')
  const pick = (v: string) => {
    if (v === '__other__') { setIsOther(true); onChange('') }
    else { setIsOther(false); onChange(v) }
  }
  return (
    <>
      <label>Meeting title</label>
      <select value={selectValue} onChange={(e) => pick(e.target.value)}>
        <option value="">Select meeting type…</option>
        {MEETING_TITLES.map((t) => <option key={t} value={t}>{t}</option>)}
        <option value="__other__">Other (enter manually)</option>
      </select>
      {isOther && (
        <input style={{ marginTop: 8 }} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Enter meeting title" autoFocus />
      )}
    </>
  )
}

const SAMPLE = `Priya: Good morning team. Let's start the standup.
Priya: Munidhar, complete the login API by Friday. It's high priority.
Munidhar: Sure Priya, I'll finish it by Friday.
Priya: Ravi, deployment documentation ready cheyyandi by tomorrow.
Ravi: Theek hai, kal tak ready kar dunga.
Priya: Anjali, payment gateway ka testing aaj complete karo, it's urgent.`

export default function Meetings() {
  const { user } = useAuth()
  const nav = useNavigate()
  const [meetings, setMeetings] = useState<any[]>([])
  const [showUpload, setShowUpload] = useState(false)
  const [showLive, setShowLive] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const load = () => api.get('/meetings').then(setMeetings)
  useEffect(() => { load() }, [])
  const isManager = user?.role !== 'employee'

  const del = async (m: any) => {
    if (!window.confirm(`Delete "${m.title}" and its ${m.task_count || 0} extracted task(s)? This cannot be undone.`)) return
    await api.del('/meetings/' + m.id)
    load()
  }

  return (
    <>
      <div className="toolbar">
        <div className="muted">{meetings.length} meeting(s) processed</div>
        {isManager && (
          <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
            <button className="btn btn-primary" onClick={() => setShowLive(true)}>● Start meeting</button>
            <button className="btn" onClick={() => setShowUpload(true)}>+ Upload meeting</button>
          </div>
        )}
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {meetings.map((m) => (
          <div key={m.id} className="card clickable" onClick={() => nav('/meetings/' + m.id)}>
            <div className="card-pad">
              <div className="spread">
                <h3 style={{ fontSize: 15 }}>{m.title}</h3>
                <span className="badge" style={{ background: '#fbe9d6', color: '#c5560f' }}>{m.engine}</span>
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{(m.meeting_date || '').slice(0, 10)}</div>
              <p className="muted" style={{ fontSize: 13, marginTop: 10, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {m.summary?.executive_summary || 'No summary.'}
              </p>
              <div className="spread" style={{ marginTop: 12 }}>
                <span className="tag-list">
                  {(m.detected_languages || []).map((l: string) => <span key={l} className="lang-tag">{LANG_LABEL[l] || l}</span>)}
                </span>
                <strong style={{ fontSize: 13 }}>
                  {m.pending_count ? <span style={{ color: '#c5560f' }}>{m.pending_count} pending review</span> : `${m.task_count} tasks`}
                </strong>
              </div>
              {isManager && (
                <div className="row" style={{ gap: 6, marginTop: 12 }} onClick={(e) => e.stopPropagation()}>
                  <button className="btn btn-sm" onClick={() => setEditing(m)}>✎ Edit</button>
                  <button className="btn btn-sm btn-danger" onClick={() => del(m)}>🗑 Delete</button>
                </div>
              )}
            </div>
          </div>
        ))}
        {meetings.length === 0 && <div className="empty">No meetings yet. Upload one to see the AI extract tasks.</div>}
      </div>
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onDone={(id) => { setShowUpload(false); load(); nav('/meetings/' + id) }} />}
      {showLive && <LiveMeetingModal defaultSpeaker={user?.name || 'Manager'} onClose={() => setShowLive(false)} onDone={(id) => { setShowLive(false); load(); nav('/meetings/' + id) }} />}
      {editing && <EditMeetingModal meeting={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
    </>
  )
}

function EditMeetingModal({ meeting, onClose, onSaved }: { meeting: any; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(meeting.title || '')
  const [date, setDate] = useState((meeting.meeting_date || '').slice(0, 10))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try { await api.patch('/meetings/' + meeting.id, { title, meeting_date: date }); onSaved() }
    finally { setBusy(false) }
  }
  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3>Edit meeting</h3><button className="btn btn-ghost" onClick={onClose}>✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          <div><MeetingTitleSelect value={title} onChange={setTitle} /></div>
          <div><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={busy || !title.trim()}>{busy ? <span className="spinner" /> : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function UploadModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [mode, setMode] = useState<'text' | 'audio'>('audio')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [participants, setParticipants] = useState<string[]>([])
  const [transcript, setTranscript] = useState('')
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [provider, setProvider] = useState('none')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Is server-side speech-to-text available? (drives the audio option)
  useEffect(() => {
    fetch(`${API_BASE}/api/health`).then((r) => r.json()).then((d) => setProvider(d.transcription || 'none')).catch(() => {})
  }, [])
  const audioAvailable = provider !== 'none'

  // Upload a full audio file → server transcribes it → extracts summary & tasks.
  const uploadAudio = async (): Promise<string> => {
    const form = new FormData()
    form.append('audio', audioFile!, audioFile!.name)
    form.append('title', title || 'Recorded Meeting')
    form.append('description', description)
    form.append('meeting_date', date)
    form.append('participant_ids', JSON.stringify(participants))
    const res = await fetch(`${API_BASE}/api/meetings/audio`, { method: 'POST', headers: { authorization: `Bearer ${getToken()}` }, body: form })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Audio processing failed')
    return data.id
  }

  const process = async () => {
    setErr(''); setBusy(true)
    try {
      let rid: string
      if (mode === 'audio') {
        if (!audioFile) { setErr('Choose an audio file first.'); setBusy(false); return }
        rid = await uploadAudio()
      } else {
        const r = await api.post('/meetings', { title: title || 'Untitled Meeting', description, meeting_date: date, transcript, participant_ids: participants })
        rid = r.id
      }
      onDone(rid)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const fileMB = audioFile ? (audioFile.size / 1024 / 1024).toFixed(1) : null
  const canSubmit = mode === 'audio' ? !!audioFile : !!transcript.trim()

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3>Upload meeting</h3><button className="btn btn-ghost" onClick={onClose}>✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          {/* source toggle */}
          <div className="row" style={{ gap: 8 }}>
            <button className={'btn btn-sm' + (mode === 'audio' ? ' btn-primary' : '')} onClick={() => setMode('audio')}>🎵 Upload audio file</button>
            <button className={'btn btn-sm' + (mode === 'text' ? ' btn-primary' : '')} onClick={() => setMode('text')}>📝 Paste transcript</button>
          </div>

          <div className="grid grid-3" style={{ gap: 10 }}>
            <div style={{ gridColumn: 'span 2' }}><MeetingTitleSelect value={title} onChange={setTitle} /></div>
            <div><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          </div>
          <div><label>Description <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label><textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this meeting about?" /></div>
          <div><label>Participants <span className="muted" style={{ fontWeight: 400 }}>(only these people can be assigned tasks)</span></label><ParticipantPicker value={participants} onChange={setParticipants} /></div>

          {mode === 'audio' ? (
            <div>
              <label>Audio recording <span className="muted" style={{ fontWeight: 400 }}>(mp3, wav, m4a, webm… up to 25&nbsp;MB)</span></label>
              {!audioAvailable && (
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 8 }}>
                  Speech-to-text isn't active. Set <b>TRANSCRIPTION_PROVIDER</b> + the matching API key in <b>server/.env</b> and restart the backend.
                </div>
              )}
              <label className="audio-drop">
                <input type="file" accept="audio/*" style={{ display: 'none' }} onChange={(e) => { setAudioFile(e.target.files?.[0] || null); setErr('') }} />
                {audioFile
                  ? <span>🎵 <b>{audioFile.name}</b> <span className="muted">({fileMB} MB)</span> — click to change</span>
                  : <span className="muted">🎤 Click to choose an audio file</span>}
              </label>
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>The recording is transcribed (any language — Telugu / Hindi / English / mixed), then the summary &amp; tasks are generated in <b>English</b>.</div>
            </div>
          ) : (
            <div>
              <div className="spread"><label>Transcript (Telugu / Hindi / English / mixed)</label><button className="btn btn-sm btn-ghost" onClick={() => setTranscript(SAMPLE)}>Insert sample</button></div>
              <textarea rows={9} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder={'Format each line as "Speaker: text"\n\n' + SAMPLE.split('\n').slice(0, 2).join('\n')} style={{ fontFamily: 'monospace', fontSize: 12.5 }} />
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Any language — the summary and tasks are always generated in <b>English</b>.</div>
            </div>
          )}

          {err && <div style={{ color: '#ef4444', fontSize: 13 }}>{err}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={process} disabled={busy || !canSubmit}>
              {busy ? <><span className="spinner" /> {mode === 'audio' ? 'Transcribing & analyzing…' : 'Analyzing…'}</> : '✦ Analyze & extract tasks'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Live "Start meeting" recorder.
// AUTO mode: records the mic in short segments and streams them to the server's speech-to-text
//   (Sarvam / Whisper), which auto-detects language & code-mixing — so a freely mixed
//   Telugu/Hindi/English meeting transcribes continuously, at any length.
// BROWSER mode (no API key): uses the browser's Web Speech API, one language at a time.
const REC_LANGS = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'hi-IN', label: 'हिन्दी (Hindi)' },
  { code: 'te-IN', label: 'తెలుగు (Telugu)' },
]

// Record one self-contained audio segment of `ms` milliseconds from a live mic stream.
function recordSegment(stream: MediaStream, ms: number): Promise<Blob> {
  return new Promise((resolve) => {
    const chunks: BlobPart[] = []
    let mr: MediaRecorder
    try { mr = new MediaRecorder(stream, { mimeType: 'audio/webm' }) } catch { mr = new MediaRecorder(stream) }
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    mr.onstop = () => resolve(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }))
    mr.start()
    setTimeout(() => { try { if (mr.state !== 'inactive') mr.stop() } catch {} }, ms)
  })
}

function LiveMeetingModal({ defaultSpeaker, onClose, onDone }: { defaultSpeaker: string; onClose: () => void; onDone: (id: string) => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [participants, setParticipants] = useState<string[]>([])
  const date = new Date().toISOString().slice(0, 10)
  const [speaker, setSpeaker] = useState(defaultSpeaker)
  const [lang, setLang] = useState('en-IN')
  const [provider, setProvider] = useState('none')
  const [mode, setMode] = useState<'auto' | 'browser'>('browser')
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [interim, setInterim] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const recRef = useRef<any>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pcmRef = useRef<PcmStream | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recordingRef = useRef(false)
  const speakerRef = useRef(speaker)
  useEffect(() => { speakerRef.current = speaker }, [speaker])
  const transcriptRef = useRef('')
  useEffect(() => { transcriptRef.current = transcript }, [transcript])

  const SRClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  const browserSupported = !!SRClass
  const autoAvailable = provider !== 'none'

  // Detect whether a server transcription provider is configured; prefer it if so.
  useEffect(() => {
    fetch(`${API_BASE}/api/health`).then((r) => r.json()).then((d) => {
      const p = d.transcription || 'none'
      setProvider(p)
      setMode(p !== 'none' ? 'auto' : 'browser')
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!recording) return
    const id = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [recording])

  // stop & clean up on unmount
  useEffect(() => () => {
    recordingRef.current = false
    try { recRef.current?.stop() } catch {}
    try { pcmRef.current?.stop() } catch {}
    try { wsRef.current?.close() } catch {}
    streamRef.current?.getTracks().forEach((t) => t.stop())
  }, [])

  const appendLine = (text: string) => {
    if (!text.trim()) return
    setTranscript((prev) => (prev ? prev.replace(/\s*$/, '') + '\n' : '') + `${speakerRef.current || 'Speaker'}: ${text.trim()}`)
  }

  // ---- AUTO mode: server STT, any language ----
  const uploadChunk = async (blob: Blob, prompt: string): Promise<string> => {
    const form = new FormData()
    form.append('audio', blob, 'chunk.webm')
    if (prompt) form.append('prompt', prompt) // prior text → consistent names/spelling
    const res = await fetch(`${API_BASE}/api/meetings/transcribe`, { method: 'POST', headers: { authorization: `Bearer ${getToken()}` }, body: form })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Transcription failed')
    return data.text || ''
  }

  const startAuto = async () => {
    setErr('')
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch { setErr('Microphone permission denied. Allow mic access and try again.'); return }
    streamRef.current = stream
    recordingRef.current = true
    setRecording(true)
    ;(async () => {
      while (recordingRef.current) {
        const blob = await recordSegment(stream, 12000)
        if (blob.size > 2000) {
          try { setTranscribing(true); appendLine(await uploadChunk(blob, transcriptRef.current.slice(-450))) }
          catch (e: any) { setErr(e.message) }
          finally { setTranscribing(false) }
        }
      }
      stream.getTracks().forEach((t) => t.stop())
    })()
  }

  // ---- SARVAM STREAMING mode: live captions over a WebSocket ----
  // Browser streams raw PCM16 @16kHz to our server, which proxies to Sarvam and
  // streams transcripts back. Captions appear ~1-2s after each spoken phrase.
  const startSarvamStream = async () => {
    setErr('')
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${wsProto}://${location.host}/api/meetings/live?token=${getToken()}&language=unknown`)
    wsRef.current = ws
    recordingRef.current = true
    setRecording(true)

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.transcript) { appendLine(msg.transcript); setInterim('') }
        else if (msg.error) setErr(msg.error)
      } catch {}
    }
    ws.onerror = () => setErr('Live transcription connection failed.')
    ws.onclose = () => { setTranscribing(false) }

    ws.onopen = async () => {
      setTranscribing(true)
      pcmRef.current = await startPcmStream(
        (b64) => { if (ws.readyState === WebSocket.OPEN) ws.send(b64) },
        (msg) => { setErr(msg); stop() },
      )
    }
  }

  // ---- BROWSER mode: Web Speech API, one language ----
  const startBrowser = () => {
    setErr('')
    if (!browserSupported) { setErr('Browser captions need Google Chrome or Microsoft Edge.'); return }
    const rec = new SRClass()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = lang
    rec.onresult = (e: any) => {
      let fin = '', intr = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) fin += r[0].transcript; else intr += r[0].transcript
      }
      if (fin.trim()) appendLine(fin)
      setInterim(intr)
    }
    rec.onerror = (e: any) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { setErr('Microphone permission denied.'); stop() } }
    rec.onend = () => { if (recordingRef.current) { try { rec.start() } catch {} } }
    recRef.current = rec
    recordingRef.current = true
    setRecording(true)
    try { rec.start() } catch {}
  }

  const start = () => {
    setSeconds(0)
    if (mode === 'auto') { provider === 'sarvam' ? startSarvamStream() : startAuto() }
    else startBrowser()
  }
  const stop = () => {
    recordingRef.current = false
    setRecording(false)
    setInterim('')
    try { recRef.current?.stop() } catch {}
    try { pcmRef.current?.stop(); pcmRef.current = null } catch {}
    try { wsRef.current?.close(); wsRef.current = null } catch {}
  }

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const close = () => { stop(); onClose() }

  const process = async () => {
    stop()
    setBusy(true); setErr('')
    try {
      const r = await api.post('/meetings', { title: title || 'Live Meeting', description, meeting_date: date, transcript, participant_ids: participants })
      onDone(r.id)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="modal-center" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread">
          <h3>● Start meeting — live recording</h3>
          <button className="btn btn-ghost" onClick={close}>✕</button>
        </div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          <div className="grid grid-3" style={{ gap: 10 }}>
            <div style={{ gridColumn: 'span 2' }}><MeetingTitleSelect value={title} onChange={setTitle} /></div>
            <div><label>Speaker label</label><input value={speaker} onChange={(e) => setSpeaker(e.target.value)} /></div>
          </div>
          <div><label>Description <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label><textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this meeting about?" /></div>
          <div><label>Participants <span className="muted" style={{ fontWeight: 400 }}>(only these people can be assigned tasks)</span></label><ParticipantPicker value={participants} onChange={setParticipants} /></div>

          <div>
            <label>Recognition mode</label>
            <div className="row" style={{ gap: 8 }}>
              <button className={'btn btn-sm' + (mode === 'auto' ? ' btn-primary' : '')} disabled={recording || !autoAvailable} onClick={() => setMode('auto')}>✦ Auto — any language</button>
              <button className={'btn btn-sm' + (mode === 'browser' ? ' btn-primary' : '')} disabled={recording} onClick={() => setMode('browser')}>Browser captions (1 language)</button>
            </div>
            {mode === 'auto'
              ? <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Auto-detects Telugu / Hindi / English & code-mixing via <strong>{provider}</strong>. {provider === 'sarvam' ? 'Captions stream live — each phrase appears ~1-2s after it’s spoken.' : 'Live captions arrive in short segments and self-correct using prior context (names/spelling stay consistent).'} You can also edit the transcript before analyzing.</div>
              : <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Pick one language; press Stop and switch to mix languages — all append to one transcript.</div>}
            {!autoAvailable && (
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginTop: 6 }}>
                Auto language is off — no server speech-to-text configured. For a <b>free</b> option, get a Groq key at <b>console.groq.com</b> and add <b>TRANSCRIPTION_PROVIDER=groq</b> + <b>GROQ_API_KEY</b> to <b>server/.env</b>, then restart the backend. (<b>sarvam</b> is best for Telugu/Hindi code-mixing; <b>openai</b> also works.)
              </div>
            )}
          </div>

          <div className="grid grid-3" style={{ gap: 10 }}>
            {mode === 'browser' && (
              <div>
                <label>Speaking language</label>
                <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={recording}>
                  {REC_LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
              </div>
            )}
            <div className="muted" style={{ alignSelf: 'end', fontSize: 12 }}>Summary &amp; tasks: <b>English</b></div>
            <div style={{ alignSelf: 'end' }} className="muted">
              {recording ? <span style={{ color: '#dc2626', fontWeight: 700 }}>● REC {mmss}{transcribing ? ' · transcribing…' : ''}</span> : 'Ready'}
            </div>
          </div>

          <div className="row" style={{ gap: 10 }}>
            {!recording
              ? <button className="btn btn-primary" onClick={start} disabled={mode === 'browser' && !browserSupported}>● Start recording</button>
              : <button className="btn btn-danger" onClick={stop}>■ Stop</button>}
            {recording && transcribing && <span className="spinner" />}
          </div>

          <div>
            <div className="spread"><label>Live transcript (editable — fix any names before analyzing)</label>{transcript && <button className="btn btn-sm btn-ghost" onClick={() => setTranscript('')}>Clear</button>}</div>
            <textarea rows={8} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder={`Recognized speech appears here as "${speaker}: …" lines.`} style={{ fontFamily: 'monospace', fontSize: 12.5 }} />
            {interim && <div className="muted" style={{ fontStyle: 'italic', fontSize: 12, marginTop: 4 }}>… {interim}</div>}
          </div>

          {err && <div style={{ color: '#ef4444', fontSize: 13 }}>{err}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn btn-primary" onClick={process} disabled={busy || recording || !transcript.trim()}>{busy ? <><span className="spinner" /> Analyzing…</> : '✦ Analyze & extract tasks'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
