# Desktop deck page: the reserve beside the cards

Date: 2026-11-13. Status: design, awaiting approval.

## Intent

On a desktop, the deck page (what you see after opening a deck; `renderDeck` in `js/app.js`) is cluttered. Today it stacks, top to bottom: the header (name, from, New/Learning/Due counts, "N tomorrow · See the days ahead", then ⋯ menu, Add card, topic picker, Study N), the "Sort into topics" line (`sortBar`), the reserve bar (`reserveBar`: icon, two lines of explanation, topic select, number, Pull in, Pull all, Choose cards, Import to reserve), search and count, the group chips and "Filter and sort" with its dropdown row, the select-all/reorder bar, and then the card rows. That's about 20 controls before the first card.

The owner's main job on this page is **pulling cards in from the reserve**. The page should make that the obvious thing to do and keep everything else quiet. This follows the product's principles: calm and minimal ("Night minimal"), with no busy screens.

## Goals

- On a desktop, the reserve and its Pull in are always in view, in a column of their own.
- You can see which cards a pull would bring in before pulling.
- Reordering and picking reserve cards happen in place, with no separate "Choose cards" mode.
- Far fewer controls are on screen at once. Rarely used actions move behind ⋯.

## Non-goals

- No change to the phone layout (640px and narrower). It keeps its Cards / Reserve / Topics tabs, the dock, and the reserve bar fixed earlier today (commit 22bd66e).
- No change to scheduling, to what pulling does (`store.pullFromReserve`, `store.pullCards`), or to the store or server.
- No automatic daily pull and no combined "pull in and study" button. Both were mockups (#8, #19) and neither was chosen.

## Anti-goals

- A two-column page that feels just as busy, with every old control still visible in one of the columns.
- A preview of the next cards that disagrees with what Pull in actually takes.
- Losing any capability that exists today: pull N, pull from a topic, pull all, pick particular cards, drag to reorder, Up/Down/To top/To bottom, reverse order, import to reserve, back to reserve, move to topic, add reversed, delete, filters, sort, search, "show more" paging.

## Constraints

- Plain HTML, CSS and JavaScript, with no build step and no new dependencies.
- Light and dark themes are both first-class. Use the existing tokens in `css/styles.css` / `DESIGN.md`.
- Full keyboard operation. Reordering keeps its keyboard-reachable buttons (Up/Down/To top/To bottom), not drag alone.
- Decks can hold thousands of cards. Each list draws at most `CARD_PAGE` (200) rows, with "Show N more".
- A deck given by the admin is read-only for its recipient (`store.editable(deck.id)` is false). Recipients can still study and pull, but not edit, delete, import, reorder or change topics, as today.

## Approaches considered

1. **Reuse the existing list code for both columns (chosen).** On a phone, the deck page already splits its cards into Cards and Reserve with `tabFilters` and `inTab` (`js/phone.js`). On desktop, the same list-drawing code runs twice, once for the reserve and once for the cards being studied, side by side. Each list keeps its own ticked cards. Phone and desktop share one set of code. The owner picked this.
2. **A separate reserve column written from scratch.** It would leave today's list alone, but it would copy the ticking, dragging, bulk actions and paging, and two copies drift apart. Rejected.
3. **Rearrange today's page with CSS only.** This doesn't work: one list holds both reserve and studying cards, and CSS cannot split it into two columns.

The layout itself was chosen from 20 mockups (#2, "reserve and studying side by side"), with the reserve column doing the whole job (version A) rather than showing a short preview with an "Open queue" link (version B). The mockups are in `.superpowers/brainstorm/8410-1794596933/content/` (`deck-page-20.html`, `deck-page-2A.html`), which is not in git.

## The design

### When it applies

The two-column layout is used from **900px wide** upward. At 640px and below, nothing changes.

From 641px to 899px (Claude's call), the deck page shows the same Cards / Reserve / Topics tabs as the phone, so narrow windows get tabs, not cramped columns. This uses a **new check for the deck page only** ("tabbed deck", up to 899px), separate from `isPhone()`. Everything else keyed on `isPhone()` stays as it is in this range: drag to reorder, the desktop select bar, the header's Add card and Study buttons, no bottom dock, no hold-to-tick, no swipe in study, the full-year calendar. In other words, these are desktop pages that only borrow the tabs.

The deck page can be wider than other pages so that both columns fit (builder's call: about 1200px max for this page only). The other pages keep 1000px.

### Header

Left: back link, deck name, "from …" when given, then one quiet line of counts: due, new, learning, and "N tomorrow".

Right, in order:
- **Add card** (editable decks only).
- **⋯**, holding: Upcoming cards, Statistics, Import from Excel, Topics…, Sort into topics / Sort now (when that applies), Deck settings, Delete deck. Read-only decks see only the items they can use, as today.
- **Studying: \<topics\>** (only when the deck has topics). This is today's topic picker for what Study uses.
- **Study N**, the primary button. It's disabled with "Nothing due" when N is 0.

The separate `sortBar` line and the "See the days ahead" link disappear from the page body. Their actions live in ⋯. The "Sorting cards into topics…" and "Reading the cards to suggest topics…" status messages still need to show while that work runs, as a quiet line under the header.

### Reserve column (left, about 380px)

- **Heading row:** "Reserve", then "1,465 · pulled in from the top", then a small ⋯ holding Pull all, Reverse order (whole reserve only) and Import to reserve (editable only).
- **List:** every reserve card in reserve order (`sort: 'reserve'`), numbered 1, 2, 3… in pull-in order. Each row shows a drag grip (editable only), a checkbox, the number, the front and the back. The list scrolls inside the column, so the column's foot stays in view. Clicking a row opens the card editor (editable only), as rows do today.
- **Preview:** the rows that Pull in would take are tinted, with a line under the last one. They're the first N reserve cards in reserve order that match the chosen topic, which is exactly what `store.pullFromReserve(deckId, n, now, [topic])` takes. The tint updates as the number or topic changes.
- **Topic narrows the list:** choosing a topic in the foot shows only that topic's reserve cards, so the tinted rows are always the top of the visible list.
- **Search and the reserve (Claude's call):** a search narrows the reserve column to matching cards, but each row keeps its real place in the queue (so a search can show 12, 340, 911). Only matching rows that are among the next N stay tinted, and the foot keeps meaning "the next N of the whole reserve (in the chosen topic)", worded as "Pull in the next N". This way the numbers and the tint are never wrong, and `pullFromReserve` is unchanged.
- **Pull all (Claude's call):** Pull all follows the topic chosen in the foot, and its label says so: "Pull all 1,465", or "Pull all 212 from Verbs" when a topic is chosen. The toast reports what was pulled, as today.
- **Foot, nothing ticked:** the topic select (only when the deck has topics, listing each topic's reserve count as today), the number box (1 to the reserve size, default `min(n, 10)` as today), and **Pull in N**.
- **Foot, cards ticked:** "N selected" with Cancel, then **Pull in N** (the ticked cards, in reserve order), **Up**, **Down**, **To top**, **To bottom** and **Delete** (the last five editable only). These do what the existing select-bar buttons do.
- **Drag to reorder:** as today. Dragging a ticked card brings the other ticked cards along.
- **Empty reserve:** "Nothing on reserve", one line saying what the reserve is for, and Import to reserve (editable only). The studying column keeps its width.

### Studying column (right, the rest)

- **Heading row:** "Studying", then the count of cards not on reserve.
- **Tools:** one search box ("Search all N cards") that searches **both** columns, then one **Filter and sort** button. It opens today's chips (New, Learning, Due, Not due yet; the "On reserve" chip is dropped, as on the phone) and dropdowns (Next review, Added, Forgotten, Topic, Sort by; "Reserve order" is dropped from Sort by). The button reads "Filters on" when any are set, with Clear filters inside, as today.
- **List:** today's rows (checkbox, front, back, topic when the deck has topics, status, edit and delete on hover). Paging is the same: 200 rows, then "Show N more".
- **Ticked:** a bar above the list with "N selected", Back to reserve, Move to topic… (with topics, editable), Add reversed (editable), Delete N cards (editable) and Cancel.
- Filters apply to this column only. The reserve column is always the reserve in reserve order, narrowed only by search and its own topic choice.

### What goes away on desktop

- The full-width reserve bar (`reserveBar`), including its explanatory sentence and the box icon.
- The "Choose cards" mode, which switched the list to the reserve in reserve order. The reserve column does that job all the time.
- The "On reserve" chip and the "Reserve order" sort in the studying column's filters.
- The always-visible chips row.

### Behaviour kept exactly

The toasts after pulling ("10 cards pulled in as new cards"), the drag-and-drop rules, the "Reverse order" condition (only with the whole reserve in view), selection being cleared of cards no longer shown, the hold-to-tick on touch, and every title/tooltip on the actions that move.

## Left to the builder

- The exact column width, gaps, and the deck page's max width.
- How the reserve column's height is bounded (for example, sticky to the viewport) so its foot stays in view on long pages.
- How to split the current `drawList` closure so it can draw two lists with separate selections, paging and empty messages, without copying it.
- Whether the reserve column's rows show the topic name; there's room for it if it fits.
- Tests: there are no layout tests today. Pure helpers (for example, "which reserve cards would Pull in take") belong in a module with unit tests, like `js/phone.js`.
