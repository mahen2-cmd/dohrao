#!/usr/bin/env bash
# Pull the server's backups down to this computer every day, with a systemd timer for your own
# user (no root needed). Run it once on your own computer:
#   bash deploy/install-pull-backups.sh root@203.0.113.10 [folder]
# A day missed while the computer was off is caught up when it is next on. To see how it went:
#   systemctl --user status recall-backup        journalctl --user -u recall-backup
# To stop it: systemctl --user disable --now recall-backup.timer
set -euo pipefail

target="${1:-}"
dest="${2:-$HOME/recall-backups}"
if [[ -z "$target" ]]; then
  echo "Usage: bash deploy/install-pull-backups.sh USER@HOST [folder]" >&2
  exit 1
fi
script="$(cd "$(dirname "$0")" && pwd)/pull-backups.sh"
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$units"

# The timer runs without your shell, so give it the PATH that finds node, rsync and ssh now.
cat > "$units/recall-backup.service" <<EOF
[Unit]
Description=Pull Recall's backups down from $target
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
Environment=PATH=$PATH
ExecStart=/usr/bin/env bash "$script" "$target" "$dest"
EOF

cat > "$units/recall-backup.timer" <<'EOF'
[Unit]
Description=Pull Recall's backups down every day

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=30min

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now recall-backup.timer
echo "Pulling now, to check it works…"
systemctl --user start recall-backup.service
systemctl --user --no-pager status recall-backup.service | tail -3
systemctl --user --no-pager list-timers recall-backup.timer
