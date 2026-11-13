# Desktop Deck Page: Reserve Beside the Cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On screens 900px and wider, the deck page shows the reserve in its own left column (with Pull in always in view and a preview of what it takes) beside the cards being studied, and moves rarely used controls behind ⋯.

**Architecture:** The card list inside `renderDeck` (`js/app.js`) becomes a reusable `cardList(deck, view, ...)` that draws one of three views: `'all'`, `'cards'` or `'reserve'`. The phone already splits the cards this way with `tabFilters`/`inTab` (`js/phone.js`). On desktop the page draws the `'reserve'` and `'cards'` views side by side. A new deck-page-only media query (`(max-width: 899px)`) puts the tabs on 641–899px windows. Pure decisions (the preview, the amount, labels) go in a new tested module, `js/deckpage.js`.

**Tech Stack:** Plain ES modules, no build step; `node --test` (`npm test`); CSS in `css/styles.css`.

**Spec:** `docs/superpowers/specs/2026-11-13-deck-page-desktop-design.md`

## Global Constraints

- Two columns from **900px** wide. Tabs from 641px to 899px, using a new deck-page-only check, not `isPhone()`. At **640px and below, nothing changes**.
- No change to the store, the server, scheduling, or what `store.pullFromReserve` / `store.pullCards` do.
- No new dependencies. Light and dark themes both work, using existing tokens only.
- Each list draws at most `CARD_PAGE` (200) rows, then "Show N more".
- Read-only decks (`store.editable(deck.id)` false) can pull, but cannot edit, delete, import, reorder or change topics.
- Copy, verbatim from the spec: "Pull in the next N"; "Pull all 1,465"; "Pull all 212 from Verbs"; "Nothing on reserve"; "Studying"; "Reserve"; "pulled in from the top"; "Search all N cards"; "Filter and sort" / "Filters on".
- Every capability listed under the spec's Anti-goals must still be reachable.

## Review Focus

1. **The amount is larger than the chosen topic's reserve** (for example 10 when Verbs has 3 left). Expect the box to clamp to 3, the label to read "Pull in the next 3", and exactly 3 rows tinted. Pinned by the `clampAmount` and `pullPreview` tests in Task 1.
2. **A search hides some of the next N.** Expect the visible rows to keep their real queue numbers, only matching rows among the next N tinted, and Pull in still taking the next N of the whole (topic) queue. Pinned by the `pullPreview` test with a partial match, Task 1, and checked by hand in Task 4.
3. **Ticking in one column while the other has ticks.** Expect each column's bar and actions to count only its own ticked cards. Delete in the studying column must never delete ticked reserve cards. Pinned by the `ownTicks` test, Task 1.
4. **A read-only (given) deck.** Expect no grips, no drag, no Up/Down/To top/To bottom/Delete in the reserve foot, and no Import to reserve, while Pull in and Pull all work. Checked by hand in Task 4, step 6.
5. **Resizing across 899px or 640px** (dragging the window, or rotating a tablet). Expect the page to redraw in the right layout with search, filters and ticks kept. Checked by hand in Task 3, step 6. The new query gets a `change` listener like `phoneQuery`.

---

### Task 1: Pure helpers for the reserve column

**Files:**
- Create: `js/deckpage.js`
- Modify: `js/phone.js` (`tabFilters`)
- Test: `tests/deckpage.test.js`; add one test to `tests/phone.test.js`

**Interfaces:**
- Produces, in `js/deckpage.js`:
  - `export const TABBED_DECK_QUERY = '(max-width: 899px)'`
  - `export function clampAmount(value: number, available: number): number`: a whole number in `[1, available]`, or `0` when `available` is 0. Non-numbers and NaN become `min(available, 10)`.
  - `export function pullPreview(queue: {id: string}[], n: number): { place: Map<string, number>, next: Set<string> }`: `place` maps each card's id to its 1-based position in `queue`. `next` holds the ids of the first `clampAmount(n, queue.length)` cards.
  - `export function pullAllLabel(count: number, topicName?: string): string`: `"Pull all 1,465"`, or `"Pull all 212 from Verbs"` (numbers formatted with `toLocaleString()`).
  - `export function ownTicks(selected: Set<string>, cards: {id: string, reserved?: boolean}[], view: 'all'|'cards'|'reserve'): string[]`: the ids in `selected` whose card is in `cards` and belongs to `view` (by `inTab`; `'all'` takes everything).
- Changes `tabFilters(filters, 'cards')` (in `js/phone.js`) so it also maps `sort: 'reserve'` to `'newest'`.

- [ ] **Step 1: Write the failing tests** in `tests/deckpage.test.js` (same style as `tests/phone.test.js`):

```js
test('the amount stays within what the queue holds', () => {
  assert.equal(clampAmount(10, 3), 3);
  assert.equal(clampAmount(0, 3), 1);
  assert.equal(clampAmount(2.6, 9), 3);
  assert.equal(clampAmount(NaN, 40), 10);
  assert.equal(clampAmount(5, 0), 0);
});

test('the preview numbers every card and marks the next n', () => {
  const q = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const { place, next } = pullPreview(q, 2);
  assert.deepEqual([...place], [['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
  assert.deepEqual([...next], ['a', 'b']);
  assert.deepEqual([...pullPreview(q, 99).next], ['a', 'b', 'c', 'd']);
  assert.equal(pullPreview([], 10).next.size, 0);
});

test('a search keeps real places: shown rows tint only if among the next n', () => {
  const q = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const { place, next } = pullPreview(q, 2);
  const shown = [q[1], q[3]]; // a search matched b and d
  assert.deepEqual(shown.map((c) => [place.get(c.id), next.has(c.id)]), [[2, true], [4, false]]);
});

test('Pull all says how many, and from which topic', () => {
  assert.equal(pullAllLabel(1465), 'Pull all 1,465');
  assert.equal(pullAllLabel(212, 'Verbs'), 'Pull all 212 from Verbs');
});

test('each column acts only on its own ticked cards', () => {
  const cards = [{ id: 'r', reserved: true }, { id: 's', reserved: false }, { id: 'gone', reserved: false }];
  const ticked = new Set(['r', 's', 'x']);
  const shown = cards.slice(0, 2);
  assert.deepEqual(ownTicks(ticked, shown, 'reserve'), ['r']);
  assert.deepEqual(ownTicks(ticked, shown, 'cards'), ['s']);
  assert.deepEqual(ownTicks(ticked, shown, 'all').sort(), ['r', 's']);
});
```

Add to `tests/phone.test.js`:

```js
test('the Cards tab never sorts by reserve order', () => {
  assert.equal(tabFilters({ ...NO, sort: 'reserve' }, 'cards').sort, 'newest');
});
```

- [ ] **Step 2: Run them and check they fail.** Run `npm test`. Expected: FAIL, because `js/deckpage.js` doesn't exist and the sort test gets `'reserve'`.
- [ ] **Step 3: Implement** `js/deckpage.js` with the five exports above, and the `tabFilters` change. `ownTicks` imports `inTab` from `./phone.js`.
- [ ] **Step 4: Run them and check they pass.** Run `npm test`. Expected: all pass (251 existing plus 6 new).
- [ ] **Step 5: Commit:** `git add js/deckpage.js js/phone.js tests/deckpage.test.js tests/phone.test.js && git commit -m "Add the reserve column's preview, amount and label helpers"`

### Task 2: Make the card list reusable, with no visible change

**Files:**
- Modify: `js/app.js` (`renderDeck` at about lines 1978–2381: the `drawList` closure, `shown`, `limit`, `dragged`, the search input)

**Interfaces:**
- Consumes: `ownTicks`, from Task 1.
- Produces, in `js/app.js`: `function cardList(deck, view, { filters, filtering, editable, hasTopics, now, onPick }): { el: HTMLElement, draw: () => void, count: HTMLElement }`
  - `view` is `'all'` (today's desktop list: every card, today's filters), `'cards'` (`tabFilters(filters, 'cards')`, cards not on reserve), or `'reserve'` (`tabFilters(filters, 'reserve')`, reserve cards only).
  - `el` is the `.deck-cards` element. `count` is the "N of M cards" span. `draw()` redraws from the module-level `query`.
  - Each list keeps its own `limit` and `dragged`. They share the module-level `selected` Set, but a list prunes and acts only on `ownTicks(selected, matches, view)`. Every bulk button, the select-all checkbox and the "N selected" text use that list's own ticks.
- The phone keeps its behaviour by calling `cardList(deck, deckTab === 'reserve' ? 'reserve' : 'cards', …)`. Desktop calls it with `'all'` for now.

- [ ] **Step 1: Move** the `drawList` body into `cardList`, replacing `phone ? … : …` with `view`, and `selected` reads with `ownTicks(...)`. Keep every button, title, `data-short` and text exactly as it is.
- [ ] **Step 2: Wire** the single search input's `oninput` to set `query`, reset each list's `limit` to `CARD_PAGE`, and call each list's `draw()`.
- [ ] **Step 3: Run** `npm test`. Expected: all pass.
- [ ] **Step 4: Check by hand that nothing changed.** Start a local server (`RECALL_DATA=./data node server.js`) and open `http://localhost:5173` at 1280px and 390px wide. On Portuguese A1 or any deck with a reserve, check: search, chips, Filter and sort, tick and Select all, Back to reserve, Choose cards then drag a row, Up/Down/To top/To bottom, Reverse order, Show more, and the Cards/Reserve tabs on the phone. All behave as they do on `main`.
- [ ] **Step 5: Commit:** `git commit -am "Draw the deck's card list from one reusable function"`

### Task 3: Two columns on desktop, tabs from 641 to 899px, a quieter header

**Files:**
- Modify: `js/app.js` (`renderDeck`, `deckTabs`, `deckDock`, and a new `tabbedQuery` next to `phoneQuery` at about line 14)
- Modify: `css/styles.css` (deck page section near `.reserve` at about line 700, and the 640px block)

**Interfaces:**
- Consumes: `cardList` (Task 2), `TABBED_DECK_QUERY` (Task 1).
- Produces:
  - `const tabbedQuery = matchMedia(TABBED_DECK_QUERY); const isTabbedDeck = () => tabbedQuery.matches;` with a `change` listener that calls `render()`.
  - The page markup `div.deck-columns > section.deck-reserve + section.deck-studying`, which Task 4 fills in. The page element gets the class `deck-page`.
  - `function reserveColumn(deck, c, editable, list)`: a stub in this task (heading plus `list.el`), finished in Task 4.

- [ ] **Step 1: Choose the layout in `renderDeck`.**
  - At 899px and narrower (`isTabbedDeck()`): today's tab layout, with `deckTabs` shown (its class changes from `phone-only` to `tabbed-only`, visible at ≤899px). The phone dock stays phone-only, and the header keeps Add card and Study (`wide-only`, meaning >640px).
  - Wider: no tabs and no `reserveBar`. Draw `.deck-columns` with `reserveColumn(deck, c, editable, cardList(deck, 'reserve', …))` and a studying section: heading "Studying" plus its count, a toolbar with the search ("Search all N cards") and the Filter and sort button, the filter panel, and `cardList(deck, 'cards', …).el`.
- [ ] **Step 2: Trim the header.**
  - Body: replace `countPills` and the tomorrow line with one quiet line: due, new, learning, "N tomorrow".
  - Move into the ⋯ menu: Upcoming cards, Statistics, Import from Excel, Topics…, Sort into topics / Sort now (taken from `sortBar`'s conditions, calling `startProposal` / `requestSort`), Deck settings, Delete deck.
  - Keep `sortBar`'s two status messages ("Sorting cards into topics…", "Reading the cards to suggest topics…") as a line under the header. Drop its buttons from the body.
  - Right side, in order: Add card (editable), ⋯, Studying: \<topics\> (with topics), then Study N, or a disabled "Nothing due".
- [ ] **Step 3: Studying column filters.** Drop the `'reserve'` chip from the chips and `'reserve'` from Sort by when drawing for the `'cards'` view. The chips sit inside the Filter and sort panel, which is closed by default on desktop.
- [ ] **Step 4: CSS.**
  - `.page.deck-page { max-width: 1200px }`.
  - `.deck-columns { display: grid; grid-template-columns: 380px minmax(0, 1fr); gap: 28px }`.
  - Show `.tabbed-only` only at ≤899px. Hide `.deck-columns`' reserve section at ≤899px, since the tabs take over there.
  - Check the 640px block still gives the phone exactly today's page.
- [ ] **Step 5: Run** `npm test`. Expected: all pass.
- [ ] **Step 6: Check by hand at 1280, 800 and 390px wide, then drag the window across 899px and 640px.**
  - 1280px: two columns, and the reserve column lists the reserve in order.
  - 800px: the tabs, with Add card and Study in the header and no dock.
  - 390px: identical to `main`.
  - When crossing the breakpoints, search text, filters and ticks are kept.
- [ ] **Step 7: Commit:** `git commit -am "Show the reserve beside the studying cards on a desktop deck page"`

### Task 4: The reserve column: pull in, preview, ticks, empty state

**Files:**
- Modify: `js/app.js` (`reserveColumn`, `cardList` row drawing for `view === 'reserve'`, and module state next to `filters`: `let reserveTopic = ''`, `let pullAmount = null`, both reset where `filtersDeck` changes)
- Modify: `css/styles.css`
- Modify: `README.md` (the reserve section, about lines 170–185)

**Interfaces:**
- Consumes: `pullPreview`, `clampAmount`, `pullAllLabel` (Task 1); `cardList` (Task 2); `topicOptions`, `topicTotals`, `topicLabel`, `store.pullFromReserve`, `store.pullCards`, `store.reverseReserve`, `pickImportFile(deck, true)`, `returnCardsToReserve`, `removeCards`, and the existing `move`/`step`/`toTop` logic inside `cardList`.
- The queue Pull in takes is `store.findCards(deck.id, { groups: ['reserve'], topics: reserveTopic ? [reserveTopic] : [], sort: 'reserve' }, now)`. That matches `pullFromReserve(deck.id, n, now, reserveTopic ? [reserveTopic] : undefined)`, because both use `resolveFilter`/`inFilter`. The reserve view's own list adds `topics: reserveTopic ? [reserveTopic] : []` so the column narrows to the chosen topic.

- [ ] **Step 1: Heading row.** "Reserve", then "N · pulled in from the top", then ⋯ holding:
  - `pullAllLabel(queue.length, topicName)`, only when `queue.length > 1`.
  - Reverse order, only with the whole reserve in view, as today.
  - Import to reserve, editable decks only.
- [ ] **Step 2: Rows.** In the reserve view, each row shows the grip (editable), the checkbox, `place.get(card.id)` as its number, the front and the back. Rows in `next` get the class `next`, and the last `next` row in reserve order also gets `next-last`, which draws the line under it.
- [ ] **Step 3: Foot when nothing in this column is ticked.**
  - The topic select (with topics), built from `topicOptions(deck, topicTotals(deck, now))`. Changing it sets `reserveTopic` and redraws.
  - The number box, with `max = queue.length`. Its value is `clampAmount(pullAmount ?? 10, queue.length)`, and `oninput` sets `pullAmount` and redraws the tint.
  - The primary button "Pull in the next N". It calls `store.pullFromReserve` with the amount and topic, then shows today's toast and calls `render()`.
- [ ] **Step 4: Foot when cards in this column are ticked.** It shows "N selected" and Cancel, then these buttons. Each keeps today's title and does what today's select bar does:
  - Pull in N, using `store.pullCards`.
  - Up, Down, To top and To bottom (editable decks only).
  - Delete (editable decks only).
- [ ] **Step 5: Empty reserve.** Show "Nothing on reserve", the line "Cards on reserve are kept out of study until you pull them in.", and Import to reserve (editable decks only). CSS:
  - `.deck-reserve` is sticky (`top: 16px`), with `max-height: calc(100vh - 32px)` and a flex column.
  - The rows area gets `overflow-y: auto`, and the foot stays pinned.
  - `.next` uses the `--accent-soft` background, and `.next-last` has a 2px dashed `--accent` bottom border.
- [ ] **Step 6: Check by hand at 1280px**, on Portuguese A1 and on a deck given to a second account:
  - Changing the amount moves the tint, and amounts above a topic's count clamp.
  - Choosing a topic narrows the column, and Pull in takes exactly the tinted rows. Compare the toast's count with the rows that disappear.
  - Search "casa" shows real numbers, with tint only where the match is in the next N.
  - Tick 3 reserve and 2 studying cards: each bar counts only its own column's ticks.
  - Drag a row, Up/Down/To top/To bottom, Reverse order and Pull all each work.
  - On the given deck: no grips, no reorder buttons, no Delete or Import, and Pull in and Pull all work.
  - Dark and light themes both look right.
- [ ] **Step 7: README.** Rewrite the "Choose cards" bullets: on a desktop the reserve is a column beside the cards. You tick cards there to pull in just those, drag them or use Up/Down/To top/To bottom to reorder, and the cards Pull in will take are tinted. Keep the phone wording for the Reserve tab.
- [ ] **Step 8: Run** `npm test`. Expected: all pass.
- [ ] **Step 9: Commit:** `git commit -am "Pull in from a reserve column that shows what it will take"`
