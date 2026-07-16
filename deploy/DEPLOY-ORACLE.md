# Deploy the SmartTask backend on a FREE Oracle Cloud server

This hosts your backend 24/7 for free, so the company APK works over mobile data
with the PC turned off. SQLite handles 50+ users fine — no database change needed.

You do the clicking in Oracle's website (I can't log into your account). Each step
is copy-paste. Total time ~45–60 min the first time.

---

## Part A — Create the free server (in your browser)

1. Go to **https://www.oracle.com/cloud/free/** → **Start for free**.
   - Sign up with your email. It asks for a **credit/debit card for identity
     verification only** — Always Free resources are **not charged**. Pick the
     **home region** closest to your office (e.g. *India South (Hyderabad)* or
     *India West (Mumbai)*). The home region can't be changed later.

2. In the Oracle Cloud console: **menu ☰ → Compute → Instances → Create instance**.
   - **Name:** `smarttask`
   - **Image & shape → Edit:**
     - Image: **Canonical Ubuntu 22.04** (or 24.04)
     - Shape: **Ampere (Arm)** → `VM.Standard.A1.Flex`, set **2 OCPU / 12 GB**
       (well within Always Free; falls back to a free AMD Micro shape if Arm
       capacity is unavailable in your region — that's fine too).
   - **Networking:** keep the default new VCN; ensure **"Assign a public IPv4
     address" = Yes**.
   - **Add SSH keys:** choose **Generate a key pair for me** → **Download the
     private key** (save it as `smarttask.key`). You'll need this to connect.
   - Click **Create**. Wait until state = **Running**, then copy the
     **Public IP address** (e.g. `140.238.x.x`).

3. **Open the network port** (so the internet can reach your server):
   - On the instance page → **Primary VNIC → Subnet** link → **Security Lists**
     → click the default security list → **Add Ingress Rules**:
     - Source CIDR: `0.0.0.0/0`
     - IP Protocol: **TCP**
     - Destination Port Range: **4000**
     - **Add**. (Later, after HTTPS, you'll add **443** the same way.)

---

## Part B — Connect to the server

On **Windows PowerShell** (from the folder where you saved `smarttask.key`):

```powershell
# lock the key down (one time)
icacls smarttask.key /inheritance:r /grant:r "$($env:USERNAME):(R)"
# connect (default user on Ubuntu Oracle images is "ubuntu")
ssh -i smarttask.key ubuntu@<SERVER_PUBLIC_IP>
```

Type `yes` the first time. You're now on the server.

---

## Part C — Install the app (one command)

On the server, run:

```bash
curl -fsSL https://raw.githubusercontent.com/Munidhar05/Task-Manager1/reddy-changes/deploy/oracle-setup.sh | bash
```

This installs Node, pulls your code, builds it, opens the firewall, and installs a
service that keeps it running 24/7. When it finishes it prints the last 2 steps:

```bash
# 1) create the secrets file — paste the .env contents Claude gives you, save with Ctrl+O, Enter, Ctrl+X
nano /opt/smarttask/server/.env

# 2) start the server
sudo systemctl restart smarttask

# 3) confirm it's healthy
curl http://localhost:4000/api/health
```

You should see `{"ok":true,...}`. Then test from your phone's browser:
`http://<SERVER_PUBLIC_IP>:4000/api/health` — same JSON = the world can reach it. 🎉

---

## Part D — Point the APK at the server & rebuild

Back on your PC, Claude updates `client/.env.production`:

```
VITE_API_BASE=http://<SERVER_PUBLIC_IP>:4000
```

then rebuilds the APK:

```
cd client && npm run build && npx cap sync android
cd android && JAVA_HOME="C:\Program Files\Android\Android Studio\jbr" ./gradlew.bat assembleDebug
```

Share `client/android/app/build/outputs/apk/debug/app-debug.apk` with the team.

---

## Part E — (Strongly recommended) Add free HTTPS

Plain `http://` sends passwords unencrypted. For real company use, put a free
HTTPS layer in front using your **befach.com** domain:

1. Add a DNS **A record**: `tasks.befach.com → <SERVER_PUBLIC_IP>`.
2. Open port **443** in the Oracle Security List (same as Part A step 3).
3. On the server, install Caddy (auto-HTTPS via Let's Encrypt):
   ```bash
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install -y caddy
   echo 'tasks.befach.com {
     reverse_proxy localhost:4000
   }' | sudo tee /etc/caddy/Caddyfile
   sudo systemctl restart caddy
   ```
4. Then set `VITE_API_BASE=https://tasks.befach.com` and rebuild the APK (Part D).

---

## Updating later (after code changes)

```bash
ssh -i smarttask.key ubuntu@<SERVER_PUBLIC_IP>
cd /opt/smarttask && git pull && cd server && npm install --omit=dev
sudo systemctl restart smarttask
```

## Handy commands
- Logs:        `sudo journalctl -u smarttask -f`
- Restart:     `sudo systemctl restart smarttask`
- Status:      `sudo systemctl status smarttask`
- Backup data: the whole database is one file → `/opt/smarttask/server/data/smarttask.db`
