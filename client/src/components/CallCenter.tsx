import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, getToken, wsUrl, API_BASE } from '../api'
import { useAuth } from '../auth'
import { Avatar, Ic } from '../ui'
import { toast } from '../lib/toast'
import { confirmDialog } from '../lib/confirm'
import { audioFilename } from '../lib/audioFile'
import { subscribeCalls, CallKind } from '../lib/call'
import { startLiveSpeech, isSupported as speechSupported, LiveSpeech } from '../lib/liveSpeech'

// Audio / video / screen-share calling.
//
// The media is peer-to-peer WebRTC in a full mesh: every participant holds one
// RTCPeerConnection per other participant. A mesh is the right shape for the
// team-sized calls this app is for — it needs no media server at all, where an
// SFU would mean another deployed service and a per-stream bandwidth bill. The
// cost is that each person uploads their camera once per peer, so this stays
// good to roughly five or six people and is not trying to be a webinar tool.
//
// Mounted once in App's Layout, NOT inside the Chats page, and it opens its own
// WebSocket: a call has to be answerable while you are on Tasks or Meetings, and
// it has to survive navigating between them. The hub keeps a Set of sockets per
// user, so this second connection sits happily alongside the Chats page's own.
//
// Signalling rule that keeps it simple: THE JOINER ALWAYS OFFERS. Whoever picks
// up sends an offer to everyone already in the call, so for any pair exactly one
// side initiates and there is no glare to resolve.

// Public STUN only. It gets a direct path on ordinary home and office networks;
// symmetric NAT (some corporate firewalls, a few mobile carriers) needs a TURN
// relay, which is a server we would have to run and pay for. When that happens
// the connection reports 'failed' and we say so rather than showing a dead frame.
const ICE: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
}

interface Incoming { callId: string; conversationId: string; kind: CallKind; fromName: string; fromId: string; title: string }
interface Peer { id: string; name: string; stream: MediaStream | null }

export default function CallCenter() {
  const { user } = useAuth()
  const navigate = useNavigate()
  // Only a manager can file the result (POST /meetings/audio is manager-gated),
  // so only a manager is offered the button that produces it.
  const canRecord = user?.role === 'manager' || user?.role === 'admin'
  const [incoming, setIncoming] = useState<Incoming | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const [kind, setKind] = useState<CallKind>('audio')
  const [title, setTitle] = useState('')
  const [phase, setPhase] = useState<'idle' | 'ringing' | 'connecting' | 'live'>('idle')
  const [peers, setPeers] = useState<Record<string, Peer>>({})
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [sharing, setSharing] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [minimized, setMinimized] = useState(false)
  const [maximized, setMaximized] = useState(false)
  // Recording is for turning the call into tasks afterwards. It is opt-in, only
  // a manager can start it (they are the only ones who can file the result), and
  // everyone in the call is told the moment it starts.
  const [recording, setRecording] = useState(false)
  const [recordedBy, setRecordedBy] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const localRef = useRef<MediaStream | null>(null)
  const screenRef = useRef<MediaStream | null>(null)
  const callIdRef = useRef<string | null>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  // Candidates that arrived before the offer they belong to. Adding one to a
  // connection with no remote description throws and silently kills the media
  // path, so they queue here until setRemoteDescription lands.
  const pendingIce = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  // Per-peer negotiation bookkeeping for the perfect-negotiation pattern.
  const negRef = useRef<Map<string, { makingOffer: boolean; ignoreOffer: boolean; polite: boolean }>>(new Map())
  // Peer id -> display name, learned from the ring and from call-joined. Kept in
  // a ref because the socket handler closes over it and must always read the
  // latest, not the value captured when the socket was opened.
  const peersNameRef = useRef<Record<string, string>>({})

  // Recording plumbing. The mixer is a Web Audio graph: every participant's audio
  // (mine + each remote) is piped into one MediaStreamDestination, and THAT is
  // what MediaRecorder captures. Recording the raw local stream alone would
  // capture only my own voice, which is useless for extracting who agreed to what.
  const mixCtxRef = useRef<AudioContext | null>(null)
  const mixDestRef = useRef<MediaStreamAudioDestinationNode | null>(null)
  const mixedRef = useRef<Set<string>>(new Set())
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const recordingRef = useRef(false)
  const convIdRef = useRef<string | null>(null)
  const startedAtRef = useRef<number>(0)
  // My own half of the conversation, recognised on this device and posted up as
  // it is spoken. Everyone in the call runs one of these; the server puts the
  // halves back together in time order.
  const speechRef = useRef<LiveSpeech | null>(null)
  // Mirrors of state that late-running callbacks (hang-up, the socket handler)
  // must read as of NOW, not as of the render that created them.
  const peersRef = useRef<Record<string, Peer>>({})
  const kindRef = useRef<CallKind>('audio')

  useEffect(() => { callIdRef.current = callId }, [callId])
  useEffect(() => { peersRef.current = peers }, [peers])
  useEffect(() => { kindRef.current = kind }, [kind])

  // ---- teardown -----------------------------------------------------------
  const cleanup = useCallback(() => {
    for (const pc of pcsRef.current.values()) { try { pc.close() } catch {} }
    pcsRef.current.clear()
    pendingIce.current.clear()
    negRef.current.clear()
    for (const s of [localRef.current, screenRef.current]) s?.getTracks().forEach((t) => { try { t.stop() } catch {} })
    localRef.current = null
    screenRef.current = null
    try { mixCtxRef.current?.close() } catch {}
    mixCtxRef.current = null
    mixDestRef.current = null
    mixedRef.current.clear()
    recorderRef.current = null
    recordingRef.current = false
    convIdRef.current = null
    try { speechRef.current?.stop() } catch {}
    speechRef.current = null
    setRecording(false); setRecordedBy(null)
    setPeers({}); setPhase('idle'); setCallId(null); setSharing(false)
    setMicOn(true); setCamOn(true); setElapsed(0); setMinimized(false); setMaximized(false)
  }, [])

  // Deliberately NOT useCallback: it reaches stopRecording/callToTasks, which are
  // rebuilt on every render, and a memoised hangUp would hold the very first pair
  // forever — uploading with a stale `kind` and a stale peer list. It is only ever
  // called from an onClick, so there is nothing to memoise for.
  const hangUp = async (silent = false) => {
    const id = callIdRef.current
    // Take the tape BEFORE cleanup() tears the recorder down, and capture the
    // names while the peer list still exists.
    const names = Object.values(peersRef.current).map((p) => p.name)
    const wasRecording = recordingRef.current
    const blob = wasRecording ? await stopRecording() : null
    cleanup()
    if (id && !silent) { try { await api.post(`/chat/call/${id}/end`) } catch {} }
    if (wasRecording) await callToTasks(blob, names, id)
  }

  // Release the mic and camera if the tab goes away mid-call — otherwise the
  // device stays held and the OS keeps showing the "in use" indicator.
  useEffect(() => {
    const bye = () => { for (const s of [localRef.current, screenRef.current]) s?.getTracks().forEach((t) => t.stop()) }
    window.addEventListener('pagehide', bye)
    return () => { window.removeEventListener('pagehide', bye); bye() }
  }, [])

  // ---- recording: mix every voice into one track --------------------------
  // Lazily built, and every participant is added to it as they arrive — including
  // people who join AFTER recording started, which is why addToMix is called from
  // ontrack rather than once at the top.
  const ensureMixer = () => {
    if (!mixCtxRef.current) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext
      const ctx = new Ctx()
      mixCtxRef.current = ctx
      mixDestRef.current = ctx.createMediaStreamDestination()
    }
    // WKWebView hands back a suspended context unless it was built inside the
    // tap; resume() explicitly or the recording is pure silence (see CLAUDE.md).
    if (mixCtxRef.current.state === 'suspended') mixCtxRef.current.resume().catch(() => {})
    return mixCtxRef.current
  }

  const addToMix = (key: string, stream: MediaStream | null) => {
    if (!stream || mixedRef.current.has(key)) return
    if (!stream.getAudioTracks().length) return
    try {
      const ctx = ensureMixer()
      ctx.createMediaStreamSource(stream).connect(mixDestRef.current!)
      mixedRef.current.add(key)
    } catch (e: any) { console.warn('[call] could not mix', key, e?.message) }
  }

  // Called on EVERY participant once recording starts — not just the recorder.
  const startMySpeech = () => {
    if (speechRef.current || !speechSupported()) return
    const callId = callIdRef.current
    speechRef.current = startLiveSpeech((text) => {
      const id = callIdRef.current
      if (!id || id !== callId) return
      api.post(`/chat/call/${id}/segment`, { text }).catch(() => {})
    })
  }
  const stopMySpeech = () => { speechRef.current?.stop(); speechRef.current = null }

  const startRecording = async () => {
    if (recordingRef.current) return
    const others = Object.keys(pcsRef.current).length || Object.keys(peers).length
    const ok = await confirmDialog({
      title: 'Record this call?',
      message: others
        ? 'Everyone on the call will see that it is being recorded. When you hang up, the recording is transcribed and turned into a list of tasks for you to assign.'
        : 'Nobody has joined yet — there will be nothing to transcribe until they do.',
      confirmText: 'Start recording',
    })
    if (!ok) return
    try {
      ensureMixer()
      addToMix('self', localRef.current)
      for (const [pid, p] of Object.entries(peers)) addToMix(pid, p.stream)
      const dest = mixDestRef.current!
      const rec = new MediaRecorder(dest.stream)
      chunksRef.current = []
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data) }
      rec.start(1000) // timeslice: survive a crash with something on disk
      recorderRef.current = rec
      recordingRef.current = true
      startedAtRef.current = Date.now()
      setRecording(true)
      setRecordedBy(user?.name || 'Someone')
      startMySpeech()
      const id = callIdRef.current
      if (id) api.post(`/chat/call/${id}/recording`, { on: true }).catch(() => {})
    } catch (e: any) {
      toast.error('Could not start recording: ' + e.message)
    }
  }

  // Stops the recorder and resolves with the audio. Separated from the upload so
  // hang-up can stop-and-upload in one go without racing the recorder's flush.
  const stopRecording = (): Promise<Blob | null> => new Promise((resolve) => {
    const rec = recorderRef.current
    if (!rec || rec.state === 'inactive') { resolve(null); return }
    rec.onstop = () => {
      const blob = chunksRef.current.length ? new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' }) : null
      chunksRef.current = []
      resolve(blob)
    }
    try { rec.stop() } catch { resolve(null) }
    recordingRef.current = false
    recorderRef.current = null
    setRecording(false)
    stopMySpeech()
    const id = callIdRef.current
    if (id) api.post(`/chat/call/${id}/recording`, { on: false }).catch(() => {})
  })

  // Hand the recording to the meetings pipeline — the SAME one that already turns
  // multilingual meeting speech into assignable tasks. Nothing new is invented
  // here: transcription, extraction, the review screen and the assignment flow
  // are all the existing path, which is exactly why this is worth doing.
  const callToTasks = async (blob: Blob | null, peerNames: string[], callId: string | null) => {
    setProcessing(true)
    const who = peerNames.length ? peerNames.join(', ') : 'the team'

    // First choice: the transcript the browsers built as people spoke. It needs
    // no key, no upload and no waiting, and every line already knows who said
    // it. The recorded audio is only the fallback for when nobody's browser
    // could do speech (Safari, iOS) but the server has a provider key.
    if (callId) {
      try {
        const live: any = await api.post(`/chat/call/${callId}/to-tasks`)
        toast.success(`${live.suggestion_count || 0} task${live.suggestion_count === 1 ? '' : 's'} found — review and assign`)
        navigate(`/meetings/${live.id}`)
        setProcessing(false)
        return
      } catch (e: any) {
        // NO_SPEECH just means nothing was recognised — fall through to audio.
        if (!/NO_SPEECH|Nothing was captured/i.test(e.message || '')) console.warn('[call] live transcript failed:', e.message)
      }
    }

    if (!blob || blob.size < 2000) {
      setProcessing(false)
      toast.info('Nothing was captured from that call to turn into tasks.')
      return
    }
    try {
      const form = new FormData()
      form.append('audio', blob, audioFilename(blob, 'call'))
      form.append('title', `Call with ${who}`)
      form.append('description', `Recorded from ${kindRef.current === 'audio' ? 'an' : 'a'} ${kindRef.current} call in VoTask.`)
      form.append('source_type', 'call')
      form.append('participant_ids', JSON.stringify(Object.keys(pcsRef.current)))
      const headers: Record<string, string> = {}
      const t = getToken(); if (t) headers.authorization = `Bearer ${t}`
      const res = await fetch(`${API_BASE}/api/meetings/audio`, { method: 'POST', headers, body: form })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Could not process the recording')
      toast.success(`${data.suggestion_count || 0} task${data.suggestion_count === 1 ? '' : 's'} found — review and assign`)
      navigate(`/meetings/${data.id}`)
    } catch (e: any) {
      // The recording is the only copy of what was said and it lives in a Blob
      // in this tab, so it cannot simply be dropped. It is NOT forced onto the
      // user's disk either: it goes into the conversation as an ordinary audio
      // message, where it plays inline for everyone who was on the call. Saving
      // it is then a choice, from that message's own ⋯ menu.
      const needsKey = /provider|NO_PROVIDER|speech/i.test(e.message || '')
      const kept = await keepRecordingInChat(blob, convIdRef.current)
      const why = needsKey
        ? 'The call could not be transcribed — no speech was captured and the server has no speech provider.'
        : 'Could not turn the call into tasks: ' + e.message
      toast.error(kept ? `${why} The recording is in the chat so you can play it back.` : why)
    } finally { setProcessing(false) }
  }

  // Put the recording into the conversation as a normal audio message. Same
  // upload path as a voice note, so it gets the same inline player, the same
  // storage and the same optional download — nothing bespoke to maintain.
  const keepRecordingInChat = async (blob: Blob, conversationId: string | null): Promise<boolean> => {
    if (!conversationId || !blob || blob.size < 2000) return false
    try {
      const name = audioFilename(blob, `call-recording-${new Date().toISOString().slice(11, 16).replace(':', '')}`)
      const form = new FormData()
      form.append('file', new File([blob], name, { type: blob.type || 'audio/webm' }))
      const headers: Record<string, string> = {}
      const t = getToken(); if (t) headers.authorization = `Bearer ${t}`
      const res = await fetch(`${API_BASE}/api/chat/conversations/${conversationId}/upload`, { method: 'POST', headers, body: form })
      return res.ok
    } catch { return false }
  }

  // ---- signalling ---------------------------------------------------------
  const signal = useCallback((to: string, payload: any) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'call-signal', callId: callIdRef.current, to, signal: payload })) } catch {}
    }
  }, [])

  const getPc = useCallback((peerId: string, peerName: string) => {
    const existing = pcsRef.current.get(peerId)
    if (existing) return existing
    const pc = new RTCPeerConnection(ICE)
    pcsRef.current.set(peerId, pc)
    setPeers((p) => ({ ...p, [peerId]: p[peerId] || { id: peerId, name: peerName, stream: null } }))

    for (const track of localRef.current?.getTracks() || []) pc.addTrack(track, localRef.current!)
    // Renegotiation is driven by onnegotiationneeded below, so adding a camera
    // later is just addTrack. An earlier version pre-armed an empty video
    // transceiver to avoid renegotiating at all; it mis-associated the m-lines on
    // the answering side and the upgraded video silently never flowed.
    const neg = { makingOffer: false, ignoreOffer: false, polite: (user?.id || '') < peerId }
    negRef.current.set(peerId, neg)

    // Perfect negotiation (the WebRTC spec's own recipe). Either side may need to
    // renegotiate at any moment — turning a camera on, sharing a screen — and if
    // both do it at once the offers collide. One peer is designated "polite" by a
    // rule both sides compute identically (compare user ids): the polite one rolls
    // back and accepts, the impolite one ignores. Without this, a mid-call upgrade
    // is a coin flip.
    pc.onnegotiationneeded = async () => {
      try {
        neg.makingOffer = true
        await pc.setLocalDescription()
        signal(peerId, { sdp: pc.localDescription })
      } catch (e: any) {
        console.warn('[call] negotiation failed', e?.message)
      } finally {
        neg.makingOffer = false
      }
    }

    pc.onicecandidate = (e) => { if (e.candidate) signal(peerId, { candidate: e.candidate.toJSON() }) }
    pc.ontrack = (e) => {
      const stream = e.streams[0]
      setPeers((p) => ({ ...p, [peerId]: { ...(p[peerId] || { id: peerId, name: peerName }), stream } }))
      setPhase('live')
      // Fold them into the recording mix too — someone who joins mid-recording
      // must still end up on the tape.
      if (recordingRef.current || mixCtxRef.current) addToMix(peerId, stream)
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        toast.error(`Could not reach ${peerName} directly — the network is blocking peer-to-peer media.`)
      }
    }
    return pc
  }, [signal, user?.id])

  // Connect to everyone already in the call. Creating the peer connection adds
  // our tracks, which fires onnegotiationneeded, which sends the offer — so there
  // is no separate "make an offer" step to keep in sync any more.
  const offerTo = useCallback(async (peerIds: string[], names: Record<string, string>) => {
    for (const pid of peerIds) getPc(pid, names[pid] || 'Teammate')
  }, [getPc])

  const drainIce = useCallback(async (pc: RTCPeerConnection, from: string) => {
    const queued = pendingIce.current.get(from) || []
    pendingIce.current.delete(from)
    for (const c of queued) { try { await pc.addIceCandidate(c) } catch {} }
  }, [])

  // ---- media --------------------------------------------------------------
  const grabMedia = useCallback(async (k: CallKind) => {
    // iOS/WKWebView hands back a suspended context and refuses the camera unless
    // this runs inside the user's tap — which it does: every path here starts at
    // a button press (see CLAUDE.md on the WebView differences).
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: k === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    })
    localRef.current = stream
    if (localVideoRef.current) localVideoRef.current.srcObject = stream
    return stream
  }, [])

  // ---- start / answer -----------------------------------------------------
  const begin = useCallback(async (conversationId: string, k: CallKind, label: string) => {
    if (callIdRef.current) { toast.error('You are already on a call'); return }
    setKind(k); setTitle(label); setPhase('ringing')
    try {
      await grabMedia(k)
    } catch {
      setPhase('idle')
      toast.error(k === 'video' ? 'No camera or microphone available' : 'No microphone available')
      return
    }
    try {
      const call: any = await api.post(`/chat/conversations/${conversationId}/call`, { kind: k })
      setCallId(call.id); callIdRef.current = call.id
      convIdRef.current = conversationId
      // Joining a call already in progress: offer to everyone in it right away.
      if (call.joined && call.peers?.length) { setPhase('connecting'); await offerTo(call.peers, peersNameRef.current) }
    } catch (e: any) {
      cleanup()
      toast.error('Could not start the call: ' + e.message)
    }
  }, [grabMedia, offerTo, cleanup])

  const answer = useCallback(async () => {
    const inc = incoming
    if (!inc) return
    setIncoming(null)
    peersNameRef.current[inc.fromId] = inc.fromName
    setKind(inc.kind); setTitle(inc.title); setPhase('connecting')
    setCallId(inc.callId); callIdRef.current = inc.callId
    convIdRef.current = inc.conversationId
    try {
      await grabMedia(inc.kind)
    } catch {
      cleanup()
      toast.error('No microphone available')
      try { await api.post(`/chat/call/${inc.callId}/decline`) } catch {}
      return
    }
    try {
      const res: any = await api.post(`/chat/call/${inc.callId}/answer`)
      await offerTo(res.peers || [], peersNameRef.current)
    } catch (e: any) {
      cleanup()
      toast.error('Could not join: ' + e.message)
    }
  }, [incoming, grabMedia, offerTo, cleanup])

  const decline = useCallback(async () => {
    const inc = incoming
    setIncoming(null)
    if (inc) { try { await api.post(`/chat/call/${inc.callId}/decline`) } catch {} }
  }, [incoming])

  // ---- the socket ---------------------------------------------------------
  useEffect(() => {
    if (!user) return
    let closed = false
    let retry: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (closed) return
      const token = getToken()
      if (!token) return
      const ws = new WebSocket(wsUrl(`/api/chat/ws?token=${encodeURIComponent(token)}`))
      wsRef.current = ws
      ws.onmessage = async (ev) => {
        let msg: any
        try { msg = JSON.parse(ev.data) } catch { return }

        if (msg.type === 'call-ring') {
          // Already busy: turn it down rather than letting a second call ring
          // over a live one.
          if (callIdRef.current) { try { await api.post(`/chat/call/${msg.callId}/decline`) } catch {}; return }
          setIncoming({
            callId: msg.callId, conversationId: msg.conversationId, kind: msg.kind,
            fromName: msg.from?.name || 'Teammate', fromId: msg.from?.id,
            title: msg.conversationType === 'group' ? msg.conversationName : (msg.from?.name || 'Call'),
          })
          return
        }

        if (msg.type === 'call-signal' && msg.callId === callIdRef.current) {
          const from = msg.from
          const sig = msg.signal || {}
          if (sig.sdp) {
            const pc = getPc(from, peersNameRef.current[from] || 'Teammate')
            const neg = negRef.current.get(from)
            try {
              // Collision: their offer arrived while we were making our own, or
              // while we are not back to a stable state. The impolite peer drops
              // theirs; the polite peer yields, and setRemoteDescription performs
              // the implicit rollback for us.
              const collision = sig.sdp.type === 'offer' && (!!neg?.makingOffer || pc.signalingState !== 'stable')
              if (neg) neg.ignoreOffer = !neg.polite && collision
              if (neg?.ignoreOffer) return

              await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp))
              await drainIce(pc, from)
              if (sig.sdp.type === 'offer') {
                await pc.setLocalDescription()
                signal(from, { sdp: pc.localDescription })
              }
              setPhase((p) => (p === 'ringing' ? 'connecting' : p))
            } catch (e: any) { console.warn('[call] sdp failed', e?.message) }
          } else if (sig.candidate) {
            const pc = pcsRef.current.get(from)
            const neg = negRef.current.get(from)
            if (pc && pc.remoteDescription) {
              try { await pc.addIceCandidate(sig.candidate) } catch (e) { if (!neg?.ignoreOffer) console.warn('[call] ice rejected') }
            } else {
              const q = pendingIce.current.get(from) || []
              q.push(sig.candidate)
              pendingIce.current.set(from, q)
            }
          }
          return
        }

        if (msg.type === 'call-joined' && msg.callId === callIdRef.current) {
          // Someone picked up. They will offer to us, so there is nothing to do
          // but remember their name for the tile.
          if (msg.name) peersNameRef.current[msg.userId] = msg.name
          setPhase((p) => (p === 'ringing' ? 'connecting' : p))
          return
        }
        if (msg.type === 'call-left' && msg.callId === callIdRef.current) {
          const pc = pcsRef.current.get(msg.userId)
          if (pc) { try { pc.close() } catch {}; pcsRef.current.delete(msg.userId) }
          setPeers((p) => { const n = { ...p }; delete n[msg.userId]; return n })
          return
        }
        if (msg.type === 'call-declined' && msg.callId === callIdRef.current) {
          toast.info(`${msg.name || 'They'} declined`)
          return
        }
        if (msg.type === 'call-kind' && msg.callId === callIdRef.current) {
          // They turned a camera on. Switch to the video layout so their tile can
          // render; our own camera stays off until we choose to turn it on.
          if (msg.kind === 'video') { setKind('video'); kindRef.current = 'video' }
          if (msg.by !== user.id && msg.kind === 'video') toast.info(`${msg.byName || 'They'} turned their camera on`)
          return
        }
        if (msg.type === 'call-recording' && msg.callId === callIdRef.current) {
          // Everyone sees the badge, including the person who started it.
          setRecordedBy(msg.on ? (msg.byName || 'Someone') : null)
          if (msg.by !== user.id) {
            if (msg.on) {
              toast.info(`${msg.byName || 'Someone'} started recording this call`)
              // Transcribe MY side too, so the transcript has both halves. This
              // is the only way the far end can ever be captured: the Web Speech
              // API hears this device's microphone and nothing else.
              startMySpeech()
            } else stopMySpeech()
          }
          return
        }
        if (msg.type === 'call-ended' && msg.callId === callIdRef.current) { cleanup(); return }
        if (msg.type === 'call-ended' || msg.type === 'call-ring') return
        // Not ours (chat messages etc.) — the Chats page has its own socket.
      }
      ws.onclose = () => { if (!closed) retry = setTimeout(connect, 2500) }
      ws.onerror = () => { try { ws.close() } catch {} }
    }
    connect()
    return () => { closed = true; if (retry) clearTimeout(retry); try { wsRef.current?.close() } catch {} }
  }, [user, getPc, drainIce, signal, cleanup])

  // The bus: Chats (or anything else) asking us to ring someone.
  useEffect(() => subscribeCalls((req) => { begin(req.conversationId, req.kind, req.title) }), [begin])

  // Call timer, once media is actually flowing.
  useEffect(() => {
    if (phase !== 'live') return
    const iv = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(iv)
  }, [phase])

  // A ring you can hear. WebAudio rather than an asset so there is no file to
  // ship and nothing to 404; two short beeps a second apart, looped.
  useEffect(() => {
    if (!incoming) return
    let ctx: AudioContext | null = null
    let stop = false
    try {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      const beep = () => {
        if (stop || !ctx) return
        const o = ctx.createOscillator(); const g = ctx.createGain()
        o.frequency.value = 660; o.type = 'sine'
        g.gain.setValueAtTime(0.0001, ctx.currentTime)
        g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.05)
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5)
        o.connect(g); g.connect(ctx.destination)
        o.start(); o.stop(ctx.currentTime + 0.55)
      }
      beep()
      const iv = setInterval(beep, 1400)
      return () => { stop = true; clearInterval(iv); try { ctx?.close() } catch {} }
    } catch { /* autoplay blocked — the visual ringer still shows */ }
    return () => { stop = true; try { ctx?.close() } catch {} }
  }, [incoming])

  // ---- in-call controls ---------------------------------------------------
  // Turn the camera on during an audio call — WhatsApp's "switch to video".
  // Only ever an upgrade: there is no downgrade, because dropping back to audio is
  // what the camera-off button already does.
  const upgradeToVideo = async () => {
    if (kindRef.current === 'video' || !localRef.current) return
    let track: MediaStreamTrack
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })
      track = cam.getVideoTracks()[0]
    } catch { toast.error('No camera available'); return }

    localRef.current.addTrack(track)
    if (localVideoRef.current) localVideoRef.current.srcObject = localRef.current
    // Reuse an idle video sender if there is one (there will be after a screen
    // share has been stopped), otherwise add the track and let
    // onnegotiationneeded renegotiate.
    for (const pc of pcsRef.current.values()) {
      try {
        const idle = pc.getSenders().find((sn) => !sn.track && pc.getTransceivers().some((t) => t.sender === sn && t.receiver.track?.kind === 'video'))
        if (idle) await idle.replaceTrack(track)
        else pc.addTrack(track, localRef.current!)
      } catch (e: any) { console.warn('[call] camera upgrade failed', e?.message) }
    }
    setKind('video'); kindRef.current = 'video'
    setCamOn(true)
    const id = callIdRef.current
    if (id) api.post(`/chat/call/${id}/kind`, { kind: 'video' }).catch(() => {})
  }

  const toggleMic = () => {
    const t = localRef.current?.getAudioTracks()[0]
    if (!t) return
    t.enabled = !t.enabled
    setMicOn(t.enabled)
  }
  const toggleCam = () => {
    const t = localRef.current?.getVideoTracks()[0]
    if (!t) return
    t.enabled = !t.enabled
    setCamOn(t.enabled)
  }

  // Screen share swaps the outgoing video track on every peer connection rather
  // than renegotiating — replaceTrack needs no new offer, so the switch is
  // instant and cannot fail halfway across a mesh.
  const toggleShare = async () => {
    if (sharing) {
      const camTrack = localRef.current?.getVideoTracks()[0] || null
      for (const pc of pcsRef.current.values()) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
        if (sender) { try { await sender.replaceTrack(camTrack) } catch {} }
      }
      screenRef.current?.getTracks().forEach((t) => t.stop())
      screenRef.current = null
      if (localVideoRef.current) localVideoRef.current.srcObject = localRef.current
      setSharing(false)
      return
    }
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      screenRef.current = screen
      const track = screen.getVideoTracks()[0]
      for (const pc of pcsRef.current.values()) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
        if (sender) { try { await sender.replaceTrack(track) } catch {} }
        else { try { pc.addTrack(track, screen) } catch {} }
      }
      if (localVideoRef.current) localVideoRef.current.srcObject = screen
      setSharing(true)
      // The browser's own "Stop sharing" bar bypasses our button entirely.
      track.onended = () => { toggleShare() }
    } catch { /* the picker was dismissed */ }
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  const remote = Object.values(peers)

  if (!user) return null

  return (
    <>
      {incoming && (
        <div className="call-ringer">
          <div className="call-ring-card">
            <Avatar name={incoming.fromName} size={64} />
            <div className="call-ring-who">{incoming.title}</div>
            <div className="call-ring-sub">
              Incoming {incoming.kind} call{incoming.title !== incoming.fromName ? ` from ${incoming.fromName}` : ''}
            </div>
            <div className="call-ring-actions">
              <button className="call-btn decline" onClick={decline} aria-label="Decline"><Ic name="callEnd" size={22} /></button>
              <button className="call-btn accept" onClick={answer} aria-label="Answer">
                <Ic name={incoming.kind === 'video' ? 'video' : 'phone'} size={22} />
              </button>
            </div>
          </div>
        </div>
      )}

      {processing && (
        <div className="call-processing">
          <span className="spinner" />
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Turning the call into tasks…</div>
            <div className="muted" style={{ fontSize: 12 }}>Transcribing and pulling out who agreed to what.</div>
          </div>
        </div>
      )}

      {phase !== 'idle' && (
        <div className={'call-stage' + (minimized ? ' mini' : '') + (maximized ? ' max' : '')}>
          <div className="call-stage-head">
            <div style={{ minWidth: 0 }}>
              <div className="call-stage-title">{title}</div>
              <div className="call-stage-sub">
                {phase === 'ringing' ? 'Ringing…' : phase === 'connecting' ? 'Connecting…' : fmt(elapsed)}
                {sharing && ' · sharing screen'}
                {recordedBy && <span className="rec-badge"><span className="rec-dot" />REC</span>}
              </div>
            </div>
            <div className="row" style={{ gap: 2 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => { setMaximized((m) => !m); setMinimized(false) }}
                title={maximized ? 'Exit full screen' : 'Full screen'} aria-label={maximized ? 'Exit full screen' : 'Full screen'}>
                <Ic name={maximized ? 'minimize' : 'maximize'} size={15} />
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setMinimized((m) => !m); setMaximized(false) }}
                title={minimized ? 'Expand' : 'Minimise'} aria-label={minimized ? 'Expand call' : 'Minimise call'}>
                <Ic name={minimized ? 'arrowUp' : 'arrowDown'} size={16} />
              </button>
            </div>
          </div>

          {!minimized && (
            <div className={'call-grid' + (kind === 'audio' ? ' audio' : '')}>
              {kind === 'video' && (
                <div className={'call-tile self' + (sharing ? ' sharing' : '')}>
                  <video ref={localVideoRef} autoPlay muted playsInline />
                  <span className="call-tile-name">You{!micOn ? ' · muted' : ''}</span>
                </div>
              )}
              {remote.map((p) => (
                <div key={p.id} className="call-tile">
                  {kind === 'video'
                    ? <VideoTile stream={p.stream} />
                    : <div className="call-audio-face"><Avatar name={p.name} size={56} /><AudioSink stream={p.stream} /></div>}
                  <span className="call-tile-name">{p.name}</span>
                </div>
              ))}
              {remote.length === 0 && (
                <div className="call-waiting">
                  <Avatar name={title} size={72} />
                  <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                    {phase === 'ringing' ? 'Waiting for them to pick up…' : 'Connecting…'}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="call-controls">
            <button className={'call-btn' + (micOn ? '' : ' off')} onClick={toggleMic} title={micOn ? 'Mute' : 'Unmute'} aria-label={micOn ? 'Mute' : 'Unmute'}>
              <Ic name={micOn ? 'mic' : 'micOff'} size={19} />
            </button>
            {kind === 'video' ? (
              <button className={'call-btn' + (camOn ? '' : ' off')} onClick={toggleCam} title={camOn ? 'Turn camera off' : 'Turn camera on'} aria-label="Toggle camera">
                <Ic name={camOn ? 'video' : 'videoOff'} size={19} />
              </button>
            ) : (
              <button className="call-btn" onClick={upgradeToVideo} title="Turn on your camera" aria-label="Turn on your camera">
                <Ic name="video" size={19} />
              </button>
            )}
            <button className={'call-btn' + (sharing ? ' active' : '')} onClick={toggleShare} title={sharing ? 'Stop sharing' : 'Share screen'} aria-label="Share screen">
              <Ic name="screen" size={19} />
            </button>
            {canRecord && (
              <button
                className={'call-btn' + (recording ? ' recording' : '')}
                onClick={() => (recording ? hangUp() : startRecording())}
                disabled={processing}
                title={recording ? 'Stop recording and turn the call into tasks' : 'Record this call and turn it into tasks'}
                aria-label={recording ? 'Stop recording and create tasks' : 'Record this call and create tasks'}
              >
                <Ic name={recording ? 'taskAdd' : 'record'} size={19} />
              </button>
            )}
            <button className="call-btn decline" onClick={() => hangUp()} title="Leave the call" aria-label="Leave the call">
              <Ic name="callEnd" size={20} />
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// A <video> whose srcObject has to be set imperatively — React can't express it
// as a prop, and re-setting the same stream restarts playback, so it's guarded.
function VideoTile({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && stream && el.srcObject !== stream) el.srcObject = stream
  }, [stream])
  return <video ref={ref} autoPlay playsInline />
}

// Audio-only calls still need an element for the remote track to play through.
function AudioSink({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && stream && el.srcObject !== stream) el.srcObject = stream
  }, [stream])
  return <audio ref={ref} autoPlay />
}
