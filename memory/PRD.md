# Befach — AI Execution Platform (UI/UX Redesign)

## Problem statement
Redesign the UI/UX of the existing Befach app (aka SmartTask) into a premium, calm,
enterprise product that organizations immediately trust. Preserve ALL functionality,
navigation, workflow, backend, routes, permissions, features. Redesign visuals only.
Keep the orange accent as identity but stop using it "everywhere".

## Architecture (existing, unchanged)
- Frontend: `client/` — React 18 + TypeScript + Vite. Global design system in
  `src/styles.css` (token-based). Pages in `src/pages/`.
- Backend: `server/` — Node 20 + Express (ESM) + SQLite (better-sqlite3).
- Runtime in this env: Express on :8001 (via `/api` ingress), Vite on :3000.
  Supervisor programs: `befach-server`, `befach-client` (/etc/supervisor/conf.d/befach.conf).
  Default `backend`/`frontend` supervisor programs are unused (they FATAL — expected).

## Redesign delivered (2026-06 / this session)
- **Type system (own identity):** Clash Grotesk (display/headings/brand/KPI numbers) +
  Switzer (UI/body). Loaded via Fontshare in `index.html`; Indic (te/hi) falls back to Noto.
  Tabular numerals on all numeric surfaces.
- **Tokens (`:root`):** warm stone canvas (`--bg #f5f4f1`), warm neutral ramp, warm hairline
  borders, softer 3-step elevation, tighter "engineered" radii (cards 13px, modals 18px).
- **Color discipline:** primary button now solid (no gradient candy); team workload bars
  calm neutral by default, red only when overloaded (`Dashboard.tsx`); meeting engine badge
  is a subtle uppercase AI chip; pending-review is an amber chip.
- **Login:** deeper multi-stop brand gradient + subtle blueprint grid; display headline.
- **Meetings (hero):** `.meeting-card` hover lift + hover-reveal gradient accent rail,
  cleaner badges/hierarchy.
- Verified visually (logged in, real data) across Login, Dashboard, Meetings, Tasks, AI Assistant.

## Notes / gotchas
- Data is REAL restored org data (`server/restore/smarttask.db` → `server/data/smarttask.db`,
  one-time via `restore.js`), NOT the demo seed. Real user passwords are bcrypt-hashed/unknown.
- For local testing, a known password was set on one manager account (see test_credentials.md).
- Some legacy components still hardcode the old orange `#f2622e` (very close to new
  `--primary #ef5f2b`); harmless, could be unified later.

## Backlog / next
- P1: Unify remaining hardcoded `#f2622e` → `var(--primary)`.
- P1: Deeper polish of Admin (Control Center) & Platform pages, Chat, Task drawer.
- P2: Dashboard KPI cards — optionally calm the radial wash further.
- P2: Empty/loading/skeleton states audit across every page.

## Google Sign-In (2026-06 — added)
- Enabled the app's existing GIS + `google-auth-library` flow by configuring the Web
  OAuth Client ID (`GOOGLE_CLIENT_ID` / `VITE_GOOGLE_CLIENT_ID`).
- Changed `POST /api/auth/google` from login-only to ALSO auto-create a personal
  (solo) workspace for first-time Google users (org-of-one, manager role, verified,
  empty password_hash). Existing users still just log in. Returns 201 on create.
- Same endpoint serves web + Android; `capacitor.config.ts` GoogleAuth plugin enabled,
  serverClientId read from `VITE_GOOGLE_CLIENT_ID`.
- Verified: button renders with correct client id; endpoint returns 401 on bogus
  token (verifying) instead of 501. Real OAuth popup needs human click to fully test.
- Android still needs: separate Android OAuth client (SHA-1) → `GOOGLE_CLIENT_IDS_EXTRA`,
  plus install `@codetrix-studio/capacitor-google-auth` + `npx cap sync android`.
