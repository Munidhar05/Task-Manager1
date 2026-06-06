import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { initSchema, db } from './db.js'
import { ensureSeed } from './seed.js'

import authRoutes from './routes/auth.js'
import userRoutes from './routes/users.js'
import meetingRoutes from './routes/meetings.js'
import taskRoutes from './routes/tasks.js'
import dashboardRoutes from './routes/dashboards.js'
import assistantRoutes from './routes/assistant.js'
import notificationRoutes from './routes/notifications.js'
import digestRoutes from './routes/digest.js'
import { startScheduler } from './scheduler.js'
import { attachLiveTranscribe } from './ws/liveTranscribe.js'

initSchema()
ensureSeed()

const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))

// API responses are per-user and must never be cached (prevents one account's
// data — e.g. notifications — from being served to another from cache).
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.set('Vary', 'Authorization')
  next()
})

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ai_engine: process.env.ANTHROPIC_API_KEY ? 'claude' : (process.env.OPENAI_API_KEY ? 'openai' : 'rule-based (offline)'),
    transcription: process.env.TRANSCRIPTION_PROVIDER || 'none',
  })
})

app.use('/api/auth', authRoutes)
app.use('/api/users', userRoutes)
app.use('/api/meetings', meetingRoutes)
app.use('/api/tasks', taskRoutes)
app.use('/api/dashboards', dashboardRoutes)
app.use('/api/assistant', assistantRoutes)
app.use('/api/notifications', notificationRoutes)
app.use('/api/digest', digestRoutes)

app.use((err, req, res, next) => {
  console.error('[error]', err)
  res.status(500).json({ error: err.message || 'Internal error' })
})

const PORT = process.env.PORT || 4000
const server = app.listen(PORT, () => {
  console.log(`\n  SmartTask AI server → http://localhost:${PORT}`)
  console.log(`  AI engine: ${process.env.ANTHROPIC_API_KEY ? 'Claude (online)' : 'rule-based (offline fallback)'}`)
  console.log(`  Users in DB: ${db.prepare('SELECT COUNT(*) c FROM users').get().c}`)
  startScheduler()
  console.log('')
})

// Live meeting transcription stream (browser <-> Sarvam) shares the HTTP server.
attachLiveTranscribe(server)

// Release the port cleanly on exit / restart so `node --watch` (and Ctrl+C)
// don't leave an orphaned process squatting on :4000 → no more EADDRINUSE.
const shutdown = () => server.close(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.once('SIGUSR2', () => server.close(() => process.kill(process.pid, 'SIGUSR2'))) // nodemon/watch restart
