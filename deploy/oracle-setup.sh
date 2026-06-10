#!/usr/bin/env bash
# ============================================================================
# SmartTask — one-shot backend setup for an Oracle Cloud "Always Free" Ubuntu VM
# ----------------------------------------------------------------------------
# Run this ONCE on a fresh Ubuntu 22.04/24.04 server (ARM Ampere or x86).
#   curl -fsSL https://raw.githubusercontent.com/Munidhar05/Task-Manager1/<branch>/deploy/oracle-setup.sh | bash
# ...or copy it up and run:  bash oracle-setup.sh
#
# It is idempotent — safe to re-run. It:
#   1. installs Node 20 + build tools (needed to compile better-sqlite3)
#   2. clones/updates the repo into /opt/smarttask
#   3. installs server deps
#   4. opens the firewall port (Oracle's Ubuntu images block everything but SSH)
#   5. installs a systemd service so the server runs 24/7 and survives reboots
#
# It does NOT write your secrets. After it runs once, create the .env file
# (the script prints the exact command) and then: sudo systemctl restart smarttask
# ============================================================================
set -euo pipefail

REPO_URL="https://github.com/Munidhar05/Task-Manager1.git"
BRANCH="${SMARTTASK_BRANCH:-reddy-changes}"   # override: SMARTTASK_BRANCH=main bash oracle-setup.sh
APP_DIR="/opt/smarttask"
PORT="${SMARTTASK_PORT:-4000}"
RUN_USER="$(whoami)"

echo "==> SmartTask backend setup (branch: $BRANCH, port: $PORT, user: $RUN_USER)"

# --- 1. System packages + Node 20 ------------------------------------------
echo "==> Installing system packages + Node 20 ..."
sudo apt-get update -y
sudo apt-get install -y curl git build-essential python3
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "    node $(node -v) / npm $(npm -v)"

# --- 2. Get the code --------------------------------------------------------
echo "==> Fetching code into $APP_DIR ..."
sudo mkdir -p "$APP_DIR"
sudo chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

# --- 3. Install server dependencies (compiles better-sqlite3) ---------------
echo "==> Installing server dependencies ..."
cd "$APP_DIR/server"
npm install --omit=dev
mkdir -p data

# --- 4. Open the firewall ---------------------------------------------------
# Oracle's Ubuntu images ship an iptables REJECT rule that blocks all inbound
# except SSH. Insert an ACCEPT for our port BEFORE that reject, and persist it.
echo "==> Opening firewall port $PORT ..."
if ! sudo iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
  sudo iptables -I INPUT 6 -p tcp --dport "$PORT" -j ACCEPT || sudo iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT
fi
sudo apt-get install -y netfilter-persistent iptables-persistent >/dev/null 2>&1 || true
sudo netfilter-persistent save >/dev/null 2>&1 || true
echo "    (you must ALSO add an Ingress rule for TCP $PORT in the Oracle console — see the guide)"

# --- 5. systemd service: run 24/7, restart on crash, start on boot ----------
echo "==> Installing systemd service 'smarttask' ..."
sudo tee /etc/systemd/system/smarttask.service >/dev/null <<UNIT
[Unit]
Description=SmartTask backend (Express + SQLite)
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR/server
ExecStart=$(command -v node) src/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PORT=$PORT
EnvironmentFile=$APP_DIR/server/.env

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable smarttask >/dev/null 2>&1 || true

echo ""
echo "============================================================"
echo " Setup complete. ONE thing left: create your .env, then start."
echo "------------------------------------------------------------"
echo " 1) Create the secrets file (paste the contents, then Ctrl+D):"
echo "      nano $APP_DIR/server/.env"
echo " 2) Start it:"
echo "      sudo systemctl restart smarttask"
echo " 3) Check it's healthy:"
echo "      curl http://localhost:$PORT/api/health"
echo "      sudo systemctl status smarttask --no-pager"
echo "------------------------------------------------------------"
echo " Public test (from your phone/PC):  http://<SERVER_PUBLIC_IP>:$PORT/api/health"
echo "============================================================"
