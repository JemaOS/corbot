#!/usr/bin/env bash
# The Linux side of local/corbot.ps1: Corbot on Windows runs in a WSL 2 distribution of its own, the
# same way it runs in an LXD container on Linux. corbot.ps1 copies this file into the distribution
# and calls it there, as root. Not meant to be run by hand.
#
#   init                 switch systemd on (takes effect when the distribution restarts)
#   wait                 wait until systemd answers
#   provision <source>   set the machine up (local/provision.sh)
#   deploy <source>      build the app from <source> and install or upgrade it (local/install-app.sh)
#   status | logs | keepalive
#
# <source> is the Windows checkout as WSL sees it (/mnt/c/...).
set -euo pipefail
export PATH="/opt/corbot/node/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export HOME=/root
BUILD=/root/corbot-src

# A copy of one script from the Windows checkout, without the carriage returns Git for Windows may add.
fetch() { tr -d '\r' < "$1" > "$2"; }

init() {
  cat > /etc/wsl.conf <<'EOF'
[boot]
systemd=true

[user]
default=root

[interop]
appendWindowsPath=false
EOF
}

wait_systemd() {
  for _ in $(seq 1 120); do
    if [ -d /run/systemd/system ] && systemctl show -p Version >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "systemd did not start in this WSL distribution. Update WSL (wsl --update) and try again." >&2
  exit 1
}

# WSL puts its own /tmp/.X11-unix in place (for Windows-side GUI apps), and it can be read-only.
# The bots' displays need to create their sockets there, so each boot we take that mount away and
# leave a plain directory. Only this distribution is affected.
x11_dir() {
  mkdir -p /opt/corbot/bin /etc/systemd/system/corbot-screen@.service.d
  cat > /opt/corbot/bin/corbot-x11-dir <<'EOF'
#!/bin/bash
while mountpoint -q /tmp/.X11-unix; do umount -l /tmp/.X11-unix || break; done
[ -L /tmp/.X11-unix ] && rm -f /tmp/.X11-unix
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
EOF
  chmod +x /opt/corbot/bin/corbot-x11-dir
  cat > /etc/systemd/system/corbot-x11.service <<'EOF'
[Unit]
Description=Corbot: a writable /tmp/.X11-unix
After=systemd-tmpfiles-setup.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/corbot/bin/corbot-x11-dir

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/corbot-screen@.service.d/10-wsl.conf <<'EOF'
[Unit]
Requires=corbot-x11.service
After=corbot-x11.service
EOF
  systemctl daemon-reload
  systemctl enable -q --now corbot-x11
}

provision() {
  local src="${1:?source directory}"
  # A fresh Ubuntu image finishes its own first-boot setup; wait so it does not hold the package lock.
  if command -v cloud-init >/dev/null; then cloud-init status --wait >/dev/null 2>&1 || true; fi
  x11_dir
  fetch "$src/local/provision.sh" /root/provision.sh
  bash /root/provision.sh
}

deploy() {
  local src="${1:?source directory}"
  [ -f "$src/package.json" ] || { echo "no Corbot checkout at $src" >&2; exit 1; }
  echo "== copying the source"
  rm -rf "$BUILD"; mkdir -p "$BUILD"
  tar -C "$src" --exclude=node_modules --exclude=.git --exclude=dist --exclude=.env \
    --exclude=./data --exclude=./tests -cf - . | tar -C "$BUILD" --no-same-owner -xf -
  cd "$BUILD"
  find . -type f \( -name '*.sh' -o -name '*.py' -o -path ./local/corbot \) -exec sed -i 's/\r$//' {} +
  echo "== building (the first time takes a few minutes)"
  # --ignore-scripts: the SQLite package ships ready-made binaries; without this npm tries to compile it,
  # and a fresh distribution has no compiler.
  npm ci --ignore-scripts --no-audit --no-fund >/var/log/corbot/build.log 2>&1 || { tail -30 /var/log/corbot/build.log; exit 1; }
  bash scripts/pack.sh /root/corbot-app.tgz >>/var/log/corbot/build.log 2>&1 || { tail -30 /var/log/corbot/build.log; exit 1; }
  echo "== installing"
  bash local/install-app.sh /root/corbot-app.tgz
}

status() {
  local screens="${SCREENS:-4}" port="${PORT:-8787}" units="corbot-app corbot-hermes corbot-screen@99"
  for i in $(seq 0 $((screens - 2))); do units="$units corbot-screen@$((100 + i))"; done
  for u in $units; do printf '%-20s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || true)"; done
  curl -fsS -m 3 "http://127.0.0.1:$port/api/health" && echo || echo "the app does not answer on port $port"
}

case "${1:-}" in
  init) init ;;
  wait) wait_systemd ;;
  provision) provision "${2:-}" ;;
  deploy) deploy "${2:-}" ;;
  status) status ;;
  logs) exec tail -n 50 -F /var/log/corbot/app.log /var/log/corbot/hermes.log ;;
  # WSL stops a distribution nobody is attached to; corbot.ps1 keeps this one process attached.
  keepalive) exec -a corbot-keepalive sleep infinity ;;
  *) echo "usage: wsl.sh init|wait|provision|deploy|status|logs|keepalive" >&2; exit 2 ;;
esac
