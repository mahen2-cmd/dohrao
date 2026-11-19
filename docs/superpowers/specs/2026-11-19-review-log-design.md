# Review log

A mid-sized change. Agreed in conversation on 2026-11-19.

## Why

Answering a card overwrites its schedule; only per-day button counts remain. Fitting FSRS-6 or
FSRS-7 to one person's memory, and any later neural model (RWKV), needs every answer: which card,
when, which button, and how long it took. The log starts collecting that now. Nothing earlier can
be recovered: the `.apkg` files in `decks/` were built by the owner and carry no history.

## What it does

- **One entry per answer**, kept forever per person:
  - `id` (random), `cardId`, `deckId`, `at` (time of the answer, ms)
  - `rating` 1–4, `state` before the answer (0 new, 1 learning, 2 review, 3 relearning)
  - `elapsed`: ms since the card's previous answer, or null on its first
  - `duration`: ms from the card appearing to the answer, capped at 60,000 as Anki does
  - `scheduler` and `retention` in use; `intervalBefore` and `intervalAfter` (scheduled days)
- **Offline and sync.** New entries queue in the browser with the other unsent changes, survive a
  closed tab the same way, and go up with the next sync. The server keeps them in a new `reviews`
  table and ignores an id it already has.
- **Undo** removes the entry: dropped from the queue if not yet sent, otherwise deleted on the server.
- **Deleting a card or deck** deletes its entries (the delete prompt already promises this).
- **Anki imports** bring in Anki's review history (revlog) as entries for the imported cards,
  including Anki's answer times. Fields Anki doesn't have are left null.
- **Given decks.** Each person's answers are logged under their own account.

## Approaches

1. **Separate add-only list, synced alongside cards (chosen).** Small sync payloads, works offline,
   and entries are never rewritten.
2. **History inside each card's progress.** Rejected: every sync resends the whole history and it
   runs into the progress size limit.
3. **Server derives entries from schedule changes.** Rejected: loses answer duration and the exact
   times of answers given offline.

## Non-goals

- Showing the log in the app, or adding it to the backup download.
- Fitting FSRS weights from it (the next piece of work).
- Backfilling answers given before this ships.

## Anti-goals

- Slowing down answering or syncing noticeably.
- Losing an entry when offline, or double-counting one when a sync is retried.
- An undone answer staying in the log.

## Left to the builder

- Exactly where `duration` starts (when the card's front is shown in the study screen) and whether
  a hidden tab pauses it; the 60-second cap makes this low-stakes.
- Server limits on entries per sync and field validation, in the style of `server/sync.js`.
- Table indexes (by user and card, by user and time).
