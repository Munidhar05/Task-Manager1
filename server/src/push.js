// Native push notifications via Firebase Cloud Messaging (FCM).
//
// Sends a device-level push (tray/lock-screen, even when the app is closed) to a
// user's registered Android devices. Driven by the existing notify() in util.js,
// so task-assign / chat-message / comment events all push automatically.
//
// Credentials come from the FIREBASE_SERVICE_ACCOUNT env var (the full service-
// account JSON, set in the Render dashboard — never committed). If it's missing or
// invalid, every function here is a safe no-op, so the app runs fine without push.
import admin from 'firebase-admin'
import { db } from './db.js'

let app = null
let initTried = false

function getApp() {
  if (initTried) return app
  initTried = true
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) {
    console.log('  Push: off (FIREBASE_SERVICE_ACCOUNT not set)')
    return null
  }
  try {
    const cred = JSON.parse(raw)
    app = admin.initializeApp({ credential: admin.credential.cert(cred) })
    console.log(`  Push: on (FCM project ${cred.project_id})`)
  } catch (e) {
    console.warn('  Push: FIREBASE_SERVICE_ACCOUNT invalid —', e.message)
    app = null
  }
  return app
}

// Persist a device's FCM token for a user (idempotent: one row per token).
export function saveDeviceToken(userId, token, platform = 'android') {
  if (!userId || !token) return
  // A token can migrate between users (shared device / re-login) — keep it tied to
  // the latest user so pushes never leak to a previous account.
  db.prepare('DELETE FROM device_tokens WHERE token=?').run(token)
  db.prepare(
    `INSERT INTO device_tokens (id, user_id, token, platform, created_at) VALUES (?,?,?,?,?)`
  ).run(`dev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, userId, token, platform, new Date().toISOString())
}

export function removeDeviceToken(token) {
  if (!token) return
  db.prepare('DELETE FROM device_tokens WHERE token=?').run(token)
}

// Fire-and-forget push to all of a user's devices. Never throws — failures are
// logged and invalid tokens are pruned so they don't pile up.
export async function sendPushToUser(userId, { title, body, data }) {
  const a = getApp()
  if (!a || !userId) return
  const tokens = db.prepare('SELECT token FROM device_tokens WHERE user_id=?').all(userId).map((r) => r.token)
  if (!tokens.length) return
  // FCM data values must be strings.
  const stringData = {}
  for (const [k, v] of Object.entries(data || {})) stringData[k] = v == null ? '' : String(v)
  try {
    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: stringData,
      android: { priority: 'high', notification: { sound: 'default', channelId: 'smarttask' } },
    })
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || ''
        if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
          db.prepare('DELETE FROM device_tokens WHERE token=?').run(tokens[i])
        }
      }
    })
  } catch (e) {
    console.warn('  [push] send failed:', e.message)
  }
}
