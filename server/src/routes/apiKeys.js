// API keys — the credential a non-browser client uses to reach this API.
//
// Every route here requires a real signed-in session (`requireSession`), never a
// key. That is the containment property the whole feature rests on: a leaked key
// can do everything its owner can do, but it cannot mint a successor, so revoking
// it actually ends the access. If keys could issue keys, revocation would be a
// game of whack-a-mole against an attacker who already won.
//
// The plaintext is returned exactly once, from POST. Nothing stores it and no
// later request can recover it — a lost key is replaced, not looked up.
import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requireSession, generateApiKey } from '../auth.js'
import { id, now, audit } from '../util.js'

const r = Router()
r.use(authRequired, requireSession)

// Enough for a laptop, a CI job and a couple of experiments. The cap is not a
// security control — it is a guard against the drawer filling with keys nobody
// can identify, which is how key sprawl actually becomes dangerous.
const MAX_ACTIVE_KEYS = 20

// Never includes token_hash: the list is rendered in a browser, and the hash is
// the only stored secret. `prefix` is what identifies a row to a human.
const PUBLIC_COLUMNS = 'id, name, prefix, scope, created_at, last_used_at, expires_at, revoked_at'

const activeCount = (userId) =>
  db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL').get(userId).n

// LIST the caller's own keys. Deliberately not the org's: a manager has no
// business reading which tools a colleague has connected, and the list carries
// nothing that would let them revoke a compromised one anyway (see DELETE).
r.get('/', (req, res) => {
  const rows = db.prepare(
    `SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE user_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC`
  ).all(req.user.id)
  res.json({ keys: rows })
})

// CREATE. The response is the only time the token exists outside the client.
r.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80)
  if (!name) return res.status(400).json({ error: 'Give the key a name so you can recognise it later.' })
  if (activeCount(req.user.id) >= MAX_ACTIVE_KEYS) {
    return res.status(400).json({ error: `You already have ${MAX_ACTIVE_KEYS} active keys — revoke one first.` })
  }

  // Optional expiry, in days. An agent someone is trying out for an afternoon
  // should not still be able to read the org's tasks next year.
  let expiresAt = null
  const days = Number(req.body?.expires_in_days)
  if (Number.isFinite(days) && days > 0) {
    expiresAt = new Date(Date.now() + Math.min(days, 3650) * 86_400_000).toISOString()
  }

  // 'mcp' keys are for a Claude connector URL and are refused by the REST API;
  // 'full' keys are REST credentials and are refused by /mcp's URL. Neither is a
  // superset of the other, so a leak of one is not a leak of both.
  const scope = req.body?.scope === 'mcp' ? 'mcp' : 'full'

  const { token, hash, prefix } = generateApiKey()
  const kid = id('key')
  db.prepare(`INSERT INTO api_keys (id, org_id, user_id, name, prefix, token_hash, scope, expires_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(kid, req.user.org_id, req.user.id, name, prefix, hash, scope, expiresAt, now())
  audit(req.user.org_id, req.user.id, 'apikey.create', 'api_key', kid, `${name} (${scope})`)

  res.status(201).json({
    key: db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE id = ?`).get(kid),
    // Shown once. Say so here as well as in the UI — this response is what a
    // script author reads, and they will not have seen the dialog.
    token,
    warning: 'Copy this now. It is stored hashed and cannot be shown again.',
  })
})

// REVOKE. Own keys always; an admin may revoke anyone's in their org, which is
// the lever that matters when a laptop goes missing and its owner is unreachable.
r.delete('/:kid', (req, res) => {
  const key = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(req.params.kid)
  const mine = key && key.user_id === req.user.id
  const orgAdmin = key && key.org_id === req.user.org_id && req.user.role === 'admin'
  if (!key || (!mine && !orgAdmin)) return res.status(404).json({ error: 'Not found' })
  if (key.revoked_at) return res.json({ ok: true })   // already gone; not an error
  db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(now(), key.id)
  audit(req.user.org_id, req.user.id, 'apikey.revoke', 'api_key', key.id, key.name)
  res.json({ ok: true })
})

export default r
