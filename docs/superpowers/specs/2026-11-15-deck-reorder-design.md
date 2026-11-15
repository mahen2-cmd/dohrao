# Reordering decks by drag

## Intent

The admin wants to arrange the decks inside each folder in their own order (e.g. Reinforcement Learning chapters 1, 2, 3 …) by dragging them on the home page. This is a personal arrangement, like folders.

## Goals

- On a desktop, drag a deck row onto another deck row to place it just before or after that row, decided by which half of the row it's dropped on. A drop line shows where it will land.
- This works within a folder and within the loose list.
- Dropping onto a row in a different folder (or the loose list) moves the deck there, at that position.
- Dropping on a folder heading keeps today's behaviour: the deck is filed into the folder, at the end.
- The order follows the person between devices, and survives reloads.

## Non-goals

- Reordering the folders themselves.
- Reordering on phones. Phones have no drag; filing decks in Deck settings stays as is.
- Reordering hidden decks.
- Any change for people a deck was given to.

## Anti-goals

- Reordering must never change a deck's folder unless the deck was dropped into a different group.
- Reordering must never change anything another user sees.

## Approaches

- **A. Personal deck pref `homeOrder` (picked).** It's a number, stored in `deck_prefs` like `folder`. It syncs, it's personal, and it needs no new server route.
- **B. An ordered id list per folder in settings.** Dropped: it duplicates membership, which `folder` already holds, and it falls out of step when decks are added or removed.

## Design

- **`homeOrder`:** a finite number in the personal deck prefs.
  - `homeGroups` sorts each group (every folder's decks, and the loose decks) by `homeOrder`. A deck without one sorts after those with one, keeping its current relative order (a stable sort).
- **`reorderDecks(ids)` in the store:** writes `homeOrder` 0, 1, 2… to the given deck ids, in that order, and saves.
  - The UI calls it with the target group's full new order.
- **Server:** prefs validation accepts `homeOrder` only as a finite number; anything else is rejected, like the other pref checks. `giveTo` drops `homeOrder` from the prefs it copies to a new recipient, as it does `folder` and `hidden`.
- **UI** (`js/app.js`):
  - Deck rows are already draggable on wide screens. Add `dragover` and `drop` on each row.
  - While dragging over a row, compute above or below from the pointer's position against the row's middle, and show a drop line with a `drop-before` or `drop-after` class.
  - On drop:
    - if the target row's group differs from the dragged deck's, call `setDeckFolder` to the target's folder (or `null` for loose);
    - build the target group's id list with the dragged deck inserted at the chosen spot;
    - call `reorderDecks`, then `render()`.
  - Dropping on a folder heading appends: it sets the folder, then `homeOrder` = max in that folder + 1.
  - Dragging over the deck itself does nothing.

## Left to the builder

- The drop line's exact styling, matched to the existing drop-target highlight.
- Reusing the existing dragged-deck state.
