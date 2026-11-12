#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server for Recall. Run it as root, on the server:
#   bash setup.sh recall.example.com
# Safe to run again: each step checks what is already there. It installs Node 22 and Caddy,
# creates the recall user and folders, installs the service and the Caddyfile, and turns on a
# firewall that lets in only SSH, HTTP and HTTPS. It does not start Recall: deploy.sh does that,
# once the code and data are on the server.
set -euo pipefail

domain="${1:-}"
if [[ -z "$domain" ]]; then
  echo "Usage: bash setup.sh DOMAIN   (for example: bash setup.sh recall.example.com)" >&2
  exit 1
fi
if [[ ! "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "\"$domain\" does not look like a domain name." >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "Run this as root (for example with sudo)." >&2
  exit 1
fi
here="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive

echo "== Packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg rsync ufw debian-keyring debian-archive-keyring apt-transport-https

echo "== Node 22"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
node --version

echo "== Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
    gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi
caddy version

echo "== The recall user and folders"
id recall >/dev/null 2>&1 || useradd --system --home-dir /var/lib/recall --shell /usr/sbin/nologin recall
install -d -o root -g root -m 755 /opt/recall
install -d -o recall -g recall -m 750 /var/lib/recall
# Google Translate's voice first. Left alone if it is already there, so later edits are kept.
if [[ ! -e /var/lib/recall/tts.json ]]; then
  echo '{"engine":"google"}' >/var/lib/recall/tts.json
  chown recall:recall /var/lib/recall/tts.json
fi

echo "== The service and the Caddyfile"
sed "s|RECALL_DOMAIN|$domain|g" "$here/recall.service" >/etc/systemd/system/recall.service
systemctl daemon-reload
systemctl enable recall
sed "s|{\$RECALL_DOMAIN}|$domain|g" "$here/Caddyfile" >/etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl reload-or-restart caddy

echo "== Firewall: SSH, HTTP and HTTPS only"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443
ufw --force enable
ufw status verbose

echo
echo "Done. Next: copy the data to /var/lib/recall, then run deploy.sh from your computer."
