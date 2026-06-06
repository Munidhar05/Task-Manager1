// Lightweight daily scheduler (no external cron dependency). Checks every minute;
// at the target hour it runs the digest once per day, guarded by app_meta so a
// restart can't double-send.
import { db } from './db.js'
import { sendDailyDigests } from './digest.js'

const SEND_HOUR = Number(process.env.DIGEST_HOUR || 8) // local server time, 0-23

function getMeta(key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)
  return row ? row.value : null
}
function setMeta(key, value) {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
}

async function tick() {
  const now = new Date()
  const todayStr = now.toISOString().slice(0, 10)
  if (now.getHours() === SEND_HOUR && getMeta('digest_last_sent') !== todayStr) {
    setMeta('digest_last_sent', todayStr) // mark first so a crash mid-send won't loop
    try { await sendDailyDigests() } catch (e) { console.error('[scheduler] digest failed:', e.message) }
  }
}

export function startScheduler() {
  console.log(`  Daily task digest scheduled for ${String(SEND_HOUR).padStart(2, '0')}:00 (local time)`)
  setInterval(tick, 60 * 1000) // check every minute
}
