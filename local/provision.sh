#!/usr/bin/env bash
# Turn a fresh Ubuntu 24.04 machine (an LXD container, a VM, or a Docker image build) into the
# computer the bots work on. Run it ON that machine, as root. Safe to run again.
#
# What it sets up:
#   - one X display per bot (TigerVNC's Xvnc: X server and VNC server in one, so the live view has
#     no screen-scraping step in between) with a small window manager, as systemd units corbot-screen@N
#   - Google Chrome, a terminal, a file manager and what server/box/* needs to dress a screen
#   - Node 22 under /opt/corbot/node, and Hermes Agent
# The app itself is put in place by local/install-app.sh.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
SCREENS="${CORBOT_SCREENS:-4}"                 # how many bots can have a screen
SIZE="${CORBOT_SCREEN_SIZE:-1440x900}"
NODE_V=v22.21.1
mkdir -p /opt/corbot/bin /opt/corbot/node /var/log/corbot /root/corbot/files /root/corbot/profiles

echo "== packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git xz-utils openssl python3 python3-yaml \
  tigervnc-standalone-server tigervnc-common openbox dbus dbus-x11 \
  xfce4-terminal thunar \
  python3-gi python3-gi-cairo gir1.2-gtk-3.0 librsvg2-common \
  wmctrl xdotool x11-utils x11-xserver-utils imagemagick \
  fonts-inter fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
  papirus-icon-theme arc-theme adwaita-icon-theme >/dev/null

echo "== chrome"
if [ ! -x /opt/google/chrome/google-chrome ]; then
  curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -qq /tmp/chrome.deb >/dev/null
  rm -f /tmp/chrome.deb
fi

echo "== node"
if ! /opt/corbot/node/bin/node -v 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-x64.tar.xz" | tar -xJ -C /opt/corbot/node --strip-components=1
fi

echo "== screens"
# One screen: Xvnc on display :N, VNC on 127.0.0.1:(5900+N), and a window manager on it.
cat > /opt/corbot/bin/corbot-display <<'EOF'
#!/bin/bash
n="$1"; size="${CORBOT_SCREEN_SIZE:-1440x900}"
rm -f "/tmp/.X$n-lock" "/tmp/.X11-unix/X$n"
# No password: the VNC port only listens on this machine, and the app's relay is what people reach.
Xtigervnc ":$n" -geometry "$size" -depth 24 -dpi 96 -rfbport "$((5900 + n))" -localhost=1 \
  -SecurityTypes None -AlwaysShared=1 -AcceptSetDesktopSize=0 -FrameRate=60 -nolisten tcp \
  -desktop "corbot :$n" &
x=$!
for _ in $(seq 1 100); do [ -S "/tmp/.X11-unix/X$n" ] && break; sleep 0.1; done
DISPLAY=":$n" openbox --config-file /opt/corbot/openbox.xml &
wait -n "$x"
EOF
chmod +x /opt/corbot/bin/corbot-display

# Windows open maximized-friendly and without a desktop menu getting in a bot's way.
cat > /opt/corbot/openbox.xml <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus>
  <placement><policy>Smart</policy><center>yes</center></placement>
  <theme>
    <name>Arc</name><titleLayout>NLIMC</titleLayout><keepBorder>yes</keepBorder>
    <font place="ActiveWindow"><name>Inter</name><size>10</size><weight>bold</weight></font>
    <font place="InactiveWindow"><name>Inter</name><size>10</size></font>
  </theme>
  <desktops><number>1</number><popupTime>0</popupTime></desktops>
  <mouse>
    <context name="Titlebar">
      <mousebind button="Left" action="Drag"><action name="Move"/></mousebind>
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Left" action="DoubleClick"><action name="ToggleMaximize"/></mousebind>
    </context>
    <context name="Client">
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Middle" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Right" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
    </context>
    <context name="Close"><mousebind button="Left" action="Click"><action name="Close"/></mousebind></context>
    <context name="Maximize"><mousebind button="Left" action="Click"><action name="ToggleMaximize"/></mousebind></context>
    <context name="Iconify"><mousebind button="Left" action="Click"><action name="Iconify"/></mousebind></context>
    <context name="Top"><mousebind button="Left" action="Drag"><action name="Resize"><edge>top</edge></action></mousebind></context>
    <context name="Bottom"><mousebind button="Left" action="Drag"><action name="Resize"><edge>bottom</edge></action></mousebind></context>
    <context name="Left"><mousebind button="Left" action="Drag"><action name="Resize"><edge>left</edge></action></mousebind></context>
    <context name="Right"><mousebind button="Left" action="Drag"><action name="Resize"><edge>right</edge></action></mousebind></context>
    <context name="BLCorner"><mousebind button="Left" action="Drag"><action name="Resize"/></mousebind></context>
    <context name="BRCorner"><mousebind button="Left" action="Drag"><action name="Resize"/></mousebind></context>
  </mouse>
  <keyboard>
    <keybind key="A-F4"><action name="Close"/></keybind>
    <keybind key="A-Tab"><action name="NextWindow"/></keybind>
  </keyboard>
</openbox_config>
EOF

cat > /etc/systemd/system/corbot-screen@.service <<EOF
[Unit]
Description=Corbot screen :%i
After=network.target

[Service]
Environment=HOME=/root CORBOT_SCREEN_SIZE=$SIZE
ExecStart=/opt/corbot/bin/corbot-display %i
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
# The first screen is :99 (the main bot's); the others follow from :100.
systemctl enable -q --now corbot-screen@99
for i in $(seq 0 $((SCREENS - 2))); do systemctl enable -q --now "corbot-screen@$((100 + i))"; done

echo "== hermes"
export PATH="/root/.local/bin:$PATH"
if ! command -v hermes >/dev/null; then
  curl -fsSL -o /tmp/hermes-install.sh https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh
  bash /tmp/hermes-install.sh --skip-setup </dev/null
fi
hermes --version | head -1
echo "provisioned: $SCREENS screens at $SIZE"
