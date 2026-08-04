# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

VoTask / SmartTask — an AI execution platform that turns multilingual meeting speech
(Telugu / Hindi / English, code-mixed) into assignable tasks. Ships as a web app and a
Capacitor Android app. `README.md` covers features, demo accounts and env vars; this file
covers what you need to *change* the code safely.

## Commands

```bash
cd server && npm run dev        # Express + SQLite on :4000 (node --watch)
cd client && npm run dev        # Vite on :5173, proxies /api → :4000

cd client && npm run build      # tsc -b && vite build  — the only real "lint" gate
cd client && npx tsc --noEmit -p tsconfig.json   # faster type-check on its own

cd server && npm run seed       # demo org + 2 multilingual meetings
cd server && npm run rag:index  # backfill embeddings over existing tasks/meetings
```

**There is no test suite and no linter** — no jest/vitest, no eslint config anywhere. The
type-check above and *actually running the app* are the verification story. Use the
`verify` skill (`.claude/skills/verify/SKILL.md`) for the browser-driving recipe: minting a
JWT instead of logging in, installing `playwright-core` into the scratchpad rather than the
project, and injecting fake speech for voice work.

`index.js` closes the HTTP server on SIGINT/SIGTERM/SIGUSR2, so `EADDRINUSE` on :4000 means
a genuinely orphaned process — kill that listener rather than moving ports. Vite has no
such handler: killing its npm wrapper can leave the child squatting :5173, and Vite will
quietly start the next run on :5174, where it still proxies to :4000 and works. If you
start dev servers, make sure you actually stopped the underlying `node` processes.

## The database is live production data

`server/data/smarttask.db` holds a real organization's tasks, chats and users. Read it
freely; **never run anything that writes to it**. `db.js` honours a `DB_PATH` env var for
exactly this — point a throwaway server at a copy in the scratchpad:

```bash
cp data/smarttask.db{,-wal,-shm} "$SCRATCH/"     # WAL + SHM too, or the copy looks empty
DB_PATH="$SCRATCH/smarttask.db" npm run dev
```

The repo also lives inside OneDrive, which has been observed silently reverting
uncommitted edits. Commit as soon as a change verifies.

### Schema changes

The whole schema is one `db.exec()` of `CREATE TABLE IF NOT EXISTS` inside `initSchema()`
in `server/src/db.js`. Existing databases never re-run it, so **adding a column to that
block does nothing to a deployed DB**. Two helpers handle evolution, both at the bottom of
the same file:

- `ensureColumn(table, col, def)` — idempotent `ALTER TABLE ADD COLUMN`.
- `runOnce(key, fn)` — arbitrary migration guarded by a marker row in `app_meta`. Used for
  table rebuilds (SQLite can't drop a constraint) and for backfilling new tables from old.

New indexes on migrated columns must be created *after* the `ensureColumn` call, not in the
inline schema, or older DBs fail on boot.

`restore.js` must be imported **before** `db.js` in `index.js` — it copies a committed
snapshot onto the Render disk on first boot of a version, and cannot run once the DB is open.

## Architecture

### Server (`server/src`, Express, ESM, `type: module`)

`index.js` mounts one router per domain at `/api/<name>` and, in production, also serves
`client/dist` with an SPA fallback — one Render service is both the API and the website.

Auth is `server/src/auth.js`: `authRequired` puts the full user row on `req.user`; routers
call `r.use(authRequired)` once at the top and then gate individual routes with
`requireRole('manager','admin')`. `requirePlatformAdmin` is the single deliberate exception
to per-org isolation — **every other query must filter by `req.user.org_id`**.

`util.js` is the shared kit: `id(prefix)` (nanoid), `now()` (ISO), `audit(...)` — call it on
every mutation, the admin audit log and the leaderboard both read `audit_logs` — and
`notify()` / `notifyManagers()`, which write an in-app notification *and* fire FCM push.

Two WebSocket hubs share the HTTP server: `ws/chatHub.js` (real-time chat) and
`ws/liveTranscribe.js` (browser ↔ Sarvam audio relay). Browsers can't set headers on a WS
upgrade, so those authenticate via `verifyToken()` on a query-string token.

`scheduler.js` is a one-minute `setInterval`, not cron. It sends the daily digest, guarded
by an `app_meta` row so a restart can't double-send. Nothing else is scheduled — the
leaderboard is counted live on every read.

### AI (`server/src/ai`) — pluggable, degrades to zero keys

`extractor.js` is the orchestrator: OpenRouter → Claude → OpenAI → `rules.js` + `dates.js`,
each tier tried only if its key is set and falling through on error. **The app must keep
working with no API keys at all** — the rule-based engine is a real code path, not a stub,
so don't make a feature depend unconditionally on an LLM response.

The voice assistant is a tool-dispatch agent: `voiceTools.js` declares the callable tools,
`routes/assistant.js` dispatches them, and mutations always round-trip through an on-screen
confirmation before executing. RAG retrieval (`ragRetrieve.js`) is RBAC-filtered — an
employee's query must never retrieve another person's tasks.

### Client (`client/src`, React 18 + TS + Vite)

`api.ts` is the only way to talk to the backend: `api.get/post/put/patch/del/upload`, JWT
injected from `localStorage['smarttask_token']`, errors thrown as `Error(data.error)`.
`API_BASE` is empty in dev (Vite proxies) and set to the hosted URL for Android builds.
`<img>` can't send an Authorization header, so avatars and attachments use the
`*Url()` helpers that put the token in the query string.

`App.tsx` holds the `Layout` — sidebar, mobile bottom nav, and the globally mounted
`VoiceAssistant`, `ToastHost`, `ConfirmHost`, and feedback tab. Routes are declared there;
note the dashboard is `/`, there is no `/dashboard`.

Cross-cutting UI is imperative, not context: `toast.success(...)` / `toast.error(...)` from
`lib/toast.ts`, `confirmDialog({...}) → Promise<boolean>` from `lib/confirm.ts`. Shared
presentational pieces (`Ic`, `Avatar`, `Badge`, `Bar`, `Donut`, `EmptyState`, the priority /
status / category colour maps) all live in the single `ui.tsx`.

**All styling is one global `styles.css`** — no CSS modules, no styled-components, no
Tailwind. Class names are hand-namespaced by feature (`.lb-*` leaderboard, `.fb-*` feedback,
`.va-*` voice assistant, `.bn-*` bottom nav). Add new rules next to their feature's block.

Mobile is a `@media (max-width: 720px)` layer near the end of the file that re-lays-out the
whole app (bottom tab bar, off-canvas sidebar, FABs). The bottom-right corner on phones is
crowded and contested — the tab bar, the new-task FAB, the mic orb, the voice pill, toasts
and the verify-email card all claim space there. Before placing anything fixed near it,
check what already occupies that band at 430px and confirm the tap actually lands on your
element (`document.elementFromPoint`), not on a card stacked over it.

`vite.config.ts` does two non-obvious things: it injects `__APP_VERSION__` from
`package.json`, and it *stubs out* `onnxruntime-web` and deletes the wake-word models from
the build unless `VITE_WAKEWORD_ENABLED=true` — a dynamic import alone would still have
bundled ~9 MB. It reads env through `loadEnv`, which only reads `.env` **files**; an inline
`VITE_FOO=… npm run dev` never reaches the client.

## Android

```bash
cd client && npm run build && npx cap sync android
cd android && ./gradlew assembleRelease      # or bundleRelease for a Play .aab
```

`applicationId` is `io.smarttask.app` and must stay that way — changing it orphans every
existing install. `versionCode` climbs and is never reused; `versionName` is just the user-
facing label and doesn't have to track it (currently `versionCode 5` / `"3.1"`).
`client/.env.production` must point `VITE_API_BASE` at the deployed API before the build,
and signing lives in `client/android/keystore.properties`.

## Conventions

Comments here explain **why**, not what — the existing files carry a lot of reasoning about
rejected alternatives and non-obvious constraints. Match that density and keep the
explanation accurate when you change the code under it; a stale rationale is worse than
none. Follow the surrounding style: no semicolons, single quotes, 2-space indent.
