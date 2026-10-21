import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, getToken, wsUrl, API_BASE } from '../api'
import { useAuth } from '../auth'
import { Avatar, Ic } from '../ui'
import { toast } from '../lib/toast'
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
  // Every call is transcribed, so that when it ends the server can turn it
  // into a summary in the chat and hand out the tasks agreed on it — no
  // button to remember to press. Everyone on the call sees that it is on, and
  // ANYONE can switch it off (or back on); the switch is the call's, not one
  // person's, and everyone is told who flipped it.
  const [transcribing, setTranscribing] = useState(false)
  // Surfaced live, because the alternative is what happened: speech capture
  // dies quietly and you only learn at the end of the call that there is
  // nothing to make tasks from.
  const [heardCount, setHeardCount] = useState(0)
  const [speechDead, setSpeechDead] = useState<string | null>(null)

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

  // Transcription plumbing. The call's switch (on unless someone turned it
  // off), whether the media is flowing yet, and my own half of the
  // conversation, recognised on this device and posted up as it is spoken.
  // Everyone in the call runs one of these; the server puts the halves back
  // together in time order.
  const transcribeRef = useRef(true)
  const liveRef = useRef(false)
  const micOnRef = useRef(true)
  const convIdRef = useRef<string | null>(null)
  const speechRef = useRef<LiveSpeech | null>(null)
  // A browser that cannot recognise speech (Firefox, an iPhone app's web view)
  // records its own microphone instead, in short pieces sent to the server to
  // transcribe — each piece a whole file, which is what a speech service needs.
  const pieceRecRef = useRef<MediaRecorder | null>(null)
  const pieceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pieceUploadsRef = useRef<Promise<unknown>[]>([])
  // The consent line is said once per call, not on every reconnect.
  const toldRef = useRef<string | null>(null)
  // Identifies THIS tab, not this user. A person can be on the call from a
  // second device, or from a reloaded page, and their peers need to tell the
  // new connection from the dead one they are still holding.
  const sessionIdRef = useRef(Math.random().toString(36).slice(2) + Date.now().toString(36))
  const peerSessionRef = useRef<Map<string, string>>(new Map())
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
    peerSessionRef.current.clear()
    for (const s of [localRef.current, screenRef.current]) s?.getTracks().forEach((t) => { try { t.stop() } catch {} })
    localRef.current = null
    screenRef.current = null
    convIdRef.current = null
    liveRef.current = false
    transcribeRef.current = true
    micOnRef.current = true
    try { speechRef.current?.stop() } catch {}
    speechRef.current = null
    if (pieceTimerRef.current) { clearTimeout(pieceTimerRef.current); pieceTimerRef.current = null }
    try { if (pieceRecRef.current?.state !== 'inactive') pieceRecRef.current?.stop() } catch {}
    pieceRecRef.current = null
    setTranscribing(false); setHeardCount(0); setSpeechDead(null)
    setPeers({}); setPhase('idle'); setCallId(null); setSharing(false)
    setMicOn(true); setCamOn(true); setElapsed(0); setMinimized(false); setMaximized(false)
  }, [])

  // Leave. Nothing to file from here any more: the server turns the call into
  // its summary and tasks once the last person is off it. The camera and
  // microphone stop at once; what this side still owes the transcript — on a
  // browser that records instead of listening, the last piece of audio — goes
  // up after that, and only then is the server told this person has left, so
  // the piece is in before the call is written up.
  const hangUp = async (silent = false) => {
    const id = callIdRef.current
    await stopMyTranscript()
    const owed = pieceUploadsRef.current
    pieceUploadsRef.current = []
    cleanup()
    if (owed.length) await Promise.race([Promise.allSettled(owed), new Promise((r) => setTimeout(r, 20000))])
    if (id && !silent) { try { await api.post(`/chat/call/${id}/end`) } catch {} }
    // Leaving was deliberate, so do not walk back in — but a call started
    // after this one should still be rejoinable.
    rejoinedRef.current = false
  }

  // Release the mic and camera if the tab goes away mid-call — otherwise the
  // device stays held and the OS keeps showing the "in use" indicator.
  useEffect(() => {
    const stopAll = () => { for (const s of [localRef.current, screenRef.current]) s?.getTracks().forEach((t) => t.stop()) }
    // `pagehide` fires when a phone merely BACKGROUNDS the tab, not only when it
    // is destroyed. Tearing the media down there is what dropped calls the
    // moment you switched apps. Only release the devices when the page is
    // actually being discarded (persisted === false means no bfcache).
    const bye = (e: PageTransitionEvent) => { if (!e.persisted) stopAll() }
    window.addEventListener('pagehide', bye)
    return () => { window.removeEventListener('pagehide', bye); stopAll() }
  }, [])

  // ---- transcription: my half of the call ---------------------------------
  // Runs on EVERY participant while the call's switch is on, from the moment
  // the media is flowing. Speech recognised here goes up line by line; a
  // browser that cannot recognise speech records instead (see the piece
  // recorder below).
  const startMyTranscript = () => {
    if (!transcribeRef.current || !liveRef.current || !callIdRef.current || !micOnRef.current) return
    if (speechRef.current || pieceRecRef.current) return
    if (!speechSupported()) { startPieces(); return }
    const callId = callIdRef.current
    setSpeechDead(null)
    speechRef.current = startLiveSpeech(
      (text) => {
        const id = callIdRef.current
        if (!id || id !== callId || !transcribeRef.current) return
        setHeardCount((n) => n + 1)
        api.post(`/chat/call/${id}/segment`, { text }).catch(() => {})
      },
      undefined,
      (st) => {
        // Only a genuinely fatal state is worth interrupting a call for — and
        // then this side falls back to recording, so its half is not lost.
        if (st.kind === 'dead') {
          try { speechRef.current?.stop() } catch {}
          speechRef.current = null
          setSpeechDead(st.reason)
          startPieces()
        }
      },
    )
    if (!speechRef.current) { setSpeechDead('speech recognition would not start'); startPieces() }
  }

  // The recording fallback: my microphone only (everyone else is transcribing
  // their own), in pieces of about 25 seconds — each one a complete file the
  // server can transcribe on its own, and short enough for a speech service
  // that refuses anything over 30 seconds. A piece goes up as soon as it ends,
  // so a long call is not one huge upload at the end.
  const startPieces = () => {
    const stream = localRef.current
    const id = callIdRef.current
    if (!stream || !id || pieceRecRef.current || typeof MediaRecorder === 'undefined') return
    const track = stream.getAudioTracks()[0]
    if (!track) return
    const mine = new MediaStream([track])
    const next = () => {
      if (!transcribeRef.current || callIdRef.current !== id) { pieceRecRef.current = null; return }
      let rec: MediaRecorder
      try { rec = new MediaRecorder(mine) } catch { pieceRecRef.current = null; return }
      const chunks: BlobPart[] = []
      const startedAt = new Date().toISOString()
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        if (blob.size > 3000) pieceUploadsRef.current.push(uploadPiece(id, blob, startedAt))
        if (pieceRecRef.current === rec) next()
      }
      pieceRecRef.current = rec
      rec.start()
      pieceTimerRef.current = setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop() } catch {} }, 25000)
    }
    next()
  }
  const uploadPiece = async (id: string, blob: Blob, startedAt: string) => {
    try {
      const form = new FormData()
      form.append('file', new File([blob], audioFilename(blob, 'call-piece'), { type: blob.type || 'audio/webm' }))
      form.append('started_at', startedAt)
      const headers: Record<string, string> = {}
      const t = getToken(); if (t) headers.authorization = `Bearer ${t}`
      const res = await fetch(`${API_BASE}/api/chat/call/${id}/audio`, { method: 'POST', headers, body: form })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.captured) setHeardCount((n) => n + 1)
      if (!res.ok && data.code === 'NO_PROVIDER') {
        // Nowhere to send it: stop recording rather than keep uploading audio
        // nothing can read. The others' halves still make the summary.
        setSpeechDead('this browser cannot transcribe, and the server has no speech service')
        stopPieces()
      }
    } catch { /* one lost piece; the next one carries on */ }
  }
  // Resolves once the last piece has been handed to its upload: the recorder's
  // own onstop (set first, so it runs first) queues the upload, then this.
  const stopPieces = (): Promise<void> => {
    if (pieceTimerRef.current) { clearTimeout(pieceTimerRef.current); pieceTimerRef.current = null }
    const rec = pieceRecRef.current
    pieceRecRef.current = null   // so its onstop does not start another piece
    if (!rec || rec.state === 'inactive') return Promise.resolve()
    const stopped = new Promise<void>((resolve) => rec.addEventListener('stop', () => setTimeout(resolve, 0), { once: true }))
    try { rec.stop() } catch { return Promise.resolve() }
    return Promise.race([stopped, new Promise<void>((r) => setTimeout(r, 1500))])
  }
  const stopMyTranscript = () => {
    try { speechRef.current?.stop() } catch {}
    speechRef.current = null
    return stopPieces()
  }

  // The call's switch — anyone on the call may flip it, and everyone is told.
  const setCallTranscription = async (on: boolean) => {
    const id = callIdRef.current
    if (!id) return
    transcribeRef.current = on
    setTranscribing(on)
    if (on) startMyTranscript(); else stopMyTranscript()
    try { await api.post(`/chat/call/${id}/recording`, { on }) }
    catch (e: any) { toast.error('Could not change transcription: ' + e.message) }
  }

  // ---- signalling ---------------------------------------------------------
  const signal = useCallback((to: string, payload: any) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'call-signal', callId: callIdRef.current, to, signal: { ...payload, session: sessionIdRef.current } })) } catch {}
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

  // Bind the self-preview to whatever we are currently sending. This cannot be
  // done where the camera is acquired: the self tile only exists once `kind`
  // flips to 'video', so the ref is still null at that moment — which is why an
  // upgraded audio call showed your camera to everyone except you.
  useEffect(() => {
    const el = localVideoRef.current
    const stream = sharing ? screenRef.current : localRef.current
    if (el && stream && el.srcObject !== stream) el.srcObject = stream
  })

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
      transcribeRef.current = call.transcribe !== 0; setTranscribing(transcribeRef.current)
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
      transcribeRef.current = res.transcribe !== 0; setTranscribing(transcribeRef.current)
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
            // Their session changed: this is the same person from a new tab or a
            // new device, and the connection we hold is to a browser that is
            // gone. Replace it here — keyed off the offer itself — rather than
            // on the call-joined event, which races the offer and used to leave
            // the rejoined side sending but never receiving.
            const known = peerSessionRef.current.get(from)
            if (sig.session && known && known !== sig.session) {
              const dead = pcsRef.current.get(from)
              if (dead) { try { dead.close() } catch {} }
              pcsRef.current.delete(from)
              negRef.current.delete(from)
              pendingIce.current.delete(from)
            }
            if (sig.session) peerSessionRef.current.set(from, sig.session)

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
          // Someone picked up, or came back. Nothing is torn down here on
          // purpose: replacing the connection is driven by the session id on
          // their next offer, which cannot race with the offer the way this
          // event could.
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
          // Someone flipped the call's transcription. Everyone follows it —
          // MY side included, because the Web Speech API hears this device's
          // microphone and nothing else, so the far end of a call can only
          // ever be captured by the far end.
          transcribeRef.current = !!msg.on
          setTranscribing(!!msg.on)
          if (msg.on) startMyTranscript(); else void stopMyTranscript()
          if (msg.by !== user.id) {
            toast.info(msg.on
              ? `${msg.byName || 'Someone'} turned transcription on — this call will be summarised into tasks`
              : `${msg.byName || 'Someone'} turned transcription off`)
          }
          return
        }
        if (msg.type === 'call-summary') {
          // The call I was on has been written up and its tasks handed out.
          const n = msg.assigned || 0, left = msg.pending || 0
          toast.success(`Call summary is in the chat${n ? ` — ${n} task${n === 1 ? '' : 's'} assigned` : ''}${left ? `, ${left} without an owner yet` : ''}`, 8000)
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

  // Re-enter a call that is still running. Deliberately silent and automatic:
  // no "Resume?" prompt. A dropped call is not a decision someone made, it is an
  // accident of a closed tab, a dead battery or a walk out of signal — and the
  // people still on the call are waiting. Leaving explicitly (hang up) records
  // left_at, so a call you MEANT to leave is never rejoined.
  const rejoinedRef = useRef(false)
  useEffect(() => {
    if (!user) return
    let cancelled = false
    const tryRejoin = async () => {
      if (cancelled || rejoinedRef.current || callIdRef.current) return
      let live: any = null
      try { live = (await api.get('/chat/calls/active')).call } catch { return }
      if (!live || cancelled || callIdRef.current) return
      rejoinedRef.current = true
      const k: CallKind = live.kind === 'video' ? 'video' : 'audio'
      setKind(k); kindRef.current = k
      setTitle(live.title || 'Call')
      setPhase('connecting')
      setCallId(live.id); callIdRef.current = live.id
      convIdRef.current = live.conversation_id
      try {
        await grabMedia(k)
      } catch {
        cleanup()
        toast.error('Rejoining the call needs the microphone')
        return
      }
      try {
        const res: any = await api.post(`/chat/call/${live.id}/answer`)
        transcribeRef.current = (res.transcribe ?? live.transcribe) !== 0; setTranscribing(transcribeRef.current)
        toldRef.current = live.id // already told when it began
        await offerTo(res.peers || live.peers || [], peersNameRef.current)
        toast.info('Reconnected to your call')
      } catch { cleanup() }
    }
    // On open, and again when the tab comes back — a phone that slept may have
    // missed the socket entirely.
    const t = setTimeout(tryRejoin, 900)
    const onVis = () => { if (document.visibilityState === 'visible') tryRejoin() }
    document.addEventListener('visibilitychange', onVis)
    return () => { cancelled = true; clearTimeout(t); document.removeEventListener('visibilitychange', onVis) }
  }, [user?.id, grabMedia, offerTo, cleanup])

  // The bus: Chats (or anything else) asking us to ring someone.
  useEffect(() => subscribeCalls((req) => { begin(req.conversationId, req.kind, req.title) }), [begin])

  // The media is flowing: from here on, my half of the call is transcribed
  // (while the switch is on), and everyone is told so once, in words — a
  // transcript nobody was told about is not one this app will take.
  useEffect(() => {
    if (phase !== 'live') return
    liveRef.current = true
    if (!transcribeRef.current) return
    startMyTranscript()
    if (toldRef.current !== callIdRef.current) {
      toldRef.current = callIdRef.current
      toast.info('This call is transcribed, so its summary and tasks land in the chat when it ends. Anyone on the call can switch that off.', 8000)
    }
  }, [phase])

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

  // Muting also pauses MY transcription. Speech recognition opens the
  // microphone by itself, apart from the call's track, so a muted aside would
  // otherwise still be written down — and, the call being summarised into
  // tasks, could end up assigned to someone.
  const toggleMic = () => {
    const t = localRef.current?.getAudioTracks()[0]
    if (!t) return
    t.enabled = !t.enabled
    micOnRef.current = t.enabled
    setMicOn(t.enabled)
    if (t.enabled) startMyTranscript(); else void stopMyTranscript()
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

      {phase !== 'idle' && (
        <div className={'call-stage' + (minimized ? ' mini' : '') + (maximized ? ' max' : '')}>
          <div className="call-stage-head">
            <div style={{ minWidth: 0 }}>
              <div className="call-stage-title">{title}</div>
              <div className="call-stage-sub">
                {phase === 'ringing' ? 'Ringing…' : phase === 'connecting' ? 'Connecting…' : fmt(elapsed)}
                {sharing && ' · sharing screen'}
                {transcribing && phase === 'live' && (
                  <span className={'rec-badge' + (speechDead ? ' muted-speech' : '')}
                    title={speechDead
                      ? `Transcribing, but not on this device: ${speechDead}`
                      : `Transcribed for tasks — ${heardCount} line${heardCount === 1 ? '' : 's'} from you so far`}>
                    <span className="rec-dot" />Transcribing
                    {speechDead ? ' · not you' : heardCount > 0 ? ` · ${heardCount}` : ''}
                  </span>
                )}
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
            {/* The call's transcription switch. On by default; anyone on the
                call may switch it off, and everyone is told who did. What was
                said while it was on still becomes the summary. */}
            <button
              className={'call-btn' + (transcribing ? ' recording' : '')}
              onClick={() => setCallTranscription(!transcribing)}
              disabled={!callId}
              title={transcribing ? 'Transcribing for tasks — press to stop for everyone' : 'Not transcribing — press to transcribe this call for tasks'}
              aria-label={transcribing ? 'Stop transcribing this call' : 'Transcribe this call for tasks'}
              aria-pressed={transcribing}
            >
              <Ic name={transcribing ? 'taskAdd' : 'record'} size={19} />
            </button>
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
