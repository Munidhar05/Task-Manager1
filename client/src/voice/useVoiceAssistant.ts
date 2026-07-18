// The voice assistant's conversation engine. Owns the hands-free state machine:
//
//   armed ──(wake word / tap)──▶ listening ──▶ processing ──▶ {navigate | answer
//        ▲                                                     | confirm | clarify}
//        └──────────── speak reply, then re-open mic ──────────┘
//
// Each turn records until the speaker goes quiet (recorder VAD), transcribes via
// the existing multilingual endpoint, asks POST /assistant/command what to do, and
// then acts: navigates the UI, speaks an answer, or — for anything that changes
// data — asks for a spoken yes/no before executing against the normal task APIs
// (so permissions & notifications are unchanged). It keeps re-opening the mic so
// the exchange feels conversational, and falls back to "armed" when the user is
// silent. All spoken replies also go through TTS.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, API_BASE, getToken } from '../api'
import { startRecording, canRecord, Recording } from './recorder'
import { speak, stopSpeaking, isTtsEnabled, setTtsEnabled } from './tts'

export type VoiceState = 'idle' | 'listening' | 'processing' | 'confirming' | 'speaking' | 'error'

// A read tool (overview / workload / grouping) returns figures the UI renders as a
// card. `type` picks the renderer; the shape follows from the tool that produced it.
export interface VoiceCardData {
  type: 'overview' | 'workload' | 'group'
  label?: string
  title?: string
  stats?: Record<string, number>
  rows?: { id?: string; name?: string; label?: string; c: number }[]
  total?: number
}
// A message is either spoken text or a data card rendered inline in the panel.
export interface VoiceMsg { role: 'user' | 'ai'; text: string; card?: VoiceCardData }

interface PendingAction { kind: string; task_id?: string; to_user_id?: string; to_name?: string; text?: string; needsPassword?: boolean; summary?: string; body: any }

const YES_RE = /\b(yes|yeah|yep|yup|sure|ok|okay|okey|confirm|confirmed|correct|right|go ahead|do it|please do|haan|haa|ha|ji|karo|sari|sare|avunu|cheyyi|cheyandi|cheyyandi)\b/i
const NO_RE = /\b(no|nope|nah|cancel|cancelled|don'?t|stop|nahi|nahin|mat|vddu|venda|vodhu|leave it|never mind|nevermind)\b/i

export function useVoiceAssistant() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<VoiceState>('idle')
  const [messages, setMessages] = useState<VoiceMsg[]>([])
  const [level, setLevel] = useState(0)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [ttsOn, setTtsOnState] = useState(isTtsEnabled())

  // Refs mirror state for use inside the async turn loop (avoids stale closures).
  const sessionRef = useRef(0)          // bump to invalidate an in-flight loop
  const recRef = useRef<Recording | null>(null)
  const pendingRef = useRef<PendingAction | null>(null)
  const msgsRef = useRef<VoiceMsg[]>([])
  const emptyStreakRef = useRef(0)
  const openRef = useRef(false)
  msgsRef.current = messages
  pendingRef.current = pending
  openRef.current = open

  const push = (m: VoiceMsg) => setMessages((ms) => [...ms.slice(-20), m])
  const setPend = (p: PendingAction | null) => { pendingRef.current = p; setPending(p) }

  const setTtsOn = (on: boolean) => { setTtsEnabled(on); setTtsOnState(on) }

  // ---- server calls --------------------------------------------------------
  const transcribeBlob = async (blob: Blob): Promise<string> => {
    const fd = new FormData()
    fd.append('audio', blob, 'command.webm')
    const headers: Record<string, string> = {}
    const token = getToken()
    if (token) headers.authorization = `Bearer ${token}`
    const res = await fetch(`${API_BASE}/api/tasks/transcribe`, { method: 'POST', headers, body: fd, cache: 'no-store' })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error || 'Transcription failed')
    return String(data?.text || '').trim()
  }

  const sendCommand = (transcript: string) =>
    api.post('/assistant/command', { transcript, history: msgsRef.current.slice(-8) })

  // ---- execute a confirmed mutation via the existing task endpoints --------
  // Every kind maps to an endpoint the app already exposes, so permissions and
  // notifications behave exactly as they do from the UI.
  const execute = async (action: PendingAction, password?: string) => {
    setState('processing')
    try {
      switch (action.kind) {
        case 'create_task': await api.post('/tasks', action.body); break
        case 'set_status': await api.post(`/tasks/${action.task_id}/status`, action.body); break
        case 'add_comment': await api.post(`/tasks/${action.task_id}/comments`, action.body); break
        case 'delete_task': await api.del(`/tasks/${action.task_id}`); break
        case 'send_message': {
          // Find/create the direct thread, then post the message (both go through
          // the real chat endpoints, so notifications & push fire as normal).
          const conv: any = await api.post('/chat/conversations', { type: 'direct', userId: action.to_user_id })
          await api.post(`/chat/conversations/${conv.id}/messages`, { body: action.text })
          break
        }
        case 'remove_user': {
          // Gate the destructive account removal behind the manager's password.
          await api.post('/auth/verify-password', { password })
          await api.del(`/users/${action.to_user_id}`)
          break
        }
        // update_task / assign_task / set_priority / set_due_date all PATCH fields
        default: await api.patch(`/tasks/${action.task_id}`, action.body)
      }
      push({ role: 'ai', text: `✓ ${action.summary || 'Done'}` })
      await say('Done.')
      // Refresh whatever list is showing and jump to the relevant section.
      if (action.kind === 'send_message') {
        window.dispatchEvent(new Event('chat-unread-changed'))
        navigate('/chats')
      } else if (action.kind === 'remove_user') {
        window.dispatchEvent(new CustomEvent('users-changed'))
        navigate('/admin')
      } else {
        window.dispatchEvent(new CustomEvent('tasks-changed'))
        navigate('/tasks')
      }
    } catch (e: any) {
      const m = `Sorry, that didn't work: ${e?.message || 'please try again'}`
      push({ role: 'ai', text: m }); await say(m)
    }
  }

  // ---- speak + reflect state ----------------------------------------------
  const say = async (text: string) => {
    setState('speaking')
    await speak(text)
  }

  const handleResponse = async (resp: any) => {
    const sayText = String(resp?.say || '').trim()
    // Attach any figures to the reply so the panel can show them, not just speak them.
    if (sayText) push({ role: 'ai', text: sayText, card: resp?.data || undefined })
    switch (resp?.mode) {
      case 'confirm':
        if (resp.action) { setPend(resp.action); setState('confirming') }
        await say(sayText || 'Shall I go ahead?')
        break
      case 'navigate':
        await say(sayText || 'Opening that.')
        if (resp.navigate?.url) navigate(resp.navigate.url)
        break
      case 'answer':
        // Read tools may report a number AND open the matching list.
        await say(sayText || "I don't have anything on that.")
        if (resp.navigate?.url) navigate(resp.navigate.url)
        break
      case 'clarify':
      default:
        await say(sayText || "Sorry, I didn't understand.")
        break
    }
  }

  // ---- the conversational loop (records → interprets → acts → repeats) -----
  // Keeps re-opening the mic so the exchange flows; ends (→ armed) when the user
  // goes silent. `sessionRef` invalidates the loop if the user stops/closes.
  const runTurn = useCallback(async (): Promise<void> => {
    const mySession = sessionRef.current
    const alive = () => sessionRef.current === mySession && openRef.current

    while (alive()) {
      // 1. Listen
      setState('listening'); setLevel(0)
      let blob: Blob
      try {
        const rec = await startRecording({ onLevel: (l) => { if (alive()) setLevel(l) } })
        recRef.current = rec
        blob = await rec.done
      } catch {
        const m = 'I need microphone access to listen.'
        push({ role: 'ai', text: m }); setState('idle'); await speak(m); return
      }
      recRef.current = null
      if (!alive()) return

      // 2. Transcribe. Silence ends the loop → armed; any pending confirmation
      // stays on screen so its yes/no buttons still work.
      setState('processing'); setLevel(0)
      if (!blob.size) { setState('idle'); return }
      let text = ''
      try { text = await transcribeBlob(blob) } catch { /* treat as empty */ }
      if (!alive()) return
      if (!text) {
        emptyStreakRef.current++
        if (emptyStreakRef.current >= 2) { setState('idle'); return }
        await say("Sorry, I didn't catch that.")
        continue
      }
      emptyStreakRef.current = 0
      push({ role: 'user', text })

      // 3. If awaiting a yes/no on a pending action, resolve it locally first.
      const pend = pendingRef.current
      if (pend) {
        const yes = YES_RE.test(text), no = NO_RE.test(text)
        if (yes && !no) { setPend(null); await execute(pend); continue }
        if (no && !yes) { setPend(null); const m = 'Okay, cancelled.'; push({ role: 'ai', text: m }); await say(m); continue }
        setPend(null) // neither/both → treat as a revised command below
      }

      // 4. Ask the brain what to do, then act on it.
      let resp: any
      try { resp = await sendCommand(text) }
      catch { const m = 'I had trouble with that — please try again.'; push({ role: 'ai', text: m }); await say(m); continue }
      if (!alive()) return
      await handleResponse(resp)
      // loop → re-open the mic for the next command
    }
  }, [])

  // ---- public controls -----------------------------------------------------
  const start = useCallback(() => {
    if (!canRecord()) { push({ role: 'ai', text: 'Voice needs microphone access on this device.' }); setOpen(true); return }
    setOpen(true)
    emptyStreakRef.current = 0
    sessionRef.current++
    openRef.current = true
    runTurn()
  }, [runTurn])

  const stop = useCallback(() => {
    sessionRef.current++
    try { recRef.current?.cancel() } catch {}
    recRef.current = null
    stopSpeaking()
    setPend(null)
    setState('idle')
  }, [])

  const close = useCallback(() => { stop(); setOpen(false) }, [stop])

  // The panel's mic button: finalize the current turn if listening, barge-in past
  // TTS if speaking, or kick off a fresh turn when idle.
  const micButton = useCallback(() => {
    if (state === 'listening') { try { recRef.current?.stop() } catch {}; return }
    if (state === 'speaking') { stopSpeaking(); return }
    if (state === 'idle') {
      setOpen(true); emptyStreakRef.current = 0; sessionRef.current++; openRef.current = true; runTurn()
    }
  }, [state, runTurn])

  // Manual confirm / cancel buttons for the pending action card. `password` is
  // supplied only for actions that require re-auth (e.g. removing a teammate).
  const confirmPending = useCallback(async (password?: string) => {
    const p = pendingRef.current
    if (!p) return
    setPend(null); sessionRef.current++
    try { recRef.current?.cancel() } catch {}
    await execute(p, password)
    sessionRef.current++; openRef.current = true; runTurn()
  }, [runTurn])

  const cancelPending = useCallback(() => {
    setPend(null)
    const m = 'Okay, cancelled.'
    push({ role: 'ai', text: m }); speak(m)
  }, [])

  useEffect(() => () => { sessionRef.current++; try { recRef.current?.cancel() } catch {}; stopSpeaking() }, [])

  return {
    open, state, messages, level, pending, ttsOn,
    start, stop, close, micButton, confirmPending, cancelPending, setTtsOn,
    setOpen,
  }
}
