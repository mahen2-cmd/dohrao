# FSRS Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every deck, for every person, schedules with FSRS at 90% retention: new decks, Anki imports without FSRS, and every existing deck through a one-off script.

**Architecture:** There are two code changes:
- the default in `js/store.js`
- the import mapping in `anki.js`

The script `scripts/switch-to-fsrs.js` upserts `deck_prefs` for every owner and recipient of every deck, and is run by hand on the server.

**Tech Stack:** Node 22, `node:sqlite`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-13-fsrs-default-design.md`

## Global Constraints

- Values: `scheduler: 'fsrs'`, `retention: 0.9`. Nothing else in a deck's settings changes.
- An Anki file with FSRS on keeps its own retention and `fsrsParams`.
- The script is idempotent and works in one transaction. `--dry-run` writes nothing.
- No change to cards or progress rows.

## Review Focus

1. **A deck given to someone who never opened it has no `deck_prefs` row.** The script must create one, or that person keeps whatever the owner's `decks.data` says. Test: `switches a recipient with no prefs row`.
2. **An inactive (taken-back) assignment.** It is switched too, so a deck given again later comes back on FSRS. Test: same test, with `active = 0`.
3. **Old `decks.data` carrying `scheduler: 'sm2'` from the JSON migration** would show through for anyone without prefs. The script rewrites those keys. Test: `rewrites scheduler kept in deck data`.
4. **A second run** reports 0 changed. Test: `is idempotent`.
5. **Other prefs** (`newPerDay`, `speak`, `fsrsParams`) survive. Test: `keeps other prefs`.

---

### Task 1: FSRS by default for new decks and Anki imports

**Files:**
- Modify: `js/store.js` (`DECK_DEFAULTS.scheduler`, line 22, and the comment at line 10)
- Modify: `anki.js` (`deckSettings`, around line 145)
- Test: `tests/store.test.js`, `tests/anki.test.js:171`

- [ ] **Step 1: Tests.**
  - In `tests/store.test.js`, add `test('new decks default to FSRS at 90%')`. It asserts `DECK_DEFAULTS.scheduler === 'fsrs'` and `DECK_DEFAULTS.retention === 0.9`, and that a deck made with `createDeck` has the same.
  - In `tests/anki.test.js:171`, change the expected settings to `{ scheduler: 'fsrs', newPerDay: 15, retention: 0.9, easyInterval: 4 }` for that non-FSRS file.
- [ ] **Step 2:** Run `node --test tests/store.test.js tests/anki.test.js`. Expected: both fail on `'sm2'`.
- [ ] **Step 3: Implement.**
  - Set `DECK_DEFAULTS.scheduler = 'fsrs'`.
  - In `deckSettings`, a file with FSRS off gets `scheduler: 'fsrs'` and `retention: 0.9`. Its `easyInterval` stays `options.graduatingEasy`, as today.
  - Fix the `sm2` mention in the store comment.
- [ ] **Step 4:** Run `node --test`. Expected: all pass.
- [ ] **Step 5:** Commit with the message "Default decks and Anki imports to FSRS at 90% retention".

### Task 2: The one-off switch script

**Files:**
- Create: `scripts/switch-to-fsrs.js`
- Test: `tests/switch-to-fsrs.test.js`

**Interfaces:**
- Produces: `export function switchToFsrs(db, { dryRun = false } = {}) -> { changed: number, already: number }`. One count per (person, deck) pair: each owner with their decks, and each assignment.
- Produces a CLI: `node scripts/switch-to-fsrs.js --data <dir> [--dry-run]`. It opens `<dir>/recall.db` with `openDb` and prints, for example, `Would switch 12 of 15 decks (3 already on FSRS at 90%).` or `Switched 12 …`.

- [ ] **Step 1: Tests.** Build the database with `openDb` on a temp file plus `createUser`, then insert decks, assignments and prefs by SQL. The tests:
  - `switches own decks and given decks`: after the run, `buildView` shows `scheduler: 'fsrs'` and `retention: 0.9` on every deck for both the owner and the recipient.
  - `switches a recipient with no prefs row`: this includes an `active = 0` assignment.
  - `rewrites scheduler kept in deck data`: `decks.data` with `scheduler: 'sm2'` ends up `'fsrs'`.
  - `keeps other prefs`: `newPerDay: 7` and `fsrsParams` are unchanged.
  - `is idempotent`: the second run returns `{ changed: 0 }`.
  - `dry run writes nothing`: the counts match a real run, and the DB bytes are unchanged.
- [ ] **Step 2:** Run `node --test tests/switch-to-fsrs.test.js`. Expected: FAIL, because the module is not found.
- [ ] **Step 3:** Implement `switchToFsrs` and the CLI. Use one `BEGIN`/`COMMIT`, with `ROLLBACK` on error and on dry run. The entry point is guarded like `migrate-json.js`.
- [ ] **Step 4:** Run `node --test`. Expected: all pass.
- [ ] **Step 5:** Commit with the message "Add a one-off script that switches every deck to FSRS at 90%".

### Task 3: Ship and run on the server (each server step confirmed with the owner first)

- [ ] **Step 1:** Merge to `main`, then run `bash deploy/deploy.sh root@62.238.121.206`. Expected: the service restarts and the site loads.
- [ ] **Step 2:** On the server, run `cd /opt/recall && node scripts/switch-to-fsrs.js --data /var/lib/recall --dry-run`. Show the counts to the owner.
- [ ] **Step 3:** With the owner's OK, run these in order:
  1. `systemctl stop recall`
  2. `cp /var/lib/recall/recall.db /var/lib/recall/backups/recall-pre-fsrs-2026-11-13.db` (and the `-wal` file if present)
  3. Run the script without `--dry-run`.
  4. `systemctl start recall`

  Expected: `Switched N …`, and the service is active.
- [ ] **Step 4:** Run the dry run again. Expected: `0 of N` to switch.
