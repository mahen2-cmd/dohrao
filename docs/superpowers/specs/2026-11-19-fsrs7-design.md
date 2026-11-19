# FSRS-7 scheduler

A mid-sized change. Agreed in conversation on 2026-11-19.

## Why

FSRS-7 is the newest version of FSRS and the most accurate model that's practical to run
(srs-benchmark: log loss 0.321 against FSRS-6's 0.384 when same-day reviews are included). Its
main gain is on same-day reviews: it measures time in fractions of a day, while FSRS-6 counts
everything within a day as zero days. Dohrao's learning steps (1 and 10 minutes) produce exactly
those reviews. The user wants to choose it per deck, as they now choose between FSRS and SM-2.

RWKV-Instant was also asked for. It was set aside for now: no trained weights are published, it
needs a full per-review log that Dohrao doesn't keep, and it doesn't produce due dates by itself.

## What it does

- **A third choice under Scheduling** in the deck dialog: "FSRS-7 (newest)". The existing
  choices become "FSRS-6" (value stays `'fsrs'`, still the default) and "SM-2 (older Anki default)".
  The new value is `'fsrs7'`.
- **Learning steps are unchanged.** New cards still go 1 minute, then 10 minutes; forgotten cards
  10 minutes. Hard, Good and Easy delays during steps are the same as now.
- **Every answer updates the card's FSRS-7 memory** using the exact time since the last answer, in
  fractional days (`(now - lastReview) / DAY`). Same-day step answers count.
- **Intervals after graduation come from FSRS-7**: the time until predicted recall drops to the
  deck's desired retention. That time is then turned into whole days with the same rounding, fuzz
  and minimums the FSRS-6 path uses now (`passing()`, `graduateGood`, `graduateEasy`, the
  Again→relearning restart interval). Due counts and the 4am day start behave as today.
- **Desired retention** applies to FSRS-7 as it does to FSRS-6.
- **Switching is free at any time.** As SM-2 ease and FSRS-6 memory are now, the FSRS-7 memory is
  kept up to date on every answer in every mode, so a deck can move between the three schedulers.

## How it's built

- **The model** is ported into `js/fsrs.js` from `fsrs-rs` v7.0.0 (`src/model_v7.rs`, and the
  FSRS-7 branches of `src/inference.rs`): the 34 default weights, initial state for a new card,
  slow and fast stability updates, difficulty update, the two-curve forgetting curve, and the
  interval found by bisection. It's pure functions next to the FSRS-6 ones, like the rest of the file.
- **Card fields**: three new top-level numbers, `stability7`, `stabilityFast7` and `difficulty7`.
  They're added to `newSchedule()` (so undo restores them) and to `PROGRESS_NUMBERS` in
  `server/sync.js` (so the server checks they're finite).
- **Existing cards** (reviewed before, no FSRS-7 memory) get it on their next answer or preview,
  with no migration script. Their FSRS-6 values are the starting point: difficulty is copied, and
  both stabilities are scaled so the FSRS-7 curve gives 90% recall at the card's FSRS-6 stability,
  since FSRS-6 stability is defined as the time to 90% recall. This mirrors fsrs-rs's
  `scale_memory_state_to_interval` (starting shape: stability 1, fast stability 0.8). Cards that
  have never been answered start from FSRS-7's own initial state.
- **Weights**: FSRS-7 always uses its 34 defaults. A deck's imported `fsrsParams` are FSRS-6
  weights and stay with FSRS-6.

## Approaches

1. **Keep learning steps; FSRS-7 tracks memory and sets the day intervals (chosen).** Studying
   feels the same as now, everything day-based keeps working, and it's how Anki is most likely to
   ship it.
2. **FSRS-7 schedules everything, including same-day.** No fixed steps; a card comes back when
   predicted recall hits the target, at any hour. It uses the model more fully but conflicts with
   "due today" counts and the 4am day start, and there's no reference to port from. Possible later.
3. **Replace FSRS-6 with FSRS-7.** Rejected: the user wants a choice, and FSRS-7 isn't in Anki yet.

## Non-goals

- Fitting weights to the user's own reviews (for FSRS-6 or FSRS-7).
- A per-review log, and RWKV-Instant.
- Changing the default scheduler.
- Exporting FSRS-7 memory to Anki files.

## Anti-goals

- Changing how FSRS-6 or SM-2 decks schedule. Their intervals must be identical before and after.
- Due dates at odd hours, or cards leaving the learning steps early.

## Left to the builder

- Tests: check the port against fsrs-rs's own FSRS-7 test values (`inference_v7.rs`, model tests),
  plus scheduling tests for the `'fsrs7'` mode next to the existing ones in `tests/fsrs.test.js`.
  Existing FSRS-6 and SM-2 tests must pass unchanged.
- How the seeding helper is named and where it's called (inside `preview` is simplest).
- Whether the per-card FSRS-7 numbers are shown anywhere (card info, if it shows FSRS-6 values).
- Deploy with `deploy/deploy.sh` once tests pass.
