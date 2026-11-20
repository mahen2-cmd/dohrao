# Study Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track each person's active study time (card on screen, tab visible and focused, not idle) and show today's total, a trend chart and time by deck.

**Architecture:** A pure clock module measures active ms per card. On rating, `store.answerCard` adds it to a new synced `time[day][deckId]` (whole seconds) and an `active` field on the review-log entry. `time` travels and merges exactly like `log`, with its own column in `user_state`. The Today panel and Statistics read the totals from `store`.

**Tech Stack:** Vanilla ES modules in the browser (`js/`), Node 22 server with `node:sqlite` (`server/`), `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-20-study-time-design.md`

## Global Constraints

- Idle limit per card: 30 s + 250 ms per word shown, capped at 3 min (180,000 ms) in total.
- Time is stored as whole seconds per day and deck in `time[dayKey][deckId]`; merged across devices by maximum, like `log`.
- `duration` and `MAX_DURATION` (60,000) are unchanged. New review field `active`: integer ms or null, at most `MAX_ACTIVE = 3_600_000`.
- Undo does not take time back off the totals.
- Time formatting: under 60 s → `"45 s"`; under 60 min → `"18 min"` (whole minutes, floored); otherwise `"2 h 5 min"`, or `"2 h"` when minutes are 0. Zero → `"0 min"`.
- Copy: Today panel `"<t> studied"` (e.g. "18 min studied"); Statistics panel titles `"Study time"` and `"Time by deck"`.

## Review Focus

1. Leaving the study screen (to Decks, Statistics, a dialog) with a card still pending and coming back: time on other screens must not count. Task 4 pauses the clock on every non-study render and ignores input outside study.
2. Tab hidden or laptop asleep mid-card, back hours later: none of the absence counts, and no more than the idle limit before the last input. Task 1 test `pause and resume credit only time in view`.
3. An older device (no `time` in its sync) saving after a newer one: the server's `time` must be kept, not wiped. Task 3 test `a sync without time keeps the stored time`.
4. Hand-made `time` values (negative, fractional, strings, far-future days) are dropped on the server. Task 3 test `time is cleaned like log`.
5. A card answered just after midnight: its time goes to the day of the answer, matching `log`. Task 2 test `study time goes to the day of the answer`.

---

### Task 1: Study clock and time formatting

**Files:**
- Create: `js/studytime.js`
- Test: `tests/studytime.test.js`

**Interfaces:**
- Produces:
  - `IDLE_BASE = 30_000`, `IDLE_PER_WORD = 250`, `IDLE_MAX = 180_000`
  - `idleLimit(words: number) => number`: `min(IDLE_BASE + words * IDLE_PER_WORD, IDLE_MAX)`
  - `wordCount(text: string | null | undefined) => number`: whitespace-separated words after stripping HTML tags; 0 for empty or nullish input
  - `createStudyClock() => { start(words, t), setWords(words), input(t), pause(t), take(t) => ms }`
  - `formatStudyTime(seconds: number) => string`

- [ ] **Step 1: Write the failing tests** in `tests/studytime.test.js`:
  - `idle limit grows with words and is capped`: `idleLimit(0) === 30_000`, `idleLimit(40) === 40_000`, `idleLimit(10_000) === 180_000`.
  - `wordCount counts words and ignores tags`: `wordCount('<b>um</b> dois  três') === 3`, `wordCount('') === 0`, `wordCount(null) === 0`.
  - `steady input counts all time`: `start(0, 0)`, `input(10_000)`, `input(20_000)`, then `take(25_000) === 25_000`.
  - `idle stops at the last input plus the limit`: `start(0, 0)`, `input(5_000)`, `take(100_000) === 35_000`.
  - `input after idle starts counting again`: `start(0, 0)`, `input(100_000)` (credit 30,000, restart from 100,000), `take(110_000) === 40_000`.
  - `pause and resume credit only time in view`: `start(0, 0)`, `pause(10_000)`, `input(3_600_000)`, `take(3_605_000) === 15_000`.
  - `pause while idle credits nothing extra`: `start(0, 0)`, `pause(60_000)`, `take(60_000) === 30_000`.
  - `more words on screen allow a longer pause`: `start(0, 0)`, `setWords(400)` (limit 130,000), `take(200_000) === 130_000`.
  - `take resets the clock`: after `take`, `take` again at a later t with no `start` returns 0.
  - `formatStudyTime`: `0 → '0 min'`, `45 → '45 s'`, `60 → '1 min'`, `1099 → '18 min'`, `7500 → '2 h 5 min'`, `7200 → '2 h'`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/studytime.test.js`
Expected: FAIL, cannot find module `../js/studytime.js`.

- [ ] **Step 3: Implement `js/studytime.js`**

The clock state is `{ running, since, lastInput, limit, banked }`. One internal `credit(t)` does `banked += max(0, min(t, lastInput + limit) - since)` and then `since = t` when running.
- `start(words, t)`: `banked = 0`, `running = true`, `since = lastInput = t`, `limit = idleLimit(words)`.
- `setWords(words)`: updates `limit` only.
- `input(t)`: if running, `credit(t)`; otherwise `running = true` and `since = t`. Then `lastInput = t`. When `t > lastInput + limit` while running, the credit stops at `lastInput + limit`. Counting restarts from `t`, since `since = t`.
- `pause(t)`: `credit(t)`, `running = false`.
- `take(t)`: `credit(t)` if running, return `banked`, then reset to not running with `banked = 0`.

`take` before any `start` returns 0. Default `t` is `Date.now()` everywhere.

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test tests/studytime.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add js/studytime.js tests/studytime.test.js
git commit -m "Measure active study time per card, pausing when idle or out of view"
```

---

### Task 2: Keep study time in the store

**Files:**
- Modify: `js/store.js` (emptyState ~40, MAX_DURATION ~43, snapshotOf ~80-92, changesBetween ~104, applying pulled changes ~184, loaded state ~419, `answerCard` ~1188-1220, `stats` ~1251, `statistics` ~1272-1314)
- Test: `tests/store.test.js`, `tests/sync-client.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `store.MAX_ACTIVE = 3_600_000`
  - `answerCard(id, rating, now, { count, duration, active = null })`. The review entry gains `active: null | integer ms` (rounded, clamped to `0..MAX_ACTIVE`). When `active > 0`, `state.time[dayKey(now)][deckId] += Math.round(active / 1000)`, whatever `count` is.
  - `stats(now)` returns `{ reviewedToday, streak, studiedToday }`, where `studiedToday` is today's seconds across all decks.
  - `statistics(deckId, days, now)` gains `time: { perDay: { [dayKey]: seconds }, byDeck: { [deckId]: seconds }, total: seconds, today: seconds }`. `perDay` and `total` cover the last `days` days ending today, for `deckId` or all decks. `byDeck` covers the same days for all decks, existing decks only.
  - `time` is a state key synced, snapshotted and merged with `mergeCounts` exactly like `log`. A loaded state takes `data.time ?? {}`.

- [ ] **Step 1: Write the failing tests** in `tests/store.test.js`:
  - `study time adds up per day and deck in whole seconds`: two cards in deck A answered at T0 with `active: 12_400` and `active: 3_600`, one in deck B with `active: 1_000`. Then `currentState().time` equals `{ [dayKey(T0)]: { [A]: 16, [B]: 1 } }`. The review entries' `active` are 12400, 3600 and 1000.
  - `answers without active time log null and add no time`: `active` omitted, so the entry has `active: null` and `time` is `{}`.
  - `active is capped at MAX_ACTIVE`: `active: 9e9` gives the entry `active === 3_600_000`.
  - `undo keeps study time`: answer with `active: 5_000`, `restoreCard`, then answer again with `count: false, active: 2_000`. The day's time is 7.
  - `study time goes to the day of the answer`: answer at `T0 + DAY` gives the time under `dayKey(T0 + DAY)` only.
  - Update `stats track reviews today and the streak` so every expected object includes `studiedToday: 0`. Add `stats reports seconds studied today` with `active: 90_000` at T0, giving `stats(T0).studiedToday === 90`.
  - `statistics report study time by day and deck`: decks A and B over three days. Assert `time.perDay`, `time.total`, `time.today` for `statistics(undefined, 30, now)` and for `statistics(A, 30, now)`. Assert `time.byDeck` holds both decks, and that a day older than `days` is left out.
  - Update the exact-shape assertion in `answering logs one review...` to include `active: null`.
- In `tests/sync-client.test.js`, add `study time is sent when it changes and merged when pulled`, in the style of the existing `load takes the state from the server...` test. Answering with `active` sends `time` in the sync body. A pulled `time` with a larger count for the same day and deck wins.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/store.test.js tests/sync-client.test.js`
Expected: the new and updated tests FAIL.

- [ ] **Step 3: Implement in `js/store.js`** as the Interfaces block says. Add `'time'` everywhere `'log'` appears in the snapshot, diff, merge and load paths: lines ~88, ~104, ~184, ~419. `exportData` includes `time` automatically.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all pass. Other tests that assert `stats()` or `emptyState` shapes may need `studiedToday` or `time` added; update them.

- [ ] **Step 5: Commit**

```bash
git add js/store.js tests/store.test.js tests/sync-client.test.js
git commit -m "Keep active study time per day and deck, and on each logged answer"
```

---

### Task 3: Server keeps and validates study time

**Files:**
- Modify: `server/db.js` (add the column for older databases, next to `addAssignmentUrduColumns`), `server/sync.js` (`validReview` ~73, state read ~157-166, `applyState` ~268-280, trigger ~323), `server.js` (`validChanges` ~115)
- Test: `tests/sync.test.js`, `tests/db.test.js`

**Interfaces:**
- Consumes: the `time` shape and `active` field from Task 2.
- Produces: `user_state.time TEXT NOT NULL DEFAULT '{}'`. The state sent to the app includes `time`. `applyChanges` merges `changes.time` with `mergeCounts(cleanCounts(stored, 'time', now), cleanCounts(incoming, 'time', now))`. The existing non-daily branch of `cleanCounts` already accepts `day → deck → count`, so `js/counts.js` needs no change.

- [ ] **Step 1: Write the failing tests**
  - `tests/sync.test.js` `time is merged from two devices, keeping the larger count`: two `applyChanges` calls with `time: { '2023-01-02': { d1: 30 } }` then `{ '2023-01-02': { d1: 20, d2: 5 } }`. The pulled state's `time` equals `{ '2023-01-02': { d1: 30, d2: 5 } }`.
  - `a sync without time keeps the stored time`: after a sync with `time`, a sync with only `daily` leaves `time` unchanged.
  - `time is cleaned like log`: `{ '2023-01-02': { d1: -1, d2: 1.5, d3: 'x', d4: 7 }, '2999-01-01': { d1: 1 } }` is stored as `{ '2023-01-02': { d4: 7 } }`.
  - `time is per user`: one user's `time` doesn't appear in another's state.
  - `a review's active time must be null or 0..3,600,000 ms`: reviews with `active: -1`, `active: 3_600_001` and `active: 'x'` are rejected. Entries with `active: null`, a missing `active`, and `active: 3_600_000` are kept.
  - `tests/db.test.js` `an older database gains the time column`: create `user_state` without `time`, insert a row, reopen with `openDb`, and read `time === '{}'`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/sync.test.js tests/db.test.js`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**
- Add `time` to the `user_state` `CREATE TABLE`.
- Add an `ALTER TABLE user_state ADD COLUMN time TEXT NOT NULL DEFAULT '{}'` guard.
- Select, merge and insert `time` in `applyState`.
- Return `time: parse(s?.time)` from the state read.
- Add `'time'` to the trigger list at ~323 and `object('time')` to `validChanges`.
- In `validReview`: `(r.active === undefined || r.active === null || intIn(r.active, 0, 3_600_000))`.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all pass. Tests asserting the exact pulled-state shape (e.g. `tests/sync.test.js:50`) need `time: {}` added.

- [ ] **Step 5: Commit**

```bash
git add server/db.js server/sync.js server.js tests/sync.test.js tests/db.test.js
git commit -m "Keep and merge each person's study time on the server"
```

---

### Task 4: Run the clock in the study screen

**Files:**
- Modify: `js/app.js` (`currentStudyCard` ~3415-3425, `reveal` ~3439, `rate` ~3450-3459, `undoAnswer` ~3462-3470, global listeners ~4824, `render` dispatch)

**Interfaces:**
- Consumes: `createStudyClock`, `wordCount` (Task 1); `answerCard(..., { active })` (Task 2).

- [ ] **Step 1: Wire the clock**
- Create one module-level `const clock = createStudyClock()`.
- Where `currentStudyCard` sets `shownAt`, call `clock.start(wordCount(<front text shown>), Date.now())`. In `reveal` call `clock.input()` and then `clock.setWords(<front + back words>)`. Use `urduShown(...)` text when that's what's on screen. Otherwise use `card.front` and `card.back`.
- In `rate`, pass `active: clock.take()` alongside `duration`.
- In `undoAnswer`, restart with `clock.start(<front + back words>)`, because the card comes back already revealed.
- Listeners on `window`, `{ passive: true, capture: true }`: `pointerdown`, `pointermove`, `keydown`, `wheel`, `scroll`, `touchstart`, `focus`. They call `clock.input()` only when `route().view === 'study'` and `!document.hidden`; otherwise they call `clock.pause()`.
- `blur` calls `clock.pause()`. In the existing `visibilitychange` listener, call `clock.pause()` when hidden and `clock.input()` when visible on the study route.
- At the start of `render()`, call `clock.pause()` when the route is not `study`.

- [ ] **Step 2: Verify in the running app** (use the `run` skill: `npm start`, then open the study screen in a browser).
- Study 3 cards with steady input, about 10 s each. `store.stats().studiedToday` in the console should be about 30.
- Leave a card open for 2 minutes without input, then rate it. The day should gain about 30 s plus the words allowance, not 2 minutes.
- Switch tabs for 1 minute mid-card and return. The minute isn't added.
- Open Decks for a minute, moving the mouse, then return to study and rate. The minute on Decks isn't added.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add js/app.js
git commit -m "Time study only while a card is on screen and someone is working on it"
```

---

### Task 5: Show study time

**Files:**
- Modify: `js/app.js` (`todayPanel` ~1806-1860, `renderStats` summary ~3990-4010 and its panel list, add `studyTimePanel` and `timeByDeckPanel` next to `forecastPanel` ~3788), `css/styles.css` only if the new table needs a style the existing panels lack

**Interfaces:**
- Consumes: `store.stats().studiedToday`, `store.statistics(...).time` (Task 2), `formatStudyTime` (Task 1). Existing helpers: `panel`, `columnChart`, `dataTable`, `addDays`, `shortDate`, `longDate`, `statsRange`, `store.dayKey`.

- [ ] **Step 1: Today panel.**
- Phone line: insert `` `${formatStudyTime(studiedToday)} studied` `` after "reviewed today".
- Desktop `today-figures`: add a figure with `dd` set to `formatStudyTime(studiedToday)` and `dt` set to `studied today`.
- Show it only when `studiedToday > 0`, so a new user sees no "0 min".

- [ ] **Step 2: Statistics summary.** Add the stat `formatStudyTime(s.time.today)` labelled `studied today`. When `s.time.total > 0`, also add `formatStudyTime(s.time.total)` labelled `` `studied over the past ${statsRange.span}` ``.

- [ ] **Step 3: `studyTimePanel(s, today)`.** Mirror `forecastPanel`, but walk backwards from today in bins of `statsRange.bin` over `statsRange.days`, oldest first.
- Each item's value is minutes, rounded to 1 decimal: the bin's summed seconds divided by 60. The chart unit is `'minute'`. The data-table cells use `formatStudyTime`.
- Subtitle: `` `${formatStudyTime(total)} over the past ${span}, about ${formatStudyTime(total / activeDays)} a day you studied.` ``, where `activeDays` counts days with time > 0. When the total is 0: `` `No study time recorded over the past ${span}.` ``.
- Title: `Study time`.

- [ ] **Step 4: `timeByDeckPanel(s, decks)`.** Show this only on the all-decks view with 2 or more decks having time.
- It's a `dataTable` titled `Time by deck`, with columns `['Deck', 'Time', 'Share']`.
- Rows are sorted by time, largest first. Share is the percent of the period total, using the existing `percent` helper.

- [ ] **Step 5: Verify in the running app.** After studying, check that the Today panel, the Statistics summary, the chart for each period button and deck pick, and the by-deck table all show the expected values, at phone and desktop widths, in light and dark themes.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm test` (all pass)

```bash
git add js/app.js css/styles.css
git commit -m "Show study time today, over time, and by deck"
```
