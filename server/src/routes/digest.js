import { Router } from 'express'
import { authRequired, requireRole } from '../auth.js'
import { sendDailyDigests } from '../digest.js'
import {
  sendDailyTaskMail, sendCriticalDigest, sendNewCriticalAlerts, sendDeadlineWarnings,
  sendTestBundle, runCatchUp, openTasksByOwner, countUnassignedCritical,
  dailyAt, criticalAt, deadlineHour, tz, toOwnersEnabled, testRecipient,
} from '../taskMail.js'
import { mailerMode } from '../mailer.js'
import { cliqEnabled } from '../cliq.js'

const r = Router()
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
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

// --- Per-owner task mail (src/taskMail.js) -----------------------------------

// Who it would reach and how, without sending anything. Read this before turning
// TASK_MAIL_TO_OWNERS on: `owners` is the exact list of people who start
// receiving mail the moment it goes live.
r.get('/task-mail/status', requireRole('manager', 'admin'), (req, res) => {
  const groups = openTasksByOwner()
  res.json({
    tz: tz(),
    dailyAt: dailyAt(),
    criticalAt: criticalAt(),
    deadlineHour: deadlineHour(),
    toOwners: toOwnersEnabled(),
    mode: toOwnersEnabled() ? 'owners (live)' : (testRecipient() ? 'test' : 'off'),
    testTo: testRecipient() || null,
    email: mailerMode(),
    owners: groups.map((g) => ({
      name: g.name,
      email: g.email,
      tasks: g.tasks.length,
      critical: g.tasks.filter((t) => t.priority === 'Critical').length,
    })),
    unassignedCritical: countUnassignedCritical(),
  })
})

// Rehearsal: build the real messages from the real data and deliver every one of
// them to a single address. Cannot go live no matter how the environment is set.
r.post('/task-mail/test', requireRole('manager', 'admin'), async (req, res) => {
  const to = String(req.body?.to || testRecipient() || '').trim()
  if (!EMAIL_RE.test(to)) {
    return res.status(400).json({ error: 'A test recipient is required — pass { to } or set TASK_MAIL_TEST_TO.' })
  }
  try {
    res.json(await sendTestBundle(to, { full: req.body?.full === true }))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Launch day only: send all three kinds once, right now, so the first day isn't
// silent. Respects the gate like everything else, refuses to run twice unless
// { force: true }, and accepts { to } to rehearse the whole catch-up to one inbox.
r.post('/task-mail/catch-up', requireRole('manager', 'admin'), async (req, res) => {
  const to = String(req.body?.to || '').trim()
  if (to && !EMAIL_RE.test(to)) return res.status(400).json({ error: 'to must be a valid email address' })
  try {
    res.json(await runCatchUp({ overrideTo: to || null, force: req.body?.force === true }))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Run a trigger exactly as the scheduler would — gate included, so this still
// only rehearses until TASK_MAIL_TO_OWNERS=true.
r.post('/task-mail/send-now', requireRole('manager', 'admin'), async (req, res) => {
  const which = String(req.body?.kind || 'daily')
  const run = {
    daily: sendDailyTaskMail, critical: sendCriticalDigest,
    assigned: sendNewCriticalAlerts, deadline: sendDeadlineWarnings,
  }[which]
  if (!run) return res.status(400).json({ error: 'kind must be one of: daily, critical, assigned, deadline' })
  try {
    res.json(await run())
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default r
