#!/usr/bin/env bash
# Install Corbot on Linux in one step, on a machine that has nothing yet:
#
#   ./install.sh
#
# or, without downloading anything first:
#
#   curl -fsSL https://raw.githubusercontent.com/JemaOS/corbot/main/install.sh | bash
#
# It installs what is missing (LXD, curl), creates the container the bots work in, builds the app
# inside it (Node.js is not needed on this machine), adds a Corbot entry to the applications menu and
# opens the app. It asks for your password only when something has to be installed. Safe to run again:
# it then upgrades the app and keeps your bots and their data.
#
# Needs a 64-bit Intel/AMD PC, about 12 GB of free disk and an internet connection. Installing LXD
# was written for Ubuntu and Debian (and what is built on them); Fedora and Arch are covered on a
# best-effort basis.
#
# Settings (environment): the ones of local/corbot (CORBOT_NAME, CORBOT_PORT, CORBOT_SCREENS,
# XAI_API_KEY, COMPOSIO_API_KEY, ...), plus CORBOT_DIR (where to put the source when this script is
# run on its own, default ~/corbot) and CORBOT_SOURCE (the source archive to download).
set -euo pipefail

SOURCE="${CORBOT_SOURCE:-https://github.com/JemaOS/corbot/archive/refs/heads/main.tar.gz}"
NAME="${CORBOT_NAME:-corbot}"; PORT="${CORBOT_PORT:-8787}"
export PATH="$PATH:/snap/bin"

step() { printf '\n== %s\n' "$*"; }
die() { printf '\ncorbot: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

# ---- can this machine run it?
[ "$(uname -s)" = Linux ] || die "this installer is for Linux. On Windows, double-click install.cmd."
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "Corbot needs a 64-bit Intel/AMD PC (this one is $(uname -m)): Chrome for Linux is not available for other processors." ;;
esac
if grep -qi microsoft /proc/version 2>/dev/null; then
  die "this is WSL. Install from Windows instead: double-click install.cmd in this folder."
fi
[ "$(id -u)" = 0 ] || have sudo || die "sudo is needed to install LXD. Run this as root, or install sudo first."

install_packages() {
  if have apt-get; then as_root apt-get update -qq && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif have dnf; then as_root dnf install -y -q "$@"
  elif have pacman; then as_root pacman -Sy --noconfirm --needed "$@"
  elif have zypper; then as_root zypper --non-interactive install "$@"
  else die "could not install $* on this system. Install it yourself, then run this again."
  fi
}

have curl || { step "installing curl"; install_packages curl ca-certificates; }
have tar || install_packages tar

# ---- the source: this folder, or a fresh download when the script runs on its own
here=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi
if [ -z "$here" ] || [ ! -f "$here/local/corbot" ]; then
  dir="${CORBOT_DIR:-$HOME/corbot}"
  if [ ! -f "$dir/local/corbot" ]; then
    step "downloading Corbot to $dir"
    mkdir -p "$dir"
    curl -fsSL "$SOURCE" | tar -xz -C "$dir" --strip-components=1
  fi
  [ -f "$dir/install.sh" ] || die "$dir does not hold a Corbot that has this installer. Move it away and run this again."
  # Piped from curl, this script is on stdin: give the real one the terminal back.
  if (exec </dev/tty) 2>/dev/null; then exec bash "$dir/install.sh" "$@" </dev/tty; fi
  exec bash "$dir/install.sh" "$@" </dev/null
fi
cd "$here"

# ---- room, and a free port
free_gb=$(( $(df -Pk "$here" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
[ "$free_gb" -ge 12 ] || echo "note: only ${free_gb} GB free here; a full install takes about 10 GB."
if ! curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"ok"'; then
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    die "port $PORT is already used by another program. Choose another one:  CORBOT_PORT=8788 ./install.sh"
  fi
fi

# ---- LXD: installed, set up, and usable by this account
lxd_ready() { have lxc && lxc storage list -f csv 2>/dev/null | grep -q .; }
lxd_ready_in_group() { have lxc && have sg && sg lxd -c 'lxc storage list -f csv' 2>/dev/null | grep -q .; }

if ! lxd_ready && ! lxd_ready_in_group; then
  if ! have lxc; then
    step "installing LXD (your password may be asked)"
    if have snap; then as_root snap install lxd
    elif have apt-get; then
      install_packages snapd
      as_root snap wait system seed.loaded 2>/dev/null || true
      as_root snap install lxd
    elif have dnf; then
      install_packages snapd
      [ -e /snap ] || as_root ln -s /var/lib/snapd/snap /snap
      as_root systemctl enable --now snapd.socket
      as_root snap wait system seed.loaded 2>/dev/null || true
      as_root snap install lxd
    elif have pacman; then
      install_packages lxd
      as_root systemctl enable --now lxd.socket
    else
      die "LXD could not be installed automatically here. Install it (https://canonical.com/lxd/install), then run this again."
    fi
    hash -r
    have lxc || die "LXD was installed but the lxc command is not on the PATH. Open a new terminal and run this again."
  fi
  step "setting LXD up"
  LXC="$(command -v lxc)"; LXD="$(command -v lxd || true)"
  [ -z "$LXD" ] || as_root "$LXD" waitready --timeout=120 2>/dev/null || true
  if ! as_root "$LXC" storage list -f csv 2>/dev/null | grep -q .; then
    [ -n "$LXD" ] || die "LXD is installed but not initialised. Run:  sudo lxd init --auto"
    as_root "$LXD" init --auto
  fi
  if [ "$(id -u)" != 0 ]; then
    getent group lxd >/dev/null || as_root groupadd --system lxd
    id -nG "$(id -un)" | tr ' ' '\n' | grep -qx lxd || as_root usermod -aG lxd "$(id -un)"
  fi
  lxd_ready || lxd_ready_in_group || die "LXD is installed but does not answer for this account. Log out and in again, then run this again."
fi

# ---- the container and the app
step "setting Corbot up (10 to 20 minutes the first time: it downloads Ubuntu, Chrome and Hermes)"
bash local/corbot up

# ---- a way back in: an entry in the applications menu
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
vars=""
[ "$NAME" = corbot ] || vars="$vars CORBOT_NAME=$NAME"
[ "$PORT" = 8787 ] || vars="$vars CORBOT_PORT=$PORT"
if mkdir -p "$apps" 2>/dev/null; then
  cat > "$apps/corbot.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Corbot
Comment=Your team of AI agents, each with its own screen
Exec=env$vars bash "$here/local/corbot" open
Icon=$here/assets/icon.svg
Terminal=false
Categories=Network;Utility;
EOF
fi

bash local/corbot open || true
cat <<EOF

Corbot is installed: http://localhost:$PORT
  - Sign in with your email address.
  - The bots need an AI model before they can answer. In the app, open the main bot's details
    panel, then Engine, and paste an API key or sign in to a subscription.
    (From a terminal: $here/local/corbot model)
  - To come back later: "Corbot" in your applications menu, or $here/local/corbot open
  - To remove everything: $here/local/corbot destroy
EOF
