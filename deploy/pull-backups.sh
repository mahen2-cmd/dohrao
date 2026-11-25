#!/usr/bin/env bash
# Copy the server's daily database backups and its pictures down to this computer, so a lost
# server loses nothing. Run it on your own computer:
#   bash deploy/pull-backups.sh root@203.0.113.10 [folder]
# The folder defaults to ~/recall-backups, laid out as db/ (the dated databases) and media/.
# Nothing here is ever deleted because it went from the server; only daily databases beyond
# the newest KEEP (90 by default) are cleared away. Exits non-zero if the newest database is
# more than two days old or fails SQLite's integrity check, so a timer running it shows failed.
set -euo pipefail

target="${1:-}"
dest="${2:-$HOME/recall-backups}"
keep="${KEEP:-90}"
if [[ -z "$target" ]]; then
  echo "Usage: bash deploy/pull-backups.sh USER@HOST [folder]   (for example: bash deploy/pull-backups.sh root@203.0.113.10)" >&2
  exit 1
fi
mkdir -p "$dest/db" "$dest/media"

ssh_opts='ssh -o BatchMode=yes -o ConnectTimeout=20'
# --partial keeps half-sent files to resume; no --delete, so the copies here outlive the server's.
rsync -a --partial -e "$ssh_opts" "$target:/var/lib/recall/backups/" "$dest/db/"
rsync -a --partial -e "$ssh_opts" "$target:/var/lib/recall/media/" "$dest/media/"

# Keep the newest $keep daily databases. Hand-named ones (recall-before-…) are left alone.
mapfile -t daily < <(find "$dest/db" -maxdepth 1 -name 'recall-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].db' -printf '%f\n' | sort)
if (( ${#daily[@]} > keep )); then
  for f in "${daily[@]:0:${#daily[@]}-keep}"; do rm -- "$dest/db/$f"; done
fi

newest="$(find "$dest/db" -maxdepth 1 -name 'recall-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].db' -printf '%f\n' | sort | tail -1)"
if [[ -z "$newest" ]]; then
  echo "No daily backup came down from $target." >&2
  exit 1
fi
day="${newest#recall-}"
day="${day%.db}"
age=$(( ( $(date +%s) - $(date -d "$day" +%s) ) / 86400 ))
if (( age > 2 )); then
  echo "The newest backup, $newest, is $age days old: is the server still making them?" >&2
  exit 1
fi

# The copy must open and pass SQLite's own check. Node 22.15+ has SQLite built in.
node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  let verdict;
  try {
    verdict = Object.values(new DatabaseSync(process.argv[1], { readOnly: true }).prepare("pragma integrity_check").get())[0];
  } catch (error) {
    verdict = error.message;
  }
  if (verdict !== "ok") { console.error(`The newest backup, ${process.argv[1]}, is damaged: ${verdict}`); process.exit(1); }
' "$dest/db/$newest"

date -Iseconds > "$dest/last-pulled"
echo "Pulled backups from $target into $dest; newest $newest is sound ($(du -sh "$dest" | cut -f1) in all)."
