// One-time data restore.
//
// The live DB lives on the Render persistent disk (server/data/smarttask.db).
// That disk was created empty and only ever got the demo seed, so the real org
// data (users/meetings/tasks created locally) wasn't there. This module copies a
// committed snapshot (server/restore/smarttask.db — OUTSIDE the disk mount, so it
// ships with the git checkout) onto the disk the FIRST time this version boots.
//
// It MUST run before db.js opens the database, so index.js imports this module
// before './db.js'. A marker file ON THE DISK makes it run exactly once — so a
// later redeploy/restart never clobbers data created on the live site afterwards.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')
const liveDb = path.join(dataDir, 'smarttask.db')
const snapshot = path.join(__dirname, '..', 'restore', 'smarttask.db')
const marker = path.join(dataDir, '.imported-v1') // bump the suffix to force a re-import

try {
  fs.mkdirSync(dataDir, { recursive: true })
  if (fs.existsSync(snapshot) && !fs.existsSync(marker)) {
    // Drop the existing DB + its WAL/SHM so SQLite can't replay a stale journal
    // onto the freshly copied file (which would corrupt it).
    for (const f of [liveDb, `${liveDb}-wal`, `${liveDb}-shm`]) {
      try { fs.rmSync(f, { force: true }) } catch {}
    }
    fs.copyFileSync(snapshot, liveDb)
    fs.writeFileSync(marker, new Date().toISOString())
    console.log('  [restore] one-time import of real org data from snapshot — done')
  }
} catch (e) {
  // Never block startup on a restore problem; the app still boots on existing data.
  console.warn('  [restore] skipped:', e.message)
}
