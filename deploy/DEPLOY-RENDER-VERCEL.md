# Deploy SmartTask — Backend on Render, Frontend on Vercel

This hosts the backend 24/7 on **Render** (paid Starter, ~$7/mo, with a persistent
disk so your data is never lost) and the web frontend on **Vercel** (free). The
Android APK and the Vercel web app both talk to the same Render backend.

You do the clicking in the Render/Vercel websites (I can't log into your accounts).
Every value you need is in this file. First-time setup ~20–30 min.

> Your code is already configured: `render.yaml` (Render Blueprint) and
> `client/vercel.json` are committed, the server reads `process.env.PORT`, CORS is
> open, and the client converts `https → wss` automatically for WebSockets.

---

## Part A — Push the repo to GitHub (if not already)

Render and Vercel both deploy from GitHub. Your repo is already on
`github.com/Munidhar05/Task-Manager1` (branch `reddy-changes`). Make sure the
latest commit (with `render.yaml` + `vercel.json`) is pushed:

```powershell
git push origin reddy-changes
```

---

## Part B — Backend on Render

1. Go to **https://dashboard.render.com** → sign up / log in (use "Sign in with
   GitHub" so it can see your repo).

2. **New + → Blueprint**. Pick the **Task-Manager1** repo and branch
   **`reddy-changes`**. Render finds `render.yaml` and shows a service named
   **smarttask-api** (Starter plan, 1 GB disk). Click **Apply**.
   - It will ask for a **payment method** because Starter is paid (~$7/mo). The
     disk is what keeps your database safe across restarts.

3. **Add your secret env vars.** Open the **smarttask-api** service →
   **Environment**. `JWT_SECRET` is auto-generated; the rest are blank. Paste the
   values from your local `server/.env` for the ones you use (AI + email):

   | Key | Where it comes from |
   |-----|---------------------|
   | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | your AI provider |
   | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (+ `*_MODEL`) | optional alt AI |
   | `TRANSCRIPTION_PROVIDER`, `OPENAI_TRANSCRIBE_MODEL`, `SARVAM_API_KEY`, `SARVAM_LANGUAGE`, `GROQ_API_KEY` | live transcription |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | email digests |
   | `CLIQ_WEBHOOK_URL`, `DIGEST_HOUR` | optional |

   Click **Save Changes** → Render redeploys.

4. Wait for **Live**, then copy the service URL at the top, e.g.
   `https://smarttask-api.onrender.com`. Confirm it works — open in a browser:
   ```
   https://smarttask-api.onrender.com/api/health
   ```
   You should see `{"ok":true,...}`. 🎉

   > If the URL is **not** exactly `smarttask-api.onrender.com` (name was taken),
   > note the real one — you'll use it in Parts C and D.

5. **First login** uses the seeded accounts (created automatically on a fresh DB):
   `priya@demo.io` (manager/admin) / `password123`. Change this after logging in.

---

## Part C — Frontend on Vercel

1. Go to **https://vercel.com** → log in with GitHub → **Add New… → Project** →
   import **Task-Manager1**.

2. In the import screen:
   - **Root Directory:** click **Edit** → choose **`client`**.
   - Framework Preset: **Vite** (auto-detected). Build/output are read from
     `client/vercel.json` — leave defaults.
   - **Environment Variables:** add
     - Name: `VITE_API_BASE`
     - Value: `https://smarttask-api.onrender.com`  *(use your real Render URL
       from Part B step 4)*

3. **Deploy.** When done you get a URL like `https://task-manager1.vercel.app`.
   Open it on your phone's browser → log in. To make it feel like an app:
   Chrome **⋮ → Add to Home screen**. It opens fullscreen, like a native app.

---

## Part D — Rebuild the Android APK against Render

`client/.env.production` already points at `https://smarttask-api.onrender.com`.
**If your real Render URL differs**, edit that file first. Then rebuild:

```powershell
cd client
npm run build
npx cap sync android
cd android
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
./gradlew.bat assembleDebug
```

Share `client/android/app/build/outputs/apk/debug/app-debug.apk` with the team.
Because Render uses `https://`, WebSockets (live transcription, chat) use secure
`wss://` automatically — no cleartext needed.

---

## (Optional) Move your existing local data to Render

A fresh Render disk starts empty (it re-seeds the demo accounts). To carry over
data you already created locally, upload your local DB file once:

1. Render service → **Shell** tab.
2. On your PC, your DB is at `server/data/smarttask.db`. Copy its contents up —
   easiest is to commit a one-off copy or use `scp` if you enable SSH. For a small
   team it's usually simpler to just start fresh on Render and re-enter data.

---

## Updating later (after code changes)

```powershell
git push origin reddy-changes
```
Render and Vercel both **auto-deploy** on push. The APK must be **rebuilt** (Part D)
since it ships a static copy of the frontend.

## Handy
- **Backend logs:** Render service → **Logs** tab.
- **Health check:** `https://<your-app>.onrender.com/api/health`
- **Backups:** Render dashboard → service → **Disks** → enable disk snapshots.
- **Cost:** Render Starter ~$7/mo. Vercel Hobby = free. Pausing the Render service
  stops billing but also stops the backend.
