#!/usr/bin/env bash
# Install or upgrade the app on a computer set up by local/provision.sh. Run it ON that computer, as
# root:   bash install-app.sh /path/to/corbot-app.tgz
#
# It puts the app in /opt/corbot/app, keeps its data in /opt/corbot/data, and runs two systemd services:
#   corbot-hermes   the main bot's Hermes gateway (its API on 127.0.0.1:8642, working on screen :99)
#   corbot-app      the app (HOST:PORT, by default 127.0.0.1:8787)
# Settings are written once; later runs keep them (the session secret, the agents' keys).
# Optional, first install only: PUBLIC_URL (default http://localhost:8787), ALLOWED_EMAILS,
# XAI_API_KEY (voice, x_search), COMPOSIO_API_KEY (connected apps, Google sign-in), MAX_BOTS.
set -euo pipefail
tgz="${1:?usage: install-app.sh <corbot-app.tgz>}"
APP=/opt/corbot/app; DATA=/opt/corbot/data; NODE=/opt/corbot/node/bin; HERMES_HOME_DIR=/root/.hermes
PORT="${PORT:-8787}"; PUBLIC_URL="${PUBLIC_URL:-http://localhost:$PORT}"
export PATH="$NODE:/root/.local/bin:$PATH"
umask 077
mkdir -p "$APP" "$DATA" /var/log/corbot
HERMES="$(command -v hermes)"

# 1. The app. Data lives outside it, so an upgrade only replaces code.
rm -rf "$APP/server/dist" "$APP/web/dist" "$APP/server/box"
tar -xzf "$tgz" -C "$APP"
# --ignore-scripts: the SQLite package ships ready-made binaries; without this npm tries to compile it.
(cd "$APP" && npm ci --omit=dev -w server --ignore-scripts --no-audit --no-fund >/var/log/corbot/npm.log 2>&1) || { tail -20 /var/log/corbot/npm.log; exit 1; }

# 2. The main bot's agent: its API server, and the screen and browser it works on.
envfile="$HERMES_HOME_DIR/.env"; touch "$envfile"; chmod 600 "$envfile"
setenv() { if grep -q "^$1=" "$envfile"; then sed -i "s|^$1=.*|$1=$2|" "$envfile"; else echo "$1=$2" >> "$envfile"; fi; }
getenv() { { grep -E "^$1=" "$2" 2>/dev/null || true; } | tail -1 | cut -d= -f2-; }
hkey="$(getenv API_SERVER_KEY "$envfile")"; [ -n "$hkey" ] || hkey="$(openssl rand -hex 24)"
setenv API_SERVER_ENABLED true
setenv API_SERVER_KEY "$hkey"
setenv API_SERVER_HOST 127.0.0.1
setenv API_SERVER_PORT 8642
setenv BROWSER_CDP_URL http://127.0.0.1:9299
# Optional: a model key and the model to run on, so the bots answer right after the install.
[ -z "${KILOCODE_API_KEY:-}" ] || setenv KILOCODE_API_KEY "$KILOCODE_API_KEY"

# 3. The app's settings, written once.
if [ ! -f "$APP/.env" ]; then
  {
    echo "HOST=${HOST:-127.0.0.1}"
    echo "PORT=$PORT"
    echo "APP_URL=$PUBLIC_URL"
    echo "SERVER_URL=$PUBLIC_URL"
    echo "SESSION_SECRET=$(openssl rand -hex 32)"
    echo "DEV_LOGIN=${DEV_LOGIN:-1}"
    echo "ALLOWED_EMAILS=${ALLOWED_EMAILS:-}"
    echo "DB_PATH=$DATA/corbot.db"
    echo "ENGINES_DIR=$DATA/engines"
    echo "HERMES_BIN=$HERMES"
    echo "HERMES_URL=http://127.0.0.1:8642"
    echo "HERMES_HOME_PRIMARY=$HERMES_HOME_DIR"
    echo "MAX_BOTS=${MAX_BOTS:-4}"
    echo "XAI_API_KEY=${XAI_API_KEY:-}"
    echo "COMPOSIO_API_KEY=${COMPOSIO_API_KEY:-}"
    [ -z "${PRIMARY_BOT_NAME:-}" ] || echo "PRIMARY_BOT_NAME=$PRIMARY_BOT_NAME"
    [ -z "${PRIMARY_BOT_LABEL:-}" ] || echo "PRIMARY_BOT_LABEL=$PRIMARY_BOT_LABEL"
  } > "$APP/.env"
  chmod 600 "$APP/.env"
fi
port="$(getenv PORT "$APP/.env")"; secret="$(getenv SESSION_SECRET "$APP/.env")"

# 4. Give the main agent the app's tools, its screen for computer use, and its browser.
tok="$(printf 'mcp:primary' | openssl dgst -sha256 -hmac "$secret" -r | cut -d' ' -f1)"
cat > "$DATA/hermes-mcp-corbot.yaml" <<EOF
  corbot:
    url: http://127.0.0.1:$port/mcp/primary
    headers:
      Authorization: Bearer $tok
    timeout: 1800
    connect_timeout: 30
EOF
[ -f "$HERMES_HOME_DIR/config.yaml" ] || echo '{}' > "$HERMES_HOME_DIR/config.yaml"
python3 "$APP/scripts/add-corbot-to-hermes.py" --config "$HERMES_HOME_DIR/config.yaml" --entry "$DATA/hermes-mcp-corbot.yaml" >/dev/null
python3 - "$HERMES_HOME_DIR/config.yaml" <<'EOF'
import sys, yaml
path = sys.argv[1]
cfg = yaml.safe_load(open(path, encoding='utf-8')) or {}
toolsets = cfg.setdefault('platform_toolsets', {})
api = list(toolsets.get('api_server') or ['hermes-api-server'])
if 'computer_use' not in api:
    api.append('computer_use')
toolsets['api_server'] = api
cfg.setdefault('browser', {})['cdp_url'] = 'http://127.0.0.1:9299'
cfg.setdefault('terminal', {}).setdefault('cwd', '/root/corbot/files')
import os
if os.environ.get('CORBOT_MODEL') and os.environ.get('CORBOT_PROVIDER') and not cfg.get('model'):
    cfg['model'] = {'default': os.environ['CORBOT_MODEL'], 'provider': os.environ['CORBOT_PROVIDER']}
yaml.safe_dump(cfg, open(path, 'w', encoding='utf-8'), sort_keys=False, allow_unicode=True)
EOF

# 4b. Keep Hermes from mangling screenshots in conversations (its secret redactor used to cut runs
# of base64 inside images, and providers then rejected the request). Re-applied on every deploy and
# to every bot's own copy of Hermes.
find /root/.hermes /opt/corbot/data/engines -path '*/agent/redact.py' -print 2>/dev/null | while read -r redact; do
  python3 "$APP/local/patch-hermes.py" "$redact" || true
done || true   # on a first install the engines folder is not there yet, and find says so with an error

# 5. The two services.
cat > /etc/systemd/system/corbot-hermes.service <<EOF
[Unit]
Description=Corbot: the main bot's Hermes gateway
After=network-online.target corbot-screen@99.service
Wants=corbot-screen@99.service

[Service]
Environment=HOME=/root DISPLAY=:99 HERMES_HOME=$HERMES_HOME_DIR LANG=C.UTF-8
Environment=PATH=/root/.local/bin:$NODE:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WorkingDirectory=/root
ExecStart=$HERMES gateway run --replace --external-supervisor
Restart=always
RestartSec=2
StandardOutput=append:/var/log/corbot/hermes.log
StandardError=append:/var/log/corbot/hermes.log

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/corbot-app.service <<EOF
[Unit]
Description=Corbot: the app
After=network-online.target corbot-screen@99.service corbot-hermes.service
Wants=corbot-hermes.service

[Service]
Environment=HOME=/root LANG=C.UTF-8
Environment=PATH=$NODE:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WorkingDirectory=$APP
ExecStart=$NODE/node --env-file=$APP/.env $APP/server/dist/index.js
# The agents the app starts for the other bots keep running across an app restart.
KillMode=process
Restart=always
RestartSec=2
StandardOutput=append:/var/log/corbot/app.log
StandardError=append:/var/log/corbot/app.log

[Install]
WantedBy=multi-user.target
EOF
chmod 644 /etc/systemd/system/corbot-hermes.service /etc/systemd/system/corbot-app.service
systemctl daemon-reload
systemctl enable -q corbot-hermes corbot-app
systemctl restart corbot-hermes
systemctl restart corbot-app
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "http://127.0.0.1:$port/api/health" && echo
echo "installed: app on port $port, main agent on 8642"
