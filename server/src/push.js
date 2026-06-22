// Native push notifications via Firebase Cloud Messaging (FCM HTTP v1).
//
// Deliberately AVOIDS the heavy `firebase-admin` SDK: we mint a short-lived OAuth
// access token from the service account using `jsonwebtoken` (already a dep) and
// POST to the FCM v1 endpoint with plain fetch. This keeps the Render build small
// and fast.
//
// Credentials come from the FIREBASE_SERVICE_ACCOUNT env var (the full service-
// account JSON, set in the Render dashboard — never committed). Missing/invalid →
// every function here is a safe no-op, so the app runs fine without push.
import jwt from 'jsonwebtoken'
import { db } from './db.js'

let svc = null // parsed service account
let svcTried = false
let cachedToken = null // { access_token, exp(ms) }

function getServiceAccount() {
  if (svcTried) return svc
  svcTried = true
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) { console.log('  Push: off (FIREBASE_SERVICE_ACCOUNT not set)'); return null }
  try {
    svc = JSON.parse(raw)
    if (!svc.client_email || !svc.private_key || !svc.project_id) throw new Error('missing client_email/private_key/project_id')
    console.log(`  Push: on (FCM project ${svc.project_id})`)
  } catch (e) {
    console.warn('  Push: FIREBASE_SERVICE_ACCOUNT invalid —', e.message)
    svc = null
  }
  return svc
}

// Exchange the service account for a Google OAuth access token (cached ~1h).
async function getAccessToken() {
  const sa = getServiceAccount()
  if (!sa) return null
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.access_token
  const nowSec = Math.floor(Date.now() / 1000)
  const key = sa.private_key.replace(/\\n/g, '\n') // tolerate double-escaped newlines
  const assertion = jwt.sign(
    {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    },
    key,
    { algorithm: 'RS256' },
  )
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) throw new Error(`oauth ${res.status}: ${JSON.stringify(data).slice(0, 200)}`)
  cachedToken = { access_token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 }
  return cachedToken.access_token
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
// logged and dead tokens are pruned. FCM HTTP v1 sends one token per request.
export async function sendPushToUser(userId, { title, body, data }) {
  const sa = getServiceAccount()
  if (!sa || !userId) return
  const tokens = db.prepare('SELECT token FROM device_tokens WHERE user_id=?').all(userId).map((r) => r.token)
  if (!tokens.length) return

  let accessToken
  try { accessToken = await getAccessToken() } catch (e) { console.warn('  [push] auth failed:', e.message); return }
  if (!accessToken) return

  const stringData = {}
  for (const [k, v] of Object.entries(data || {})) stringData[k] = v == null ? '' : String(v)

  const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`
  await Promise.all(tokens.map(async (tok) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: tok,
            notification: { title, body },
            data: stringData,
            android: { priority: 'high', notification: { sound: 'default', channel_id: 'smarttask_v2' } },
          },
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        const status = err?.error?.status || ''
        // Prune tokens FCM says are gone/invalid so they don't pile up.
        if (res.status === 404 || status === 'NOT_FOUND' || status === 'UNREGISTERED' || status === 'INVALID_ARGUMENT') {
          db.prepare('DELETE FROM device_tokens WHERE token=?').run(tok)
        } else {
          console.warn('  [push] send failed', res.status, JSON.stringify(err).slice(0, 150))
        }
      }
    } catch (e) {
      console.warn('  [push] send error:', e.message)
    }
  }))
}
