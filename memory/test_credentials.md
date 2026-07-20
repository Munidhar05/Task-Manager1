# Test credentials — Befach (local dev DB only)

The app runs on REAL restored org data (bcrypt-hashed passwords, unknown).
For local UI testing, a known password was set on one existing MANAGER account
directly in the local SQLite DB (`server/data/smarttask.db`). This affects the
local dev DB only.

- Manager / org-admin:
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
