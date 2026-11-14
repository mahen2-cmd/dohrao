# Hidden decks

## Intent

The admin makes some decks only to give them to friends and family. They are never studied by the admin, and they clutter the home page's deck list. Hiding a deck puts it out of the way in a folded section at the bottom of the list, from where it can be shown again.

## Goals

- A **Hide deck** action on each deck row of the home page.
- Hidden decks move to a folded **Hidden · N** section at the bottom of the deck list, closed by default. Opened, it lists each hidden deck with its name, card count and a **Show** button. The deck name still opens the deck page.
- Hidden decks drop out of the home page's today panel: the headline count, **Start review** and its "first, then N more" line, and "due tomorrow".
- The choice is the user's own and follows them between devices.

## Non-goals

- No change to the deck page, Stats, Upcoming, the study screen or the Admin page. A hidden deck is still opened, edited, studied (by going to it) and given away as now.
- No automatic hiding of decks given to others (approach B, below).

## Anti-goals

- Hiding must never change anything for the people a deck was given to.

## Approaches

- **A. Hide each deck by hand (picked).** One action per deck. Never guesses wrong, and also works for any deck you want out of the way for a while.
- **B. Decks given to others hide themselves.** No clicks, but it hides decks you both give away and study (the Portuguese deck), so it needs a per-deck override, which brings back A.
- Storing the choice in the browser only was dropped: it would not follow you between phone and desktop.

Picked A.

## Design

- **Storage:** a `hidden: true` field on the deck, absent when shown. It is not in `DECK_SHARED` (`server/fields.js`), so it is saved per user in `deck_prefs` and synced like the other personal deck settings, with no new server route. It works on given decks too: a recipient can hide a deck given to them.
- **Giving a deck:** `giveTo` (`server/admin.js`) copies the owner's deck prefs to a new recipient; it must drop `hidden` from the copy, so a hidden deck arrives shown.
- **Home page** (`renderHome`, `js/app.js`): split decks into shown and hidden. `todayPanel` gets the shown decks only. The **Hide deck** icon button sits in the row's actions next to Deck settings; on a phone it is reached the same way the other row actions are. The hidden section uses a native `<details>` with the summary "Hidden · N" and is left out when nothing is hidden. Hiding or showing re-renders and shows a short toast ("Hidden “X”." / "“X” is back in your decks.").
- **Every deck hidden:** the today panel reads as for no cards due, and the deck list shows only the folded section.

## Left to the builder

- Exact icon for Hide (an eye-off icon in the existing icon set's style) and how the row actions fit at phone width.
- Whether the section's open/closed state is remembered (localStorage is fine; closed by default).
- Tests: `store` hide/show round trip, today totals ignoring hidden decks, `giveTo` dropping `hidden`.
