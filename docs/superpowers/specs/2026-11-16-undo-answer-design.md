# Undo an answer

A small change. Agreed in conversation on 2026-11-16.

## Why

Sometimes a card gets Good when it should have had Again: a slip of the finger or a key. Today
there is no way back; the card is scheduled weeks out and the mistake stands. The user wants to
take back the last answer and give it again, from a button and from Ctrl+Z.

## What it does

- **Undo restores the card exactly** as it was before the answer (schedule, state, reps, lapses,
  `introduced`, everything), and the study screen shows that card again **with its answer already
  revealed**, so the right rating is one key or tap away.
- **Several steps back.** Each undo takes back one answer; pressing it again goes further back
  through the answers given in this study session. Leaving the study screen (or switching deck)
  clears the history.
- **Where.** An Undo icon button in the study screen's top bar, on desktop and phone, shown only
  when there is an answer to undo. Ctrl+Z, and Cmd+Z on a Mac, do the same.
- **Counts.** Answering an undone card again does not add another review to the day's total, so
  the streak and daily count stay right. The Again/Hard/Good/Easy breakdown on the Statistics page
  keeps the mistaken answer (one Good that should have been an Again). This is accepted.

## Non-goals

- Undo outside the study screen (deleting a card, editing, moving decks).
- Undo that survives leaving the session or reloading the page.
- Correcting the per-button breakdown in statistics.

## Constraints

- State lives in the browser and syncs to the server (`js/store.js`). The server merges `daily`
  and `log` counts by keeping the larger value, so a count can never be lowered by a client. Undo
  therefore never lowers counts; it only avoids counting the re-answer.
- A card's own fields sync as a whole card, so restoring the card object syncs like any other edit.

## Approaches

1. **Snapshot stack in the browser (chosen).** Before each answer, keep a copy of the card; undo
   puts the copy back and marks the card so its next answer is not counted again. Small, needs no
   server change, and restores the schedule exactly.
2. **Keep a review log and replay it.** The app has no per-review log; adding one is far more work
   for the same result here.
3. **Let the server lower counts.** Would make the statistics breakdown exact, but means changing
   how counts merge across devices. Too big for this; the breakdown error is accepted instead.

## Left to the builder

- The icon (an anticlockwise arrow), its tooltip text ("Undo last answer (Ctrl+Z)"), and how the
  undo history is held (module-level in the study session state is fine).
- Whether swiping on a phone needs anything extra: it calls the same rate function, so it should
  be covered.
- Ctrl+Z must not fire while typing in a text field or with a dialog open, matching the existing
  study key handler.
