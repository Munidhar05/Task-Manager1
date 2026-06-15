// Native push registration (Android, via FCM). Runs ONLY inside the Capacitor
// app — on the website `Capacitor.isNativePlatform()` is false and this no-ops
// (the browser uses its own notification mechanism, not wired here).
//
// Flow: ask permission → register with FCM → send the device token to our server
// (/notifications/register-device) so notify() can push to it. Tapping a push
// opens the relevant screen.
import { Capacitor } from '@capacitor/core'
import { api } from './api'

let started = false
let lastToken: string | null = null

export async function registerPush() {
  if (started || !Capacitor.isNativePlatform()) return
  started = true
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')

    // Android 8+ needs a channel for the heads-up alert the server sends (channelId 'smarttask').
    try {
      await PushNotifications.createChannel({
        id: 'smarttask',
        name: 'SmartTask alerts',
        description: 'Task assignments and new messages',
        importance: 5,
        visibility: 1,
      })
    } catch {}

    let perm = await PushNotifications.checkPermissions()
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await PushNotifications.requestPermissions()
    }
    if (perm.receive !== 'granted') { started = false; return }

    await PushNotifications.register()

    PushNotifications.addListener('registration', async (token) => {
      lastToken = token.value
      try { await api.post('/notifications/register-device', { token: token.value, platform: 'android' }) } catch {}
    })
    PushNotifications.addListener('registrationError', (e) => console.warn('[push] registration error', e))

    // Tap on a notification → open the matching screen.
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const data: any = action.notification?.data || {}
      const dest = data.type === 'chat_message' ? '/chats' : '/tasks'
      if (location.pathname !== dest) location.assign(dest)
    })
  } catch (e) {
    started = false
    console.warn('[push] setup failed', e)
  }
}

// On logout, stop this device receiving the current user's pushes.
export async function unregisterPush() {
  if (!Capacitor.isNativePlatform()) return
  try {
    if (lastToken) { try { await api.post('/notifications/unregister-device', { token: lastToken }) } catch {} }
    const { PushNotifications } = await import('@capacitor/push-notifications')
    await PushNotifications.removeAllListeners()
  } catch {}
  lastToken = null
  started = false
}
