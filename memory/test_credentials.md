# Test credentials — Befach (local dev DB only)

The app runs on REAL restored org data (bcrypt-hashed passwords, unknown).
For local UI testing, a known password was set on one existing MANAGER account
directly in the local SQLite DB (`server/data/smarttask.db`). This affects the
local dev DB only.

- Manager / org-admin (password login):
  - Email: user@befach.com
  - Password: Test@12345

To (re)set it again if the DB is reimported:
```
cd /app/server && node --input-type=module -e "
import { hashPassword } from './src/auth.js';
import Database from 'better-sqlite3';
const db = new Database('data/smarttask.db');
db.prepare(\"UPDATE users SET password_hash=?, email_verified=1 WHERE email='user@befach.com'\").run(hashPassword('Test@12345'));
console.log('done');
"
```

Roles: `admin` | `manager` | `employee` (the manager is the org admin — no separate admin account).

## Google Sign-In (OAuth)
- Web OAuth Client ID (configured): `356041968381-q6k8677a3ruml6itukl0vq60sc7s7i8q.apps.googleusercontent.com`
  - Set in `server/.env` (GOOGLE_CLIENT_ID) and `client/.env` (VITE_GOOGLE_CLIENT_ID).
  - Authorized JavaScript origins must include the preview URL and http://localhost:3000.
- Behavior: `POST /api/auth/google` verifies the Google ID token, then
  - existing email → logs in (issues app JWT), or
  - new email → AUTO-CREATES a personal (solo) workspace (org-of-one, role=manager,
    email_verified=1, google_id stamped, empty password_hash → password login
    disabled until a reset). Returns 201 with app JWT.
- Google-created accounts have NO password. To test password login for such a user,
  use the "Forgot password" flow to set one.
- E2E note: the actual OAuth popup cannot be automated (Google blocks bot logins);
  the token-exchange + account-creation path must be verified by a human clicking
  "Continue with Google". Endpoint wiring verified (401 on bogus token = verifying).
- Android (native): needs a SEPARATE Android OAuth client (package io.smarttask.app +
  signing SHA-1) added to the same Google project, with that Android client id listed
  in server `GOOGLE_CLIENT_IDS_EXTRA`, plus `npm i @codetrix-studio/capacitor-google-auth
  && npx cap sync android`. serverClientId is read from VITE_GOOGLE_CLIENT_ID.
