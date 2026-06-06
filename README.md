# SmartTask AI — Meeting-to-Task Platform

An AI-powered task-management web app that turns **multilingual meeting conversations** (Telugu / Hindi / English, including code-mixed speech) into structured, trackable, assignable tasks — automatically.

> Manager: *"Ravi, deployment documentation ready cheyyandi by tomorrow."*
> → **Task:** Deployment documentation · **Assignee:** Ravi Kumar · **Due:** tomorrow → resolved date · **Priority:** Medium

---

## What it does

- **Meeting intelligence** — paste a transcript, get a speaker-wise breakdown, executive summary, decisions, risks, blockers, follow-ups, and extracted tasks.
- **Multilingual + code-mixed understanding** — English, Hindi, Telugu, and any mix, in both Latin and native scripts.
- **Task extraction** — title, description, assignee, assigned-by, due date, priority, ownership confidence, and the original spoken quote.
- **Ownership detection** — vocative ("Munidhar, …"), self-commitment ("I'll …", "nenu chestanu"), or **Needs Confirmation** when unclear.
- **Natural-language deadlines** — "by Friday", "repu", "kal", "end of week", "next Monday", "before deployment" → real dates.
- **Priority detection** — Critical / High / Medium / Low from urgency cues across all three languages.
- **Full task lifecycle** — To Do → In Progress → Blocked → In Review → Done → Reopened, with comments, subtasks, dependencies, progress, and a manager **approval workflow**.
- **Role-based dashboards** — Employee (my work) and Manager (team workload, project progress, overdue, plus org metrics, users & audit log — the manager is the org admin).
- **AI assistant** — natural-language questions: *"show overdue tasks"*, *"tasks assigned to Munidhar"*, *"who is responsible for deployment"*, *"daily status report"*, *"workload imbalance"*.
- **Security** — JWT auth, role-based access control (RBAC), and an audit log of every mutation.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + TypeScript + Vite |
| Backend | Node.js + Express |
| Database | SQLite (via `better-sqlite3`) — zero setup |
| Auth | JWT + bcrypt |
| AI engine | **Claude API** (multilingual extraction) with an **offline rule-based fallback** so the app runs with zero API keys |

## Architecture

```
client/  React SPA (Vite dev server on :5173, proxies /api → :4000)
server/  Express API (:4000)
  src/ai/        extractor.js (orchestrator) · claude.js · rules.js (offline) · dates.js · assistant.js
  src/routes/    auth · users · meetings · tasks · dashboards · assistant
  src/db.js      SQLite schema     src/seed.js  demo org + 2 multilingual meetings
  data/          smarttask.db (auto-created & seeded on first run)
```

The AI is **pluggable**: with `ANTHROPIC_API_KEY` set, transcripts are analyzed by Claude; without it, the deterministic rule-based engine (`rules.js` + `dates.js`) runs offline. If Claude errors, it automatically falls back.

---

## Quick start

Two terminals. **Node 18+ required** (uses global `fetch`).

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
| Manager (Admin) | `priya@demo.io` | Everything — team dashboards, meetings, approvals, plus the Administration hub (org metrics, user management, audit log) |
| Employee | `munidhar@demo.io` | Own tasks, assistant |

The database is seeded with **2 multilingual meetings** (a code-mixed standup and a sprint-planning session) that already produced ~11 tasks across the team.

### Try it
1. Log in as **priya@demo.io** → **Meetings → Upload meeting → Insert sample → Analyze**. Watch tasks get extracted with assignees, deadlines, and priorities.
2. Open any task to change status, comment, and (as a manager) approve.
3. Go to **AI Assistant** and ask *"who is responsible for deployment"* or *"workload imbalance"*.

---

## Enabling real Claude AI (optional)

Copy `server/.env.example` to `server/.env` and set:

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-8
```

Restart the backend. The engine pill in the top bar will switch to **claude**. Audio transcription is wired as a pluggable extension point (`TRANSCRIPTION_PROVIDER`); paste text transcripts in the meantime.

## API surface (selected)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Authenticate |
| POST | `/api/meetings` | Upload transcript → analyze → create tasks (manager+) |
| GET | `/api/meetings/:id` | Transcript, summary, extracted tasks |
| GET/POST/PATCH | `/api/tasks` | List/create/update tasks (filterable) |
| POST | `/api/tasks/:id/status` · `/approve` · `/comments` | Lifecycle, approval, comments |
| GET | `/api/dashboards/{employee,manager,admin}` | Role dashboards |
| POST | `/api/assistant/query` | Natural-language assistant / search |

## Notes & limitations

- The offline rule-based engine is intentionally transparent and good for demos; Claude gives materially better accuracy on messy, heavily code-mixed speech.
- SQLite + a single org keeps setup zero-friction; the schema is multi-org ready.
- To reset the demo data: stop the server, delete `server/data/`, and restart.
