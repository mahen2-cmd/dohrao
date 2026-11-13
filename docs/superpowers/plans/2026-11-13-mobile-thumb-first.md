# Thumb-first Phone Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dohrao's phone layout (≤640px) thumb-first, as in mockup row A, with swipe to rate and a select-mode toolbar. The desktop layout stays pixel-identical.

**Architecture:**
- Each screen keeps one render function in `js/app.js`.
- The phone layout lives in the `@media (max-width: 640px)` CSS. Phone-only markup is added once and hidden on wide screens with the existing `phone-only` / `wide-only` classes.
- The decisions that are pure logic go in a new tested module, `js/phone.js`: swipe direction, which cards a deck tab lists, how many weeks of activity to show.
- `isPhone()` is the only width check in JS. It re-renders when the breakpoint is crossed.

**Tech Stack:** Plain ES modules, no build step, `node --test`. Visual checks use Playwright (`playwright-core` in the scratchpad, not a project dependency).

**Spec:** `docs/superpowers/specs/2026-11-13-mobile-thumb-first-design.md` (mockups: https://claude.ai/artifact/9wGnnF38E95wPrtSbKSrao, row A plus C4 and D2)

## Global Constraints

- Phone breakpoint: exactly `max-width: 640px`. Above it, every screen must look and behave as on `main`.
- No new dependencies; plain HTML/CSS/JS, no build step.
- Use the existing CSS tokens only (DESIGN.md "Night minimal"); light and dark both checked.
- Touch targets ≥ 44px on the phone. Sheet rows ≥ 48px. Show answer is 56px tall, rating buttons 72px tall, and Good is about 1.35× the width of the others.
- `prefers-reduced-motion`: no card movement or tilt during a swipe.
- Read-only (given) decks hide Add, Edit, Delete, Topic and Reserve edits exactly as today.
- Keyboard shortcuts unchanged everywhere.
- UI copy is plain, short English (PRODUCT.md voice). Exact strings below are fixed by the spec.
- Work on branch `mobile-thumb-first`, never on `main`.

## Review Focus

1. **Wide equation on a phone:** a horizontal drag that starts on a `.katex-display` scrolls it and never rates. Covered in Task 7 (`canSwipeFrom` test) and Task 9 (touch check).
2. **Long answer:** the rating buttons stay on screen, and a vertical drag scrolls rather than rating Easy/Hard. Covered in Task 6 (layout) and Task 7 (`verticalAllowed:false` test).
3. **Rotation or resizing across 640px mid-task:** select mode, the chosen tab and desktop `filters` survive, and the desktop list is unchanged by the phone tab. Covered in Task 1 (`tabFilters` never mutates) and Task 9 (resize check).
4. **Read-only deck on a phone:** no + in the docked bar, no To reserve / Topic / Delete in the select toolbar, no Edit / Delete in the study sheet. Covered in Tasks 4–6 checks with a given deck.
5. **Tap to reveal on interactive content:** tapping the speak button, a link or an image inside the card does not reveal. Covered in Task 6 (`isRevealTap` check).

---

### Task 0: Branch and desktop baseline

**Files:**
- Create (outside the repo): `$S/shot/shoot-all.mjs`, with `$S` = `/tmp/claude-1000/-home-mahenmughal-Ludo-Recall/9b4411f6-cf56-4367-ae47-aea582495031/scratchpad`

The scratchpad already has `$S/shot` (`playwright-core` installed) and `$S/data-copy` (a copy of `data/` with user `mock` / `mockpass123`). The chromium binary is `~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`.

- [ ] **Step 1:** `git switch -c mobile-thumb-first`. Commit the spec and this plan: `git add docs/superpowers && git commit -m "Plan the thumb-first phone layout"`.
- [ ] **Step 2:** Write `shoot-all.mjs <outDir> <port>`.
  - It logs in, then screenshots at **1280×800 and 390×844, in light and dark**: Home, Deck (Portuguese A1), Study front, Study back (press Space), Stats, Upcoming.
  - It saves `<outDir>/<width>-<scheme>-<screen>.png`.
- [ ] **Step 3:** Write `$S/shot/diff.mjs <baseDir> <newDir>`. It byte-compares every `1280-*.png` present in both folders and prints `same` or `DIFFERENT: <names>`.
- [ ] **Step 4:** Start the server with `PORT=5199 RECALL_DATA=$S/data-copy node server.js` in the background. Run `node $S/shot/shoot-all.mjs $S/base 5199`.
  - Expected: 24 PNGs in `$S/base`. These are the desktop reference for every later task.
  - Run the harness a second time into `$S/base2`. `diff.mjs $S/base $S/base2` must print `same`. If it doesn't, the time-of-day greeting or the clock differs between runs: freeze `Date.now` in the harness with `page.clock.setFixedTime` before going on.

---

### Task 1: `js/phone.js`, the pure decisions

**Files:**
- Create: `js/phone.js`
- Test: `tests/phone.test.js`

**Interfaces:**
- Produces:
  - `PHONE_QUERY = '(max-width: 640px)'`
  - `HEAT_WEEKS = { phone: 16, wide: 53 }`
  - `tabFilters(filters, tab) -> filters`: `tab` is `'cards' | 'reserve' | 'topics'`. Returns a new object and never mutates its input.
  - `inTab(card, tab) -> boolean`
  - `classifySwipe({ dx, dy, width, height, verticalAllowed }) -> 1|2|3|4|null`, using the `Rating` values from `js/fsrs.js`.
  - `swipeLeaning({ dx, dy, verticalAllowed }) -> 1|2|3|4|null`: the direction of the drag ignoring the threshold, used for the stamp preview.
  - `SWIPE = { x: 0.30, y: 0.22 }`

- [ ] **Step 1: Write the failing tests**

```js
test('the Reserve tab lists the reserve in pull-in order, whatever the filters', () => {
  const f = { ...NO, groups: ['due'], sort: 'newest' };
  assert.deepEqual(tabFilters(f, 'reserve'), { ...NO, groups: ['reserve'], sort: 'reserve' });
  assert.deepEqual(f, { ...NO, groups: ['due'], sort: 'newest' }); // not mutated
});
test('the Cards tab drops the reserve chip and keeps the other filters', () => {
  assert.deepEqual(tabFilters({ ...NO, groups: ['due', 'reserve'], sort: 'due' }, 'cards').groups, ['due']);
  assert.equal(inTab({ reserved: true }, 'cards'), false);
  assert.equal(inTab({ reserved: false }, 'cards'), true);
  assert.equal(inTab({ reserved: true }, 'reserve'), true);
});
test('a swipe past the threshold rates; short of it, nothing', () => {
  const box = { width: 300, height: 500, verticalAllowed: true };
  assert.equal(classifySwipe({ ...box, dx: 95, dy: 10 }), Rating.Good);
  assert.equal(classifySwipe({ ...box, dx: -95, dy: 10 }), Rating.Again);
  assert.equal(classifySwipe({ ...box, dx: 5, dy: -115 }), Rating.Easy);
  assert.equal(classifySwipe({ ...box, dx: 5, dy: 115 }), Rating.Hard);
  assert.equal(classifySwipe({ ...box, dx: 80, dy: 0 }), null);
});
test('the axis that moved more decides, and vertical can be switched off', () => {
  const box = { width: 300, height: 500 };
  assert.equal(classifySwipe({ ...box, verticalAllowed: true, dx: 100, dy: 120 }), Rating.Hard);
  assert.equal(classifySwipe({ ...box, verticalAllowed: true, dx: 130, dy: 120 }), Rating.Good);
  assert.equal(classifySwipe({ ...box, verticalAllowed: false, dx: 5, dy: 200 }), null);
  assert.equal(classifySwipe({ ...box, verticalAllowed: false, dx: 100, dy: 120 }), Rating.Good);
});
```

`NO` is a copy of `NO_FILTERS` from `js/app.js`: `{ groups: [], due: 'any', added: 'any', lapses: 'any', topics: [], sort: 'newest' }`.

- [ ] **Step 2:** `node --test tests/phone.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `js/phone.js`.**
  - In `classifySwipe`: when `verticalAllowed` is false, treat `dy` as 0. The dominant axis is the larger of `|dx|` and `|dy|`. That axis must pass `SWIPE.x * width` or `SWIPE.y * height`.
  - Directions: right Good, left Again, up Easy, down Hard.
- [ ] **Step 4:** `npm test`. Expected: all PASS.
- [ ] **Step 5:** Commit: `Add the phone layout's tested decisions: tab filters and swipe direction`.

---

### Task 2: Width awareness, bottom sheets, and which bars show

**Files:**
- Modify: `js/app.js` (`menu()` near line 102, `accountMenu()`, `topbar()`, `render()` near line 3462)
- Modify: `css/styles.css` (the `max-width: 640px` blocks)

**Interfaces:**
- Consumes: `PHONE_QUERY` (Task 1)
- Produces:
  - `isPhone() -> boolean` in `js/app.js`
  - CSS class `screen-drill` on the page root of Deck and Study, which hides `.topbar` and its tab bar on a phone
  - every `details.menu[open]` on a phone renders as a bottom sheet, with a backdrop `.sheet-backdrop`

- [ ] **Step 1:** Add `const phoneQuery = matchMedia(PHONE_QUERY); const isPhone = () => phoneQuery.matches;`, with `phoneQuery.addEventListener('change', () => render())`.
- [ ] **Step 2: Sheet CSS** (phone only):
  - `details.menu[open] > .menu-items` becomes `position: fixed; left: 0; right: 0; bottom: 0`, with a rounded top, safe-area padding and rows of at least 48px.
  - `details.menu[open]::before` is a full-screen dim backdrop, so tapping outside closes it through the existing document click handler.
  - Escape closes any open menu: add one `keydown` listener for Escape that removes `open` from `details.menu[open]`.
- [ ] **Step 3: Slim top bar** (phone): hide `.brand`. The page passes its title or greeting into `topbar(title)` as a new optional argument; on desktop the argument renders nothing.
  - Add `screen-drill` to the `.page` of `renderDeck` and to `.study`.
  - On a phone, `.screen-drill .topbar` is `display: none`.
- [ ] **Step 4:** Restart the server and run the harness into `$S/t2`.
  - Expected: `node $S/shot/diff.mjs $S/base $S/t2` prints `same`. If not, view both and fix until it does.
  - At 390, open the deck ⋯: it shows as a bottom sheet in both themes.
- [ ] **Step 5:** Commit: `On a phone, open menus as bottom sheets and drop the top bar on drill-down screens`.

---

### Task 3: Home

**Files:** Modify `js/app.js` (`todayPanel`, `renderHome`) and `css/styles.css`

- [ ] **Step 1:** In `todayPanel`, add a `phone-only` line under the headline: `` `${reviewed} reviewed today · ${streak}-day streak · ${tomorrow} tomorrow` ``. The `.today-figures` strip becomes `wide-only`.
- [ ] **Step 2:** Move the start button for the phone into a `phone-only` docked block, `.dock`, fixed above the tab bar.
  - It reads `Start review · ${due}`, with the existing "first, then N more decks" line under it.
  - The existing `.today-go` becomes `wide-only`.
  - The block is rendered only when `first` exists.
- [ ] **Step 3:** In the deck list heading, add a `phone-only` **+** `menu('New deck or import', [New deck, Import from Anki])`, reusing the existing handlers. The two wide buttons become `wide-only`.
- [ ] **Step 4: Deck rows on a phone** (CSS only, plus one `phone-only` element):
  - `.deck` is a ruled row, not a box.
  - Hide `countPills` and `.deck-actions`.
  - Add a `phone-only` right side: today's due total with a state dot (or "Done" when `c.total === 0`), then a chevron icon.
  - The meta line on a phone is `${cards} cards · ${tomorrow} tomorrow`; the reserve part is hidden with a `wide-only` span.
  - Add bottom padding to the list so the dock never covers the last row.
- [ ] **Step 5:** Harness into `$S/t3`. Expected: 1280 identical to base, and 390 matches mockup A1 in both themes.
- [ ] **Step 6:** Commit: `Thumb-first home on a phone: docked start, deck rows, + for new decks`.

---

### Task 4: Deck page, tabs and docked bar

**Files:** Modify `js/app.js` (`renderDeck`, `drawList` around lines 2010–2200) and `css/styles.css`

**Interfaces:**
- Consumes: `tabFilters`, `inTab` (Task 1), `isPhone()` (Task 2)
- Produces: module state `let deckTab = 'cards'`, reset in the same block that resets `filters` when `filtersDeck !== deck.id`

- [ ] **Step 1:** Make `drawList` use `isPhone() ? tabFilters(filters, deckTab) : filters`. On a phone it also drops cards where `!inTab(card, deckTab)`.
- [ ] **Step 2: `phone-only` segmented control.**
  - Labels: `Cards ${n}`, where n is the cards not on reserve; `Reserve ${c.reserve}`; and `Topics`, shown only when `hasTopics || editable`.
  - Tapping a tab sets `deckTab` and calls `render()`.
  - Use `role="tablist"` / `role="tab"` / `aria-selected`.
- [ ] **Step 3: What each tab shows, via a `data-tab` attribute on `.page` plus CSS** (phone only):
  - Cards: the search toolbar and chips. The "On reserve" chip is hidden, and so is the reserve bar.
  - Reserve: the reserve bar and the list, with no chips.
  - Topics: a `phone-only` section with the following, and no list:
    - three buttons: "Choose what to study" (`openTopicPicker`), "Manage topics…" (`openTopicsDialog`), and "Sort this deck into topics" when today's page offers it;
    - one row per topic from `topicOptions(deck, topicTotals(deck, now))`, showing name and count. Tapping a row sets `filters.topics = [value]` and `deckTab = 'cards'`.
- [ ] **Step 4: Filter and sort button.** On a phone, `sortBar(deck)` collapses behind a single "Filter and sort" icon button next to search. It toggles an `open` class on the sort bar. The chips become one row with `overflow-x: auto; white-space: nowrap`.
- [ ] **Step 5: `phone-only` docked bar `.dock`** at the bottom:
  - a square **+** (`openCardDialog({ deckId })`, only when `editable`), then `Study ${c.total}` as a primary link to `#/study/${id}`;
  - when `(deck.topics ?? []).length`, a line above it: `Studying: ${filterLabel(deck, deck.studyFilter)} ›`, opening `openTopicPicker(deck)`;
  - when nothing is due, the Study button is disabled and reads "Nothing due".
  - The header's Add card, topic-pick and Study become `wide-only`.
- [ ] **Step 6:** Harness into `$S/t4`, plus extra shots for the Reserve and Topics tabs.
  - Expected: 1280 identical to base, and 390 matches mockup A2.
  - With a read-only deck there is no + (check by setting a deck's owner in the data copy, or by sharing one through admin).
- [ ] **Step 7:** Commit: `Deck page on a phone: Cards, Reserve and Topics tabs with a docked Study bar`.

---

### Task 5: Select mode toolbar

**Files:** Modify `js/app.js` (the bulk row in `drawList`, around the `selected.size > 0 &&` block) and `css/styles.css`

- [ ] **Step 1: Turn the bulk row into a fixed bottom toolbar on a phone** with CSS on its existing container, adding a class `bulk` if it has none.
  - Each button shows an icon over a short label: Pull in, To reserve, Topic, Reversed, Delete. Delete is styled danger.
  - Their existing `onclick`s, confirmations and visibility conditions stay unchanged.
  - The `.dock` is hidden while `selected.size > 0`, using a `selecting` class on `.page`.
- [ ] **Step 2:** On a phone, the existing "N selected" checkbox line and Cancel become one slim line above the list: `2 selected · Select all · Cancel`. On the Reserve tab, the Up / Down / To top / To bottom buttons fold into a `menu('Move', …)` sheet in the toolbar.
- [ ] **Step 3: Long-press on `.card-row` ticks it** (phone only).
  - Use `pointerdown` with a 450ms timer, cancelled on `pointermove` beyond 8px, on `pointerup` or on `pointercancel`. Then call `pick([card.id], true)`.
  - Set `draggable` to `false` on rows when `isPhone()`.
- [ ] **Step 4:** Harness with two cards ticked into `$S/t5`. Expected: 1280 identical to base, and 390 matches mockup D2's toolbar in both themes. A read-only deck shows no To reserve, Topic or Delete.
- [ ] **Step 5:** Commit: `Select mode on a phone: bottom toolbar, long-press to tick, Move sheet for the reserve`.

---

### Task 6: Study layout, tap to reveal

**Files:** Modify `js/app.js` (`renderStudy`, `reveal`) and `css/styles.css`

**Interfaces:**
- Produces:
  - `isRevealTap(target, card) -> boolean`: false when `target.closest('button, a, input, textarea, select, img, .katex-display, [contenteditable]')` lies inside `card`;
  - the `.flashcard` element is the swipe surface for Task 7;
  - the CSS custom property hook `--swipe-x` / `--swipe-y` / `--swipe-rot` on `.flashcard`.

- [ ] **Step 1: Top bar on a phone.**
  - Shows: ×, then a middle block with the deck name (plus the topic label when filtered) and `${session.done + 1} of ${total}` over the progress bar, then a `phone-only` `menu('Card options', [Edit card, Replay audio, Delete card])`. The menu reuses `openCardDialog`, `speakSideOf` for the shown side, and `removeCard`, with Delete card styled danger.
  - The menu's Edit and Delete appear only when the deck is editable.
  - The counts pills, the status mark and `.tools` become `wide-only`.
- [ ] **Step 2: Layout on a phone.**
  - `.study` is a column of `height: 100dvh`: a fixed top, the `.flashcard` area with `flex: 1; overflow-y: auto; overscroll-behavior: contain`, then `.answer-bar`.
  - When revealed, the question face is about 22px and muted, and the answer is large.
- [ ] **Step 3: Show answer** is full width and 56px tall. Above it sits the `phone-only` hint "Tap anywhere to show the answer", shown while `localStorage['dohrao.revealHints']` is below 5. That counter is incremented in `reveal()`, with every read and write wrapped in try/catch.
- [ ] **Step 4: Tap to reveal.** Add a `click` listener on `.flashcard` that calls `reveal()` when `!session.revealed && isPhone() && isRevealTap(e.target, flashcard)`.
- [ ] **Step 5: Ratings.** On a phone, `.ratings` is one row: four columns with Good at `1.35fr`, each button 72px tall, and the `kbd` hidden. The ruler sits directly above.
- [ ] **Step 6:** Harness into `$S/t6`.
  - Expected: 1280 identical to base, and 390 matches A3/A4.
  - Also shoot a long card (use the Modern Robotics deck, or edit a card in the data copy to a long multi-paragraph back): the buttons stay visible and the card area scrolls.
- [ ] **Step 7:** Commit: `Study on a phone: tap to reveal, one row of ratings, card options in a sheet`.

---

### Task 7: Swipe to rate

**Files:**
- Modify: `js/app.js` (a new `attachSwipe(flashcard, options, now)` called from `renderStudy` when revealed and `isPhone()`) and `css/styles.css`
- Modify: `js/phone.js` and `tests/phone.test.js` (add `canSwipeFrom`)

**Interfaces:**
- Consumes: `classifySwipe`, `swipeLeaning`, `SWIPE` (Task 1); `.flashcard` and the `--swipe-*` hooks (Task 6); `rate(rating)`
- Produces: `canSwipeFrom(target, { scrollsX, stop }) -> boolean` in `js/phone.js`. `scrollsX(el)` is injected so it stays testable without a DOM, and `stop` is the element where the walk up ends (the flashcard).

- [ ] **Step 1: Failing test.**

```js
test('a drag that starts inside something that scrolls sideways never swipes', () => {
  const eq = { parentElement: null, id: 'eq' };
  const inner = { parentElement: eq };
  assert.equal(canSwipeFrom(inner, { scrollsX: (el) => el.id === 'eq', stop: null }), false);
  assert.equal(canSwipeFrom({ parentElement: null }, { scrollsX: () => false, stop: null }), true);
});
```

`canSwipeFrom` walks `parentElement` up to `stop` (the flashcard) and returns false if any element `scrollsX`.

- [ ] **Step 2:** `node --test tests/phone.test.js`. Expected: FAIL. Implement it, then expect PASS.
- [ ] **Step 3: `attachSwipe`.**
  - Handle only `pointerType === 'touch'`, and only when `canSwipeFrom(e.target, { scrollsX: (el) => el.scrollWidth > el.clientWidth + 1, stop: flashcard })`.
  - `verticalAllowed` is `flashcard.scrollHeight <= flashcard.clientHeight + 1`.
  - Set `touch-action: pan-y` on the card when vertical swipes are off, and `none` when they are on, so scrolling still works.
  - On move:
    - set `--swipe-x` / `--swipe-y` / `--swipe-rot` (dx/20 degrees, capped at 8), unless `matchMedia('(prefers-reduced-motion: reduce)')` matches;
    - show a stamp `.swipe-stamp` reading `` `${LABEL} · ${interval}` `` (for example "GOOD · 10d", the interval from `formatInterval(options[r].due - now)`) once `classifySwipe` returns a rating, and add class `lean` to the ruler mark of the `swipeLeaning` rating.
  - On up: if `classifySwipe` returns a rating, call `rate(rating)`. Otherwise spring back with a 180ms transition back to 0.
- [ ] **Step 4: Touch check.** A scratchpad script `$S/shot/swipe.mjs` uses a CDP `Input.dispatchTouchEvent` drag on the card at 390×844, for each direction, plus one short drag and one drag starting on a wide equation.
  - Expected: Good, Again, Easy and Hard each advance to the next card, and the "N of M" counter goes up by one.
  - The short drag and the equation drag leave the same card shown.
  - Take a screenshot mid-swipe and compare it with mockup C4.
- [ ] **Step 5:** Commit: `Swipe to rate on a phone: right Good, left Again, up Easy, down Hard`.

---

### Task 8: Statistics

**Files:** Modify `js/app.js` (`activityPanel`, `renderStats`) and `css/styles.css`

- [ ] **Step 1:** Change `activityPanel(s, today, deck)` so that `WEEKS = isPhone() ? HEAT_WEEKS.phone : HEAT_WEEKS.wide`.
  - The sub line says "in the past year" on desktop (unchanged) and "in the last 16 weeks" on a phone.
  - The admin call at line 3423 keeps working.
- [ ] **Step 2:** On a phone, the four figures are a 2×2 grid of small tiles, the deck `select` is a pill at the top right next to the title, and the activity grid fits the width with no sideways scroll.
- [ ] **Step 3:** Harness into `$S/t8`. Expected: 1280 identical to base, and 390 matches A5 in both themes.
- [ ] **Step 4:** Commit: `Statistics on a phone: 2×2 figures and 16 weeks of activity`.

---

### Task 9: Whole-branch check

- [ ] **Step 1:** `npm test`. Expected: all PASS.
- [ ] **Step 2:** Run the harness into `$S/final`.
  - Every 1280 shot must be identical to `$S/base`.
  - View every 390 shot, light and dark, next to its mockup.
- [ ] **Step 3: Resize check** (Playwright `setViewportSize` 390 → 1280 → 390):
  - on the deck page, with the Reserve tab chosen and a card ticked, the desktop list shows the desktop filters unchanged;
  - back on the phone, the Reserve tab and the selection are still there.
- [ ] **Step 4:** Check 641px and 760px widths: nothing is broken between the phone layout and the 760px home tweaks.
- [ ] **Step 5:** Update README's phone notes if it describes the phone layout. Commit any fixes.
- [ ] **Step 6:** Stop only the scratchpad server: find its PID on port 5199 and check its `RECALL_DATA` points at `$S/data-copy` before killing it.
