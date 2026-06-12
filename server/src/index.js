import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
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
import chatRoutes from './routes/chat.js'
import { startScheduler } from './scheduler.js'
import { attachLiveTranscribe } from './ws/liveTranscribe.js'
import { attachChatHub } from './ws/chatHub.js'
import { hasEmbeddings, embedModel } from './ai/embeddings.js'
import { syncAll } from './ai/ragIndex.js'

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
  const ragOn = hasEmbeddings()
  res.json({
    ok: true,
    ai_engine: process.env.OPENROUTER_API_KEY
      ? `openrouter (${process.env.OPENROUTER_MODEL || 'google/gemini-2.5-pro'})`
      : (process.env.ANTHROPIC_API_KEY ? 'claude' : (process.env.OPENAI_API_KEY ? 'openai' : 'rule-based (offline)')),
    transcription: process.env.TRANSCRIPTION_PROVIDER || 'none',
    rag: {
      enabled: ragOn,
      model: ragOn ? embedModel() : null,
      indexed: db.prepare('SELECT COUNT(*) c FROM embeddings').get().c,
    },
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
app.use('/api/chat', chatRoutes)

// --- Serve the built web client (client/dist) from this SAME service ----------
// So one URL hosts BOTH the website (for people without the Android app) AND the
// API. On Render the client build sits at ../../client/dist relative to this file
// (server/src). Built by render.yaml's buildCommand. Skipped gracefully when the
// build isn't present (e.g. API-only local dev with the Vite dev server).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientDist = path.resolve(__dirname, '../../client/dist')
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist))
  // SPA fallback: any non-/api GET returns index.html so client-side routes
  // (BrowserRouter) survive a refresh or deep link. Unknown /api/* paths are
  // excluded so they still get a proper JSON 404 instead of the HTML shell.
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')))
  console.log(`  Web client: serving ${clientDist}`)
} else {
  console.log('  Web client: not built (API-only). Build client/ to serve the website here.')
}

app.use((err, req, res, next) => {
  console.error('[error]', err)
  res.status(500).json({ error: err.message || 'Internal error' })
})

const PORT = process.env.PORT || 4000
const server = app.listen(PORT, () => {
  console.log(`\n  SmartTask AI server → http://localhost:${PORT}`)
  console.log(`  AI engine: ${process.env.OPENROUTER_API_KEY
    ? `OpenRouter (${process.env.OPENROUTER_MODEL || 'google/gemini-2.5-pro'})`
    : (process.env.ANTHROPIC_API_KEY ? 'Claude (online)' : 'rule-based (offline fallback)')}`)
  const ragCount = db.prepare('SELECT COUNT(*) c FROM embeddings').get().c
  console.log(`  RAG: ${hasEmbeddings() ? `ON (${embedModel()}, ${ragCount} items indexed)` : 'OFF (no embedding key set)'}`)
  console.log(`  Users in DB: ${db.prepare('SELECT COUNT(*) c FROM users').get().c}`)
  startScheduler()
  console.log('')
})

// RAG catch-up: on boot, index anything created while embeddings were off or the
// server was down. Runs in the background (never blocks startup) and is cheap on
// repeat — unchanged items are skipped, so it makes ~0 API calls when nothing's new.
if (hasEmbeddings()) {
  syncAll()
    .then(({ embedded, skipped, pruned }) => {
      if (embedded || pruned) console.log(`  [rag] startup sync: embedded ${embedded} new, pruned ${pruned} orphan(s), ${skipped} already indexed`)
    })
    .catch((e) => console.warn('  [rag] startup sync skipped:', e.message))

  // Live RAG: periodic sync so the index stays current with NO manual command and
  // NO server restart. The per-route incremental hooks (indexTask/Meeting/Chat and
  // removeEmbedding) are best-effort and silently no-op if OpenAI is slow / rate-
  // limits mid-meeting or a delete races; this timer re-runs the same hash-based
  // sync to embed anything they missed AND prune orphaned vectors. Idempotent and
  // cheap on repeat — unchanged items are skipped, so it makes ~0 API calls when
  // nothing's new. Override the cadence with RAG_SYNC_MINUTES (default 5).
  const syncMinutes = Number(process.env.RAG_SYNC_MINUTES) || 5
  const timer = setInterval(() => {
    syncAll()
      .then(({ embedded, pruned }) => {
        if (embedded || pruned) console.log(`  [rag] periodic sync: embedded ${embedded} new, pruned ${pruned} orphan(s)`)
      })
      .catch((e) => console.warn('  [rag] periodic sync skipped:', e.message))
  }, syncMinutes * 60 * 1000)
  timer.unref?.() // don't keep the process alive solely for this timer
  console.log(`  [rag] live sync on: embed + prune every ${syncMinutes} min`)
}

// Live meeting transcription stream (browser <-> Sarvam) shares the HTTP server.
attachLiveTranscribe(server)
// Real-time internal chat push shares the same HTTP server (different path).
attachChatHub(server)

// Release the port cleanly on exit / restart so `node --watch` (and Ctrl+C)
// don't leave an orphaned process squatting on :4000 → no more EADDRINUSE.
const shutdown = () => server.close(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.once('SIGUSR2', () => server.close(() => process.kill(process.pid, 'SIGUSR2'))) // nodemon/watch restart
