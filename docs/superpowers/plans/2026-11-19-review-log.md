# Review Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a permanent per-person record of every answer (card, time, button, state, duration, intervals), synced to the server, with Anki imports bringing their review history.

**Architecture:** The browser state gains `reviews` (entries made here) and `reviewsUndone` (ids of undone entries). `changesBetween` sends new entries as `changes.reviews` and new undone ids as `changes.deletedReviews`, so offline queueing, `localStorage` pending changes and retries all work through the existing sync path. The server keeps entries in a new `reviews` table, `INSERT OR IGNORE` by id, and deletes rows on undo. Deleting a card cascades to its rows. Anki's revlog rows travel on each imported card as `history` and become entries when the client imports the card.

**Tech Stack:** Plain ES modules, `node --test`, `node:sqlite` (`server/db.js`).

**Spec:** `docs/superpowers/specs/2026-11-19-review-log-design.md`

## Global Constraints

- Entry fields, exactly: `id`, `cardId`, `deckId`, `at`, `rating` (1–4), `state` (0–3, before the answer), `elapsed` (ms since the card's previous answer, or null), `duration` (ms, capped at 60,000, or null), `scheduler` (`'sm2' | 'fsrs' | 'fsrs7'` or null), `retention` (number or null), `intervalBefore` and `intervalAfter` (scheduled days, numbers or null).
- Duration cap: `MAX_DURATION = 60_000` ms.
- The server never sends entries back. `api/state` and `buildView` are unchanged.
- The backup download (`exportData`) leaves `reviews` and `reviewsUndone` out.
- Nothing about scheduling, counts or undo-of-schedule changes.

## Review Focus

1. **A sync retried after a timeout resends the same entries.** The server must store each once (Task 2 test `a review sent twice is stored once`).
2. **An answer given offline, then the tab closed.** The entry must survive in pending changes and reach the server on the next load (Task 1 test `pending changes carry reviews and undone ids`).
3. **An entry for a card the user can't access**, or a card that doesn't exist, must be rejected by id without failing the rest of the sync (Task 2 test `reviews for other people's cards are rejected`).
4. **Undo after the entry was already sent** must delete it on the server, and undo before sending must never store it (Task 1 test `undo removes the review whether or not it was sent`, Task 2 test `deletedReviews removes only your own entries`).
5. **Importing the same Anki file twice** must not log its history twice. Only cards actually added bring history (Task 3 test `re-importing an Anki file does not log its history again`).

---

### Task 1: Log answers in the browser state and send them with sync

**Files:**
- Modify: `js/store.js`: `emptyState`, `snapshotOf`, `changesBetween`, `idsOf`, `applyLocal`, `normalize`, `answerCard`, `restoreCard`, `exportData`
- Modify: `js/app.js:3333-3385`: `currentStudyCard`, `rate`, `undoAnswer`
- Test: `tests/store.test.js`

**Interfaces:**
- Produces, in `js/store.js`:
  - `answerCard(id, rating, now = Date.now(), { count = true, duration = null } = {})` returns the existing `before` copy plus `reviewId: string`.
  - `restoreCard(copy)` also undoes `copy.reviewId`.
  - `export const MAX_DURATION = 60_000`.
  - `export const reviewLog = () => state.reviews`, which tests read.
  - Sync payload keys: `reviews: Entry[]` and `deletedReviews: string[]`.
- Task 2 consumes the payload keys. Task 3 consumes `state.reviews` (push entries) and `uid()`.

Behaviour:
- `emptyState()` and `normalize()` give `reviews: []` and `reviewsUndone: []`. `normalize` ignores whatever the data has for them.
- `snapshotOf(s)` adds `reviews: new Set(s.reviews.map(r => r.id))` and `reviewsUndone: new Set(s.reviewsUndone)`.
- `changesBetween(before, after)`:
  - `changes.reviews` holds the entries whose id is in `after.reviews` but not in `before.reviews`. That needs the entries themselves, so add `reviewEntries: new Map(id → JSON)` to the snapshot, as decks and cards do.
  - `changes.deletedReviews` holds the ids in `after.reviewsUndone` but not in `before.reviewsUndone`.
  - Either key alone makes the changes non-null.
- `idsOf` adds the review ids and the deleted review ids, so a whole refused request reloads cleanly.
- `applyLocal(changes, skip)` appends `changes.reviews` (skipping ids already present or in `skip`) and adds `changes.deletedReviews` to `reviewsUndone`.
- `answerCard` builds the entry *before* `Object.assign(c, next)`:
  - `elapsed`: `c.lastReview == null ? null : now - c.lastReview`
  - `state`: `c.state`
  - `intervalBefore`: `c.scheduledDays ?? null`
  - `intervalAfter`: `next.scheduledDays`
  - `duration`: `duration == null ? null : Math.min(Math.max(0, Math.round(duration)), MAX_DURATION)`
  - `scheduler` and `retention` from the deck
  - `id: uid()`, `cardId`, `deckId`

  It pushes the entry to `state.reviews`.
- `restoreCard(copy)`: if `copy.reviewId`, remove that entry from `state.reviews` and push the id to `state.reviewsUndone` (always, even if it was never sent; the server ignores unknown ids). Do this even when the card is gone and the function returns false.
- `exportData` leaves out `reviews` and `reviewsUndone`.
- `app.js`: when `currentStudyCard` picks a new card, set `session.shownAt = Date.now()`. `rate` passes `{ count, duration: Date.now() - session.shownAt }`. `undoAnswer` sets `session.shownAt = Date.now()` for the card it brings back.

- [ ] **Step 1: Write the failing tests** in `tests/store.test.js`:
  - `answering logs one review with the card's state before the answer`: a new card answered Good at T0 with `duration: 4200` gives `reviewLog()` length 1, with `{ cardId, deckId, at: T0, rating: 3, state: State.New, elapsed: null, duration: 4200, scheduler: 'fsrs', retention: 0.9, intervalBefore: 0 }`, and `intervalAfter` equal to the card's new `scheduledDays`. Answering it again at `T0 + 10 * MINUTE` logs `state: State.Learning, elapsed: 10 * MINUTE`.
  - `duration is capped at 60 seconds`: `duration: 500_000` is logged as `60_000`, and no duration is logged as `null`.
  - `undo removes the review whether or not it was sent`: answer, then `restoreCard(copy)`. `reviewLog()` no longer has the entry. `diffState(snapshotOf(empty-with-the-entry-sent), state)` (build `before` as a snapshot taken after the answer) contains `deletedReviews: [copy.reviewId]` and no `reviews`.
  - `sync sends new reviews once`: take a snapshot `s1` after one answer, then answer another card. `diffState(s1, state).reviews` has exactly the second entry, and `diffState(snapshotOf(state), state)` is null.
  - `pending changes carry reviews and undone ids`: build changes with `diffState` from an empty snapshot after one answer, `store.reset()`, then apply them through the same path `load()` uses for pending changes. If `applyLocal` isn't exported, export it as `applyPending(changes)` for this test. `reviewLog()` then has the entry again.
  - `the backup download leaves the review log out`: after an answer, `JSON.parse(store.exportData())` has no `reviews` or `reviewsUndone` key.
- [ ] **Step 2: Run the tests and confirm they fail**: `node --test tests/store.test.js`. Expected: the new tests FAIL, and the existing ones pass.
- [ ] **Step 3: Implement** the behaviour above in `js/store.js` and `js/app.js`.
- [ ] **Step 4: Run all tests**: `npm test`. Expected: all pass. The existing undo tests (`tests/store.test.js:1013-1060`) must pass unchanged.
- [ ] **Step 5: Commit**: `git add js/store.js js/app.js tests/store.test.js && git commit -m "Log every answer in the browser and send it with sync"`

### Task 2: Store reviews on the server

**Files:**
- Modify: `server/db.js` (the `SCHEMA` string)
- Modify: `server/sync.js` (`applyChanges`, plus a new validator and an exported reader)
- Test: `tests/sync.test.js`

**Interfaces:**
- Consumes: the `reviews` and `deletedReviews` payload keys from Task 1.
- Produces: `export function reviewsOf(db, userId)` in `server/sync.js`, returning that user's entries oldest first, as the client sent them but with `deckId` set to the card's real deck. This is what the next piece of work (fitting) reads.

Schema (add to `SCHEMA`):
```sql
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_user_at ON reviews(user_id, at);
CREATE INDEX IF NOT EXISTS reviews_card ON reviews(card_id);
```

Behaviour in `applyChanges`:
- After cards are applied, so a card created in the same sync exists, handle `changes.reviews` through the existing `each(...)`:
  - Reject the id when the entry isn't valid, the card doesn't exist, or `access(db, userId, deckOfCard(cardId))` is neither `'own'` nor `'given'`.
  - Otherwise `INSERT OR IGNORE` with `deckId` overwritten by the card's real deck, and `data` = JSON of the entry.
- Handle `changes.deletedReviews` with `DELETE FROM reviews WHERE id = ? AND user_id = ?`. Never reject these.
- Valid entry rules:
  - `validId` for `id`, `cardId` and `deckId`
  - `at` a finite number
  - `rating` an integer 1–4, and `state` an integer 0–3
  - `elapsed`, `retention`, `intervalBefore` and `intervalAfter` each null or finite
  - `duration` null or finite in [0, 60000]
  - `scheduler` null or one of `'sm2'`, `'fsrs'`, `'fsrs7'`
  - entry JSON at most 1 KB
- `MAX_REVIEWS_PER_SYNC = 200_000`. A request with more is refused whole, in the same way as the existing per-request limits in this file. Follow how they refuse.

- [ ] **Step 1: Write the failing tests** in `tests/sync.test.js`, using the existing `seed()`, which gives ana deck d1 with cards c1–c3, and an `entry(id, over)` helper that builds a valid entry for c1:
  - `reviews are stored and read back oldest first`: two entries with `at` NOW+5 and NOW+1 → `{ rejected: [] }`, and `reviewsOf(db, ana.id).map(e => e.id)` gives the older one first.
  - `a review sent twice is stored once`: the same entry in two `applyChanges` calls gives `reviewsOf` length 1.
  - `reviews for other people's cards are rejected`: ben sends an entry for c1 (deck not given to him), and an entry for card `'nope'` → `rejected` lists both ids, and a third valid entry in the same request from ana is still stored. Use separate calls per user.
  - `a given deck's reviews are kept per person`: give d1 to ben, and both send an entry for c1. `reviewsOf` gives one each.
  - `deckId is taken from the card, not the client`: an entry with `deckId: 'wrong'` is stored with `deckId: 'd1'`.
  - `invalid reviews are rejected`: `rating: 5`, `state: 4`, `duration: 61000`, `scheduler: 'x'`, `at: 'now'` and `elapsed: '1'` are each rejected by id.
  - `deletedReviews removes only your own entries`: ana's entry is deleted by ana's `deletedReviews` but not by ben's. Unknown ids are ignored, with `rejected: []`.
  - `deleting a card deletes its reviews`: after `deletedCards: ['c1']`, `reviewsOf` is empty.
- [ ] **Step 2: Run the tests and confirm they fail**: `node --test tests/sync.test.js`. Expected: FAIL, because `reviewsOf` isn't exported.
- [ ] **Step 3: Implement** the schema, validation, insert, delete and `reviewsOf`.
- [ ] **Step 4: Run all tests**: `npm test`. Expected: all pass.
- [ ] **Step 5: Commit**: `git add server/db.js server/sync.js tests/sync.test.js && git commit -m "Keep each person's review log on the server"`

### Task 3: Bring Anki's review history in with an import

**Files:**
- Modify: `anki.js:423` (the revlog query) and the card objects it builds (around line 460)
- Modify: `js/store.js`: `importAnkiDecks`
- Test: `tests/anki.test.js`, `tests/store.test.js`

**Interfaces:**
- Consumes: `state.reviews` and the entry shape from Task 1.
- Produces: each imported card from `readAnkiCollection` carries `history: Array<{ at, rating, state, elapsed, duration, intervalBefore, intervalAfter }>`, oldest first. The existing `cardSchedule` input (`{ id, ease }`) is unchanged.

Mapping from an Anki revlog row (`id` = time in ms, `ease`, `ivl`, `lastIvl`, `time` = ms, `type` 0 learn / 1 review / 2 relearn):
- `at`: `id`
- `rating`: `ease`
- `state`: 0 for the card's first entry; otherwise `{0: 1, 1: 2, 2: 3}[type]`
- `elapsed`: `id` minus the previous entry's `id`, or null for the first
- `duration`: `Math.min(time, 60000)`
- `intervalBefore`: `lastIvl > 0 ? lastIvl : 0`
- `intervalAfter`: `ivl > 0 ? ivl : 0` (a negative value counts seconds within a learning step)

The query becomes `select id, cid, ease, ivl, lastIvl, time, type from revlog where ease between 1 and 4 and type < 3 order by id`.

`importAnkiDecks`: for each card actually added, push one entry per `history` item, with `id: uid()`, the new `cardId` and `deckId`, and `scheduler: null, retention: null`. Remove `history` from the stored card object.

- [ ] **Step 1: Write the failing tests**:
  - First, change the fixture `revlog` table in `tests/anki.test.js:35` to Anki's real columns `(id integer primary key, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer)`, and update `addHistory` and `REVLOG` to fill them. Existing tests must still pass on the new fixture.
  - In `tests/anki.test.js`, `imported cards carry their Anki review history`: a card with revlog rows `(T, ease 3, ivl -600, lastIvl 0, time 5000, type 0)`, `(T+600_000, 3, 1, -600, 8000, 0)` and `(T+DAY, 3, 3, 1, 90000, 1)` gives `history` equal to:
    - `{at: T, rating: 3, state: 0, elapsed: null, duration: 5000, intervalBefore: 0, intervalAfter: 0}`
    - `{at: T+600000, rating: 3, state: 1, elapsed: 600000, duration: 8000, intervalBefore: 0, intervalAfter: 1}`
    - `{at: T+DAY, rating: 3, state: 2, elapsed: DAY, duration: 60000, intervalBefore: 1, intervalAfter: 3}`
  - In `tests/store.test.js`, `importing Anki cards logs their history`: `importAnkiDecks` with one deck holding one card with a two-item `history` gives `reviewLog()` two entries with that card's new id and deck id and `scheduler: null`, and `store.card(id).history` is undefined.
  - In `tests/store.test.js`, `re-importing an Anki file does not log its history again`: importing the same object twice leaves `reviewLog()` at two entries.
- [ ] **Step 2: Run the tests and confirm they fail**: `node --test tests/anki.test.js tests/store.test.js`. Expected: the new tests FAIL, and the existing ones pass.
- [ ] **Step 3: Implement** the mapping in `anki.js` and the logging in `importAnkiDecks`.
- [ ] **Step 4: Run all tests**: `npm test`. Expected: all pass.
- [ ] **Step 5: Check it in the app**: start a local server against a scratch data folder, log in, study two cards (one answered, one answered and then undone), and confirm that `reviewsOf` for that user returns exactly one entry with a plausible `duration`. Read it with a one-off `node` call to `server/sync.js` `reviewsOf` on the scratch `recall.db`.
- [ ] **Step 6: Commit**: `git add anki.js js/store.js tests/anki.test.js tests/store.test.js && git commit -m "Bring Anki review history in with an import"`

### Task 4: Deploy (after the user says go)

- [ ] **Step 1:** Ask the user before deploying.
- [ ] **Step 2:** Run `bash deploy/deploy.sh root@62.238.121.206`. Confirm the service is active, and that `/var/lib/recall/recall.db` has the `reviews` table after the restart: query it with a one-off `node` script on the server, since the server has no `sqlite3` CLI.
