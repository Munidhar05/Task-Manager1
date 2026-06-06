import { Router } from 'express'
import { authRequired, requireRole } from '../auth.js'
import { sendDailyDigests } from '../digest.js'
import { mailerMode } from '../mailer.js'
import { cliqEnabled } from '../cliq.js'

const r = Router()
r.use(authRequired)

// Current delivery mode so the UI can show whether real messages go out.
r.get('/status', requireRole('manager', 'admin'), (req, res) => {
  res.json({
    mode: cliqEnabled() ? 'Cliq (live)' : 'preview/log',
    cliq: cliqEnabled(),
    email: mailerMode(),
    hour: Number(process.env.DIGEST_HOUR || 8),
  })
})

// Trigger the daily digest immediately. Managers & admins.
r.post('/send-now', requireRole('manager', 'admin'), async (req, res) => {
  try {
    const summary = await sendDailyDigests()
    res.json(summary)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default r
