# Befach Task Manager (SmartTask) — AI Execution Platform

An AI-powered work platform that turns **multilingual meeting conversations** (Telugu / Hindi / English, including code-mixed speech) into structured, trackable, assignable tasks — and then helps the team actually execute them, by voice, chat, and mobile.

> Manager: *"Ravi, deployment documentation ready cheyyandi by tomorrow."*
> → **Task:** Deployment documentation · **Assignee:** Ravi Kumar · **Due:** tomorrow → resolved date · **Priority:** Medium

Ships as a **web app** and a **native Android app** (Capacitor, `io.smarttask.app`, v2.1).

---

## What it does

### Meeting intelligence
- Paste a transcript **or upload audio** — speaker-wise breakdown, executive summary, decisions, risks, blockers, follow-ups, and extracted tasks.
- **Live transcription** over WebSocket (`/api/meetings/live`) for in-progress meetings.
- Extracted tasks arrive as **suggestions** you can edit, merge, reject, restore, then assign in bulk.
- Multilingual + code-mixed understanding: English, Hindi, Telugu, in Latin and native scripts.
- **Ownership detection** — vocative ("Munidhar, …"), self-commitment ("I'll …", "nenu chestanu"), or **Needs Confirmation** when unclear.
- **Natural-language deadlines** — "by Friday", "repu", "kal", "end of week", "next Monday" → real dates.
- **Priority detection** — Critical / High / Medium / Low from urgency cues in all three languages.

### Tasks
- Lifecycle: To Do → In Progress → Blocked → In Review → Done → Reopened, with a manager **approval workflow**.
- Comments, attachments, subtasks, dependencies, progress, **task splitting** across people, and reassignment.
- **Origin badges** — every task shows how it reached you (meeting, voice, chat, manual) and surfaces delegated work.

### Voice assistant
- Full-screen assistant plus a **minimized bar mode**: after it navigates, the session stays live so follow-ups need no wake word.
- **Multi-step agent** — one request can plan several actions ("message everyone overdue, then mark this done"), confirmed once, executed in sequence with progress.
- Capabilities (`server/src/ai/voiceTools.js`): create / update / assign / delete tasks, set status, add comments, **send real chat messages**, add & remove teammates (removal gated by the manager's password), navigate anywhere in the app, start/open/summarize meetings, workload and overview analytics.
- Mutations always require an on-screen confirmation before they run.
- **Wake word "hey BTM"** — Web Speech phrase-match with fallback to an on-device openWakeWord ONNX model. Currently **disabled in production builds** until the real `hey_btm.onnx` model is trained (see `docs/HEY_BTM_TRAINING.md` + the runnable notebook).

### Team
- **Chat** — direct + group conversations, file uploads, reactions, stars, forwarding, edit/delete, read receipts, presence, real-time delivery over WebSocket.
- **Leaderboard & scoring** — daily performance rollups with a calibration view.
- **Push notifications** (native FCM) for task assignment, reassignment, submission, approval, reopen, comments, and chat messages.
- **Daily digest** to Zoho Cliq and email at `DIGEST_HOUR`.
- Role dashboards: Employee (my work), Manager (team workload, project progress, overdue), Admin hub (org metrics, users, audit log), and a **Platform** view for cross-org stats.
- Onboarding: signup, email verification, password reset, Google Sign-In, invite links, and bulk user import from xlsx.

### AI assistant (text)
- Conversational **TaskBot** with **RAG** over your org's tasks and meetings — retrieval is RBAC-filtered so people only ever see their own scope.
- Natural-language search: *"show overdue tasks"*, *"tasks assigned to Munidhar"*, *"who is responsible for deployment"*, *"workload imbalance"*.

### Security
JWT auth, bcrypt, role-based access control, an audit log of every mutation, and per-org token/cost usage tracking.

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + TypeScript + Vite |
| Mobile | Capacitor (Android) — push notifications, native TTS |
| Backend | Node.js 20 + Express (ESM) |
| Realtime | WebSocket (chat hub + live transcription relay) |
| Database | SQLite via `better-sqlite3` — zero setup |
| Auth | JWT + bcrypt + Google Sign-In |
| LLM | OpenRouter (default `google/gemini-2.5-pro`) → Claude → OpenAI → **offline rule-based fallback** |
| Speech-to-text | Sarvam (saarika), with OpenAI / Groq Whisper alternatives |
| Embeddings | OpenAI (default) or Voyage |
| Push | FCM HTTP v1 (hand-minted OAuth JWT — no `firebase-admin`) |

## Architecture

```
client/            React SPA (Vite :5173, proxies /api → :4000) — also the Capacitor web shell
  src/pages/       Dashboard · Tasks · Chats · Leaderboard · Meetings · Assistant · Admin · Platform · auth pages
  src/components/  TaskBoard · TaskDrawer · VoiceAssistant · NotificationBell · UserManagement · …
  src/voice/       useVoiceAssistant · recorder (VAD) · tts · wakeword (ONNX) · wakeSpeech
  android/         Capacitor Android project (io.smarttask.app, versionName 2.1)

server/            Express API (:4000) — also serves client/dist in production
  src/ai/          extractor (orchestrator) · openrouter · claude · openai · rules · dates
                   transcribe · assistantChat · voiceTools · voiceTask · voiceSearch · voiceAnalytics
                   embeddings · ragIndex · ragRetrieve · usage
  src/routes/      auth · invites · users · meetings · tasks · dashboards · assistant
                   notifications · digest · chat · platform · usage · scores
  src/ws/          chatHub · liveTranscribe
  src/db.js        SQLite schema        src/seed.js  demo org + 2 multilingual meetings
  data/            smarttask.db + uploads (auto-created & seeded on first run)

deploy/            Oracle & Render/Vercel deployment guides
docs/              Project documentation · voice setup · Google Sign-In · hey_btm training (+ notebook)
render.yaml        Render Blueprint — one web service serving API + built client
```

The AI is **pluggable**: the extractor tries OpenRouter, then Claude, then OpenAI, and falls back to the deterministic rule-based engine (`rules.js` + `dates.js`) so the app runs with **zero API keys**.

---

## Quick start

Two terminals. **Node 20+** recommended (Render pins 20.19.0).

```bash
# 1) Backend
cd server
npm install
npm run dev          # → http://localhost:4000  (auto-creates & seeds the DB)

# 2) Frontend
cd client
npm install
npm run dev          # → http://localhost:5173
```

Open **http://localhost:5173** and sign in with a demo account.

### Demo accounts (password: `password123`)

| Role | Email | Sees |
|---|---|---|
| Manager (Admin) | `priya@demo.io` | Everything — team dashboards, meetings, approvals, Administration hub |
| Employee | `munidhar@demo.io` | Own tasks, chat, assistant |

Also seeded: `ravi@demo.io`, `anjali@demo.io`, `karthik@demo.io`. The DB ships with **2 multilingual meetings** (a code-mixed standup and a sprint-planning session) that already produced ~11 tasks.

### Try it
1. Log in as **priya@demo.io** → **Meetings → Upload meeting → Insert sample → Analyze**. Watch tasks get extracted with assignees, deadlines, and priorities.
2. Open any task to change status, comment, split it, and (as a manager) approve.
3. Tap the voice orb and say *"show me everything overdue"*, then follow up with *"message Ravi about the first one"*.

---

## Configuration

Copy `server/.env.example` to `server/.env`. Everything is optional — unset keys just disable that feature.

```
# LLM (first one present wins)
OPENROUTER_API_KEY=...     OPENROUTER_MODEL=google/gemini-2.5-pro
ANTHROPIC_API_KEY=...      ANTHROPIC_MODEL=claude-opus-4-8
OPENAI_API_KEY=...         OPENAI_MODEL=...

# Speech-to-text
TRANSCRIPTION_PROVIDER=sarvam    SARVAM_API_KEY=...   SARVAM_LANGUAGE=...
GROQ_API_KEY=...                 OPENAI_TRANSCRIBE_MODEL=...

# Push, mail, digest
FIREBASE_SERVICE_ACCOUNT={...}   SMTP_HOST/PORT/USER/PASS   MAIL_FROM
CLIQ_WEBHOOK_URL=...             DIGEST_HOUR=8

JWT_SECRET=...   APP_URL=...   PLATFORM_ADMIN_EMAILS=...
```

Client vars live in `client/.env` (dev) and `client/.env.production` (builds) — see `client/.env.example`. The important one is `VITE_API_BASE`: empty in dev (Vite proxies to :4000), and the Render URL for production/Android builds.

Build the RAG index over existing data with `cd server && npm run rag:index`.

## API surface (selected)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` · `/signup` · `/google` · `/verify-password` | Authentication |
| POST | `/api/meetings` · `/audio` · `/transcribe` | Upload transcript or audio → analyze → suggest tasks |
| POST | `/api/meetings/:id/assign` | Turn suggestions into real tasks |
| GET/POST/PATCH | `/api/tasks` | List/create/update tasks (filterable) |
| POST | `/api/tasks/:id/status` · `/split` · `/approve` · `/comments` · `/attachments` | Lifecycle |
| GET | `/api/dashboards/{employee,manager,admin,report}` | Role dashboards |
| POST | `/api/assistant/query` · `/command` | Text assistant · voice tool dispatcher |
| GET/POST | `/api/chat/*` | Conversations, messages, uploads, reactions |
| POST | `/api/notifications/register-device` | FCM device registration |
| GET | `/api/scores/leaderboard` · `/calibration` | Performance scoring |

## Deployment

`render.yaml` defines a **single Render web service** that builds the client and serves it from the Express app (`server/src/index.js` static + SPA fallback), with a 1 GB persistent disk for `server/data`. Health check: `/api/health`. Guides for Oracle Cloud and Render/Vercel live in [deploy/](deploy/).

### Android build

```bash
cd client
npm run build
npx cap sync android
cd android && ./gradlew assembleRelease     # or bundleRelease for the Play Store .aab
```

`client/.env.production` must point `VITE_API_BASE` at the deployed API. Signing config is in `client/android/keystore.properties`.

## Notes & limitations

- The offline rule-based engine is transparent and fine for demos; a real LLM is materially better on messy, heavily code-mixed speech.
- SQLite + a single org keeps setup zero-friction; the schema is multi-org ready and the Platform view already spans orgs.
- The wake word ships **disabled** in production — the current model is a placeholder, not the trained "hey BTM".
- To reset demo data: stop the server, delete `server/data/`, restart.
