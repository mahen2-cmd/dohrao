# FSRS at 90% retention for everyone: design

## Intent

The owner wants every deck, for every person on Dohrao, scheduled with FSRS at 90% desired retention. That covers decks made from now on and every deck that already exists.

## Goals

- **New decks** start on FSRS at 90%: `DECK_DEFAULTS.scheduler` becomes `'fsrs'`. `retention` is already `0.9`.
- **Anki imports** whose file has FSRS off come in as FSRS at 90%.
  - A file with FSRS on keeps its own retention and parameters.
- **Existing decks:** a one-off switch on the live server sets every person's every deck (their own and decks given to them) to `scheduler: 'fsrs'`, `retention: 0.9`. Their other settings stay as they are.

## Non-goals

- People can still switch a deck back to SM-2 or change retention in its settings. The switch is a one-off, not a lock.
- No change to cards: due dates, intervals and history stay. FSRS takes over from each card's next review. Both memory models are kept up to date already (`js/fsrs.js:237`).

## Approaches considered

- **1. A one-off script, run by hand.** It has a dry run first, and the live run happens after stopping Recall and taking a backup. **Chosen.**
- **2. An automatic migration on the next deploy.** No dry run, it runs as soon as the deploy lands, and its code stays in the server forever.

## Decisions

- **The script:** `scripts/switch-to-fsrs.js --data <dir> [--dry-run]`, in the style of `scripts/migrate-json.js`.
  - For every deck an owner owns, and every active or inactive assignment, it upserts the person's `deck_prefs` row.
  - It merges in `scheduler: 'fsrs'` and `retention: 0.9` and keeps the row's other keys.
  - It also rewrites those two keys if they sit in `decks.data`, so no old value shows through.
  - It does everything in one transaction and prints how many rows it changed and how many were already on FSRS at 90%.
  - Running it twice changes nothing the second time.
- **Live run:**
  1. A dry run on the server.
  2. Stop `recall`.
  3. Copy `/var/lib/recall/recall.db` to `/var/lib/recall/backups/recall-pre-fsrs-2026-11-13.db`.
  4. Run the script.
  5. Start `recall`.

  The code goes up first with `deploy/deploy.sh`. Every server step is shown to the owner and confirmed before it runs.
- **Tests:**
  - The script, in a new `tests/switch-to-fsrs.test.js`.
  - The new default and the import behaviour, in the existing store and anki tests, where they currently expect SM-2.

## Left to the builder

- The script's exact output wording.
- Where the Anki-import default is applied: in `anki.js`'s `deckSettings`, the one place that maps a file's settings.
