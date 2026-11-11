#!/usr/bin/env bash
# Copy the code to the server and restart Recall. Run it on your own computer, from anywhere
# in the project:
#   bash deploy/deploy.sh root@203.0.113.10
# Only /opt/recall on the server is touched; the data in /var/lib/recall is never copied or
# deleted.
set -euo pipefail

target="${1:-}"
if [[ -z "$target" ]]; then
  echo "Usage: bash deploy/deploy.sh USER@HOST   (for example: bash deploy/deploy.sh root@203.0.113.10)" >&2
  exit 1
fi
cd "$(dirname "$0")/.."

# --delete removes files deleted here from /opt/recall, and only there. Excluded paths are
# neither sent nor deleted, so .tts/ (voices installed on the server) is kept.
rsync -rlptz --delete --chmod=D755,F644 \
  --exclude='/data/' \
  --exclude='/decks/' \
  --exclude='.git' \
  --exclude='*.pdf' \
  --exclude='/.claude/' \
  --exclude='/.superpowers/' \
  --exclude='/.impeccable/' \
  --exclude='/.tts/' \
  --exclude='node_modules' \
  --exclude='new_cards_*.csv' \
  --exclude='potential_words*' \
  ./ "$target:/opt/recall/"

ssh "$target" 'sudo systemctl restart recall && sleep 2 && systemctl is-active recall'
echo "Deployed to $target."
