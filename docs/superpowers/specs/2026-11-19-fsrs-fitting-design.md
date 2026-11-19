# Fitting FSRS to a deck's answers

A mid-sized change. Agreed in conversation on 2026-11-19.

## Why

FSRS-6 and FSRS-7 run on default weights averaged over many people. Fitted to one person's own
answers, they predict that person's recall better, which is the cheapest accuracy gain left.
The review log (live since 2026-11-19) now records the answers a fit needs. The user wants it
built now and used once enough answers have built up, with a counter showing how close each
deck is.

## What it does

- **One set of weights per deck, per person.** A deck is fitted only from that person's answers
  to that deck's cards. Decks never share weights. People given a deck fit from their own answers.
- **Counter, in deck settings under Scheduling:** "Answers ready for fitting: 340 of 1,000". It
  counts this person's logged answers on this deck's cards whose whole history is in the log
  (the card's first logged answer has state New). Cards first studied before the log existed
  don't count.
- **Fit to my answers** button beside it, disabled below 1,000 usable answers.
- **A fit** runs on the server with the official optimizer (`@open-spaced-repetition/binding`),
  fitting FSRS-6 (21 weights) and FSRS-7 (34 weights) from the same answers. Each new set is
  scored against the deck's current set for that model (fitted, imported from Anki, or the
  defaults) on the same answers, by log loss; it is kept only if it scores better. The result
  is shown: "Fitted. Predictions are 12% more accurate on your answers." or "Kept the current
  weights; the fit wasn't better."
- **Where weights live:** the deck's personal settings: `fsrsParams` (FSRS-6, already used by
  Anki imports) and a new `fsrs7Params`. The FSRS-7 scheduler uses `fsrs7Params` when present.
- **Reset to defaults** link, shown when the deck has fitted weights, clears both.
- **Only on request.** Nothing fits automatically.

## Approaches

1. **Official optimizer on the server (chosen).** Same code Anki's ecosystem uses, supports
   FSRS-7, native build for the server; phones download nothing.
2. **Official optimizer in the browser (WASI).** Works offline, but a large download and slow
   on phones.
3. **Write our own optimizer in JS.** No dependency, but would not match the reference fitting
   (pretraining, clipping, regularisation) and is a lot of work.

Per-person-across-all-decks weights were offered (more data sooner, Anki's default) and declined:
the user wants decks kept separate.

## Non-goals

- Fitting all decks with one button, automatic re-fitting, or suggesting a retention target.
- Using answers from before the log started.

## Anti-goals

- Replacing weights with a fit that predicts worse.
- A deck's fit using any other deck's answers, or another person's.
- Freezing the server for other people while a fit runs.

## Left to the builder

- Converting log entries to the optimizer's input (per-card review sequences, elapsed days as
  the optimizer expects for each model), and which entries to drop (undone ones are already gone).
- How the server keeps a fit from blocking other requests (async API or worker thread).
- Exact wording of errors (no usable answers, optimizer failure).
