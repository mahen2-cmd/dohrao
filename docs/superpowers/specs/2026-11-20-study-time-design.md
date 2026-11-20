# Study time

A mid-sized change. Agreed in conversation on 2026-11-20.

## Why

Each person wants to see how long they really study: today's total, the trend over weeks, and
which decks the time goes to. Only time spent working through cards counts. A hidden tab, another
app, or sitting idle must not.

## What it does

- **Active-time clock in the study screen.** It runs while a card is shown and stops when:
  - the tab is hidden (`visibilitychange`) or the window loses focus (`blur`), which covers
    switching apps;
  - you are idle: no tap, key, scroll, pointer move or touch for 30 s plus about 1 s per 4 words
    on the shown side(s) of the card, capped at 3 min in total. Once idle is detected, the time
    since your last input is taken back out, so time away never counts. Any input restarts it.
- **Kept per day and deck.** When a card is rated, its active time is added to a new
  `time[day][deckId]` (whole seconds) in the synced state, next to the answer counts in `log`.
  It is merged across devices and cleaned on the server the same way `log` is.
- **On the review-log entry too.** Each answer also gets an `active` field (ms, uncapped apart
  from the idle rule; server validation allows up to the 3-minute idle cap times a sane limit).
  `duration` is left unchanged for FSRS fitting. Anki-imported entries have `active: null`.
- **Undo keeps the time.** The time was really spent; a re-answer adds its own.
- **Where it shows:**
  - Today panel: "18 min studied" beside reviewed today and the streak (phone line and desktop
    figures).
  - Statistics summary: a "studied today" figure and the total for the chosen period.
  - Statistics "Study time" chart, following the deck picker and period buttons and using the
    period's existing bins: days for 1 month, weeks for 3 months, months for 1 year.
  - Statistics "Time by deck" table for the chosen period, largest first, existing decks only
    (the overall total still includes deleted decks' time).
- **Every user** gets this; each person's time is their own, given decks included.

## Approaches

1. **Measure active time per answer, sum it into per-day per-deck totals (chosen).** Reuses the
   answer path and the synced `log`-style state; no new table or sync path.
   Trade-off: time on a card never rated (e.g. reading the last card and closing the tab) is lost,
   usually seconds per session.
2. **A separate synced log of active-time chunks.** Catches every second, but needs a new table,
   sync, offline queue, undo and delete rules. Rejected as roughly double the work for those few
   seconds.
3. **Use the existing `duration`.** Rejected: it can't pause, so it counts tabbed-away time.

Note: the browser only holds review-log entries made since load (the server keeps the full log),
so the totals live in `time`, not in sums over the log.

## Non-goals

- Backfilling time from before this ships, or estimating it from Anki imports.
- Goals, reminders, or comparisons between users.
- Counting time on screens other than studying (browsing, editing cards).

## Anti-goals

- Counting time with the tab hidden, the app in the background, or nobody at the device.
- Slowing answering or noticeably growing sync payloads.

## Left to the builder

- Exact event list and throttling for input detection; how words are counted for math/Urdu cards.
- Two devices studying the same deck on the same day merge by maximum, as `log` counts already do.
- Chart and table styling in line with the existing Statistics panels; time formatting
  ("45 s", "18 min", "2 h 5 min").
