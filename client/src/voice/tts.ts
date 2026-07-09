// Text-to-speech for the voice assistant's spoken replies.
//  • Native (Android): the @capacitor-community/text-to-speech plugin, reached via
//    Capacitor's registerPlugin proxy so the web bundle never imports the package
//    (install + `cap sync` wires up the native side — see the setup doc).
//  • Web: the built-in window.speechSynthesis.
// speak() resolves when the utterance finishes (or immediately if TTS is off), so
// the conversation loop can re-open the mic right after the assistant stops talking.
import { Capacitor, registerPlugin } from '@capacitor/core'

interface TextToSpeechPlugin {
  speak(options: { text: string; lang?: string; rate?: number; pitch?: number; volume?: number }): Promise<void>
  stop(): Promise<void>
}
const NativeTTS = registerPlugin<TextToSpeechPlugin>('TextToSpeech')

const isNative = () => Capacitor.isNativePlatform()
export const ttsSupported = () =>
  isNative() || (typeof window !== 'undefined' && 'speechSynthesis' in window)

let enabled = true
export const setTtsEnabled = (on: boolean) => { enabled = on; if (!on) stopSpeaking() }
export const isTtsEnabled = () => enabled

export function stopSpeaking() {
  if (isNative()) { NativeTTS.stop().catch(() => {}) ; return }
  try { window.speechSynthesis?.cancel() } catch {}
}

// Speak `text`; resolves when done. Never rejects — TTS is best-effort.
export async function speak(text: string, lang = 'en-US'): Promise<void> {
  if (!enabled || !text) return
  stopSpeaking()
  if (isNative()) {
    try { await NativeTTS.speak({ text, lang, rate: 1.0, pitch: 1.0, volume: 1.0 }) } catch {}
    return
  }
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  await new Promise<void>((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = lang
      u.onend = () => resolve()
      u.onerror = () => resolve()
      window.speechSynthesis.speak(u)
      // Safety: some browsers never fire onend — resolve on a length-based timeout.
      setTimeout(resolve, Math.min(15000, 1200 + text.length * 60))
    } catch { resolve() }
  })
}
