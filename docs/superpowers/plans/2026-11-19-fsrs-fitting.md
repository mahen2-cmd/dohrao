# FSRS Fitting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fit FSRS-6 and FSRS-7 weights to one person's answers on one deck, on request, keeping them only when they predict better, with a counter of usable answers in deck settings.

**Architecture:** The server reads the person's review log for a deck and turns it into the optimizer's CSV input. It fits and scores both models in a worker thread with `@open-spaced-repetition/binding`, and returns the weights to the app. The app stores them in the deck's personal settings (`fsrsParams`, `fsrs7Params`) through the normal sync. `js/fsrs.js` then schedules with them. The server never writes deck settings itself.

**Tech Stack:** Plain ES modules, `node --test`, `node:sqlite`, `node:worker_threads`, `@open-spaced-repetition/binding@0.6.1` (WASI build; there's no native Linux build, which is fine).

**Spec:** `docs/superpowers/specs/2026-11-19-fsrs-fitting-design.md`

## Global Constraints

- One set of weights per deck per person, fitted only from that person's answers to that deck's cards.
- `FIT_MIN_ANSWERS = 1000` usable answers. Below that, the button is disabled and the server refuses with 400 `not-enough-answers`.
- **Usable answers:** that person's logged answers on cards *currently* in the deck whose earliest logged answer has `state === 0` (New).
- A new set is kept only if its log loss beats the deck's current set for that model: fitted weights, imported Anki weights (FSRS-6 only), or the defaults (`DEFAULT_W`, `DEFAULT_W7` from `js/fsrs.js`).
- Copy, exactly:
  - Counter: `Answers ready for fitting: {n} of 1,000`. Past 1,000, show the real count, e.g. `1,240 of 1,000`.
  - Button: `Fit to my answers`
  - Reset link: `Reset to defaults`
  - Kept: `Fitted. Predictions are {p}% more accurate on your answers.`
  - Not kept: `Kept the current weights; the fit wasn't better.`
  - Errors: `Not enough answers to fit yet.` and `Fitting failed. Try again later.`
- Scheduling stays the same for any deck without fitted weights.
- The optimizer must never run on the HTTP server's main thread.

## Review Focus

1. **Hand-edited or corrupted `fsrsParams` / `fsrs7Params`** (wrong length, NaN). Scheduling must fall back to the defaults instead of producing NaN intervals (Task 1 test `bad fitted weights fall back to the defaults`).
2. **A card moved to another deck after it was answered.** Its answers count for the deck it is in now, not the old one (Task 2 test `answers count for the deck a card is in now`).
3. **Cards first studied before the log existed** (earliest logged answer not New). They must not count or be fitted (Task 2 test `cards without their first answer are left out`).
4. **Fitting someone else's deck, or one not given to you.** The server must refuse (Task 3 test `fitting a deck you cannot study is refused`).
5. **Two fits at once, or a slow fit.** Other requests must still be answered while it runs (Task 3 test `the server answers other requests while a fit runs`).

---

### Task 1: Schedule with a deck's fitted weights

**Files:**
- Modify: `js/fsrs.js`: `preview` (new option `w7`, passed to `nextMemory7`, `nextInterval7` and `seedMemory7`)
- Modify: `js/store.js`: `schedulingOptions`, plus a new `fittedWeights(list, length)` helper; update the `DECK_DEFAULTS` comment to name `fsrs7Params`
- Test: `tests/fsrs7.test.js`, `tests/store.test.js`

**Interfaces:**
- Produces:
  - `preview(card, now, { ..., w7 })`: FSRS-7 uses `w7 ?? DEFAULT_W7`.
  - The deck personal fields `fsrsParams: number[21]` and `fsrs7Params: number[34]`. Task 4 writes them.
- `fittedWeights(list, length)` returns `list` when it is an array of exactly `length` finite numbers, else `undefined`. `schedulingOptions` passes `w: fittedWeights(d.fsrsParams, 21)` and `w7: fittedWeights(d.fsrs7Params, 34)`.

- [ ] **Step 1: Write the failing tests**:
  - `tests/fsrs7.test.js`, `fsrs7: given weights are used`: for a new card, `preview(newSchedule(T0), T0, { scheduler: 'fsrs7', w7 })[4].scheduledDays` with `w7 = [...DEFAULT_W7]` and `w7[3] = 20` (initial Easy stability) is greater than with no `w7`. The `stability7` of Easy equals 20.
  - `tests/store.test.js`, `a deck's fitted FSRS-7 weights shape its intervals`: a deck `{ scheduler: 'fsrs7', fsrs7Params: w7 }` (same `w7`) shows a longer Easy preview for a new card than a deck without them, both via `store.previewCard`.
  - `tests/store.test.js`, `bad fitted weights fall back to the defaults`: decks with `fsrs7Params: [1, 2]`, `fsrs7Params: Array(34).fill(NaN)` and `fsrsParams: ['x']` preview exactly as the same deck without them, and every `scheduledDays` is finite.
- [ ] **Step 2: Run and confirm they fail**: `node --test tests/fsrs7.test.js tests/store.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as described in Interfaces.
- [ ] **Step 4: Run all tests**: `npm test`. Expected: all pass.
- [ ] **Step 5: Commit**: `git commit -m "Schedule with a deck's fitted FSRS weights"`

### Task 2: Fitting a deck from the review log

**Files:**
- Modify: `package.json` and `package-lock.json` (`npm install @open-spaced-repetition/binding@0.6.1 --save-exact`)
- Create: `server/fit.js` (reading the log and doing the fitting; no HTTP)
- Test: `tests/fit.test.js`

**Interfaces:**
- Consumes: the `reviews` table (`id, user_id, card_id, at, data`); `data` holds `{ rating, state, duration, ... }`. Also `DEFAULT_W` and `DEFAULT_W7` from `js/fsrs.js`.
- Produces, from `server/fit.js`:
  - `export const FIT_MIN_ANSWERS = 1000`
  - `export function usableReviews(db, userId, deckId): Array<{ cardId, at, rating, state, duration }>`, sorted by card then `at`, holding only cards currently in `deckId` whose earliest entry has `state === 0`.
  - `export function reviewCsv(reviews): Uint8Array`, with header `card_id,review_time,review_rating,review_state,review_duration` and one row per review. Card ids are mapped to integers 1, 2, 3… in order of first appearance; `review_duration` is `duration ?? 0`.
  - `export async function fitWeights({ reviews, timezone, current6, current7 }): Promise<{ fsrs6: Result, fsrs7: Result }>`, where `Result = { kept: true, params: number[], improvement: number } | { kept: false }`. `improvement` is a whole percent, `Math.round(100 * (currentLoss - fittedLoss) / currentLoss)`. Throws `Error('not-enough-answers')` below `FIT_MIN_ANSWERS`.

`fitWeights` works per model `m` in `['FSRS-6', 'FSRS-7']`:
1. `items = convertCsvToFsrsItems(reviewCsv(reviews), 4, timezone, m)`. The rollover hour is 4, as in `js/fsrs.js`.
2. `params = await computeParameters(items, { modelVersion: m, enableShortTerm: true, numRelearningSteps: 1 })`.
3. `fittedLoss = (await evaluateWithTimeSeriesSplits(items, same options)).logLoss`. This is out-of-sample, so in-sample fit doesn't flatter it.
4. `currentLoss = new FSRSBinding(current).evaluate(items).logLoss`, where `current` is `current6 ?? DEFAULT_W` or `current7 ?? DEFAULT_W7`.
5. Kept when `fittedLoss < currentLoss`.

- [ ] **Step 1: Write the failing tests** in `tests/fit.test.js`. Seed users and a deck with `openDb(':memory:')`, `createUser` and `applyChanges`, as `tests/sync.test.js` does. A `simulate(cards, answersEach)` helper writes log entries through `applyChanges(... { reviews })`: each card's first entry has `state: 0` and later ones `state: 2`, rating 3 with a fixed 15% of 1s, and intervals growing ×2.5.
  - `only usable answers are counted`: a card whose entries start with `state: 2` adds nothing, and a fully logged card adds all its entries.
  - `cards without their first answer are left out`: same as above, checked on the returned rows' card ids.
  - `answers count for the deck a card is in now`: answer c1 in d1, move c1 to d2 (`applyChanges` with an updated card), and `usableReviews(db, ana, 'd2')` includes them while `'d1'` doesn't.
  - `another person's answers are never used`: ben's entries on a given deck don't appear in ana's `usableReviews`.
  - `the CSV has the optimizer's columns`: `new TextDecoder().decode(reviewCsv(rows)).split('\n')[0] === 'card_id,review_time,review_rating,review_state,review_duration'`, and card ids are small integers.
  - `fitting refuses below 1,000 answers`: `fitWeights` with 999 rows rejects with message `not-enough-answers`.
  - `a fit on enough answers beats the defaults`: 250 cards × 6 answers (1,500). Both results are `kept: true`, `params` lengths are 21 and 34, every value is finite, and `improvement > 0`.
  - `a fit is not kept when the current weights are already better`: run `fitWeights` once, then again with `current6` and `current7` set to its own params. At least one result is `kept: false` or has `improvement` ≤ 1. Assert that `kept` is a boolean and that no result is kept with `improvement <= 0`.
- [ ] **Step 2: Run and confirm they fail**: `node --test tests/fit.test.js`. Expected: FAIL, because `server/fit.js` doesn't exist.
- [ ] **Step 3: Install the package and implement `server/fit.js`.** The `reviews.data` JSON carries `state`, `rating` and `duration`. Join with `cards` on `card_id` for the current `deck_id`.
- [ ] **Step 4: Run all tests**: `npm test`. Expected: all pass. Note the run time of `tests/fit.test.js` in the ledger.
- [ ] **Step 5: Commit**: `git commit -m "Fit FSRS-6 and FSRS-7 to a deck's logged answers"`

### Task 3: Fit endpoints, run off the main thread

**Files:**
- Create: `server/fit-worker.js` (a `worker_threads` worker: receives `{ reviews, timezone, current6, current7 }`, posts back `fitWeights`'s result or `{ error: message }`)
- Modify: `server/fit.js` (add `runFit(input): Promise`, which starts one worker per call and rejects after 120 s)
- Modify: `server.js` (routes), `js/api.js` (client calls)
- Test: `tests/http.test.js`

**Interfaces:**
- Consumes: `usableReviews`, `fitWeights` and `FIT_MIN_ANSWERS` from Task 2. `access(db, userId, deckId)` in `server/sync.js` must be exported, if it isn't already.
- Produces:
  - `GET api/decks/:id/fit` returns `{ usable: number, needed: 1000 }`.
  - `POST api/decks/:id/fit` with body `{ timezone: string, current6?: number[21], current7?: number[34] }` returns `{ fsrs6: Result, fsrs7: Result, usable }`.
  - Errors:
    - 404 `not-found` for a deck whose access is neither `'own'` nor `'given'`.
    - 400 `not-enough-answers` below the threshold.
    - 400 `bad-request` for a timezone that isn't a string of 1–64 characters, or `current6`/`current7` of the wrong length or with non-finite values.
    - 500 `fit-failed` when the worker errors or times out.
    - A rate limit of 20 fits per user per day, using `createLimiter`, which gives 429.
  - `js/api.js`: `fitStatus(deckId)` and `fit(deckId, body)`.

- [ ] **Step 1: Write the failing tests** in `tests/http.test.js`, following its existing server setup (`createRecallServer` on port 0, logged-in cookie):
  - `fit status counts usable answers`: after syncing 3 fully logged cards × 4 answers, `GET` gives `{ usable: 12, needed: 1000 }`.
  - `fitting below the threshold is refused`: `POST` gives 400 `not-enough-answers`.
  - `fitting a deck you cannot study is refused`: ben's `GET` and `POST` on ana's deck (not given) both give 404.
  - `a fit returns weights for both models`: sync 1,500 usable answers, then `POST { timezone: 'Europe/Lisbon' }` gives 200 with `fsrs6.kept` and `fsrs7.kept` booleans and param lengths 21 and 34 when kept. The deck's stored data is unchanged; the server doesn't save weights.
  - `the server answers other requests while a fit runs`: start the `POST` without awaiting it, then `GET api/me` resolves before the fit does. Compare completion order with `Promise.race` on the two.
- [ ] **Step 2: Run and confirm they fail**: `node --test tests/http.test.js`. Expected: the new tests FAIL with 404s.
- [ ] **Step 3: Implement** the worker, `runFit`, the routes and the client calls.
- [ ] **Step 4: Run all tests**: `npm test`. Expected: all pass.
- [ ] **Step 5: Commit**: `git commit -m "Fit a deck's weights on request, in a worker"`

### Task 4: Counter, button and reset in deck settings

**Files:**
- Modify: `js/app.js`: `openDeckDialog`, next to the Scheduling field and its note (around `js/app.js:619-724`)
- Modify: `js/store.js`: a new `setFittedWeights(deckId, { fsrsParams, fsrs7Params })` (sets the given fields, deletes them when passed `null`, then saves)
- Modify: `css/` (only if the layout needs a rule, in the existing field-note style)
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: `api.fitStatus` and `api.fit` from Task 3, and the deck fields from Task 1.
- Behaviour, only when editing an existing deck (not "New deck"):
  - Under the Scheduling note, show the counter (Global Constraints copy, fetched with `api.fitStatus` when the dialog opens; show nothing until it arrives, and nothing if the request fails).
  - Show the button, disabled while `usable < needed` or while a fit runs; while running, its text is `Fitting…`.
  - On click: `api.fit(deck.id, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, current6: deck.fsrsParams (if 21), current7: deck.fsrs7Params (if 34) })`. Then call `store.setFittedWeights` with each kept model's params, leaving models that weren't kept unchanged. Show the message for the best `improvement` among kept models, or the "Kept the current weights" line when neither was kept. Errors show the two error lines.
  - Show `Reset to defaults` only when the deck has `fsrsParams` or `fsrs7Params`. It calls `store.setFittedWeights(deck.id, { fsrsParams: null, fsrs7Params: null })` and hides itself.

- [ ] **Step 1: Write the failing test** in `tests/store.test.js`, `fitted weights are saved and reset per deck`: `setFittedWeights(a, { fsrs7Params: w7 })` changes only deck `a`, and deck `b` keeps no weights. Then `setFittedWeights(a, { fsrsParams: null, fsrs7Params: null })` removes both keys from deck `a`. The deck must have them as its own (personal) fields: check that `diffState` sends the deck.
- [ ] **Step 2: Run and confirm it fails**: `node --test tests/store.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `setFittedWeights` and the dialog UI.
- [ ] **Step 4: Run all tests**: `npm test`. Expected: all pass.
- [ ] **Step 5: Check it in the app.** Use the scratch server and the Playwright driver from earlier sessions, in `/tmp/claude-1000/-home-mahenmughal-Ludo-Recall/d6e8f592-d450-4ebf-96a4-5ba1e25878d4/scratchpad/`:
  1. Seed the test user's log with 1,500 usable answers on one deck, through `applyChanges` on the scratch `recall.db`.
  2. Open that deck's settings and confirm the counter shows `1,500 of 1,000`.
  3. Press the button and confirm the result line appears.
  4. Confirm that a card's preview intervals changed and that `Reset to defaults` brings them back.
  5. Take screenshots and look at them.
- [ ] **Step 6: Commit**: `git commit -m "Show the fitting counter and button in deck settings"`

### Task 5: Deploy (after the user says go)

- [ ] **Step 1:** Ask the user before deploying.
- [ ] **Step 2:** Run `bash deploy/deploy.sh root@62.238.121.206`; its `npm ci --omit=dev` installs the optimizer. On the server, confirm `node -e "import('@open-spaced-repetition/binding').then(m => console.log(m.__napiBindingTarget))"` prints `wasm32-wasi` from `/opt/recall`, that the service is active, and that `GET api/decks/<id>/fit` answers for a logged-in user. The live check can be done through the UI by the user.
