# Hidden Decks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person hide decks from the home page's deck list and today panel, keeping them in a folded "Hidden · N" section at the bottom from which they can be shown again.

**Architecture:** A per-user `hidden: true` deck field, stored in `deck_prefs` like the other personal deck settings (it is not in `DECK_SHARED`, so the existing sync carries it). The store gains `setHidden` and `isHidden`; the server drops `hidden` when copying the owner's prefs to a new recipient; `renderHome` splits decks into shown and hidden.

**Tech Stack:** Plain ES modules, no build step; Node `node:test` for tests (`npm test`); SQLite on the server.

**Spec:** `docs/superpowers/specs/2026-11-14-hidden-decks-design.md`

## Global Constraints

- Hiding never changes anything for the people a deck was given to.
- No change to the deck page, Stats, Upcoming, the study screen or the Admin page beyond the settings-dialog checkbox below.
- UI copy, exactly: button and menu label "Hide deck"; section summary "Hidden · N"; row button "Show"; toasts "Hidden “X”." and "“X” is back in your decks."
- No new dependencies. Light and dark themes both work; works at phone width.

## Review Focus

- **Hiding on a phone:** the row actions (`.deck-actions`) are hidden by CSS below phone width, so the icon button is unreachable there. The phone path is a "Hide deck from the list" checkbox in the Deck settings dialog (Task 3), shown for own and given decks alike.
- **Showing several decks in a row:** every change re-renders the home page; the hidden section must stay open after pressing Show, so its open state is kept in a module variable (not reset by render). Closed on first load.
- **Every deck hidden:** the empty "Create your first deck" state must not appear; the today panel reads "Nothing is due today." / "All caught up for today." and no Start review shows.
- **Showing a deck clears the field** rather than storing `hidden: false`, so a re-shown deck's prefs look as before (Task 1 test).
- **A returning recipient** (re-given a deck) keeps their own prefs untouched; only a first-time give copies the owner's prefs, minus `hidden` (Task 2 test).

---

### Task 1: Store hide/show

**Files:**
- Modify: `js/store.js` (Decks section, after `updateDeck`, ~line 423)
- Test: `tests/store.test.js`

**Interfaces:**
- Produces: `isHidden(deck: object) -> boolean` (true only when `deck.hidden === true`); `setHidden(id: string, hidden: boolean) -> void` (sets `hidden: true`, or deletes the key, then `save()`). Works on given (assigned) decks too: `hidden` is not a shared key.

- [ ] **Step 1: Write the failing tests** in `tests/store.test.js`:

```js
test('hiding and showing a deck', () => {
  const deck = setup();
  assert.equal(store.isHidden(deck), false);
  store.setHidden(deck.id, true);
  assert.equal(store.deck(deck.id).hidden, true);
  assert.equal(store.isHidden(store.deck(deck.id)), true);
  store.setHidden(deck.id, false);
  assert.equal('hidden' in store.deck(deck.id), false);
  assert.equal(store.isHidden(store.deck(deck.id)), false);
});

test('hidden is a personal deck field', () => {
  assert.equal(DECK_SHARED.includes('hidden'), false);
});
```

- [ ] **Step 2: Run** `node --test tests/store.test.js` — Expected: FAIL, `store.isHidden is not a function`.
- [ ] **Step 3: Implement** `isHidden` and `setHidden` in `js/store.js`, with a one-line comment that a hidden deck is the user's own choice, kept per user.
- [ ] **Step 4: Run** `node --test tests/store.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `git add js/store.js tests/store.test.js && git commit -m "Let the store hide and show a deck"`

### Task 2: A given deck arrives shown

**Files:**
- Modify: `server/admin.js` — `giveTo`, the `deck_prefs` copy (~lines 48–51)
- Test: `tests/admin.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 (the server only sees the field in prefs JSON).

- [ ] **Step 1: Write the failing test** in `tests/admin.test.js`, using the file's `seed()`:

```js
test("the owner's hidden choice is not copied to a new recipient", async () => {
  const { db, ana, ben } = await seed();
  applyChanges(db, ana.id, { decks: [{ ...deck, hidden: true }] }, NOW);
  assert.equal(buildView(db, ana.id, NOW).decks[0].hidden, true);
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  const given = buildView(db, ben.id, NOW).decks[0];
  assert.equal('hidden' in given, false);
  assert.equal(given.newPerDay, 15); // other prefs still copied
});

test("a returning recipient's own hidden choice is kept", async () => {
  const { db, ana, ben } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  applyChanges(db, ben.id, { decks: [{ ...buildView(db, ben.id, NOW).decks[0], hidden: true }] }, NOW);
  unassignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] });
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  assert.equal(buildView(db, ben.id, NOW).decks[0].hidden, true);
});
```

If `applyChanges` rejects the deck shape for a given deck (it carries `assigned`/`from`, which sync strips as view-only), keep the test's intent and adapt only the setup.

- [ ] **Step 2: Run** `node --test tests/admin.test.js` — Expected: the first test FAILS (`hidden` present for Ben); the second may already pass.
- [ ] **Step 3: Implement** in `giveTo`: parse the owner's prefs, delete `hidden`, store the rest (`JSON.stringify`).
- [ ] **Step 4: Run** `npm test` — Expected: all PASS.
- [ ] **Step 5: Commit** `git add server/admin.js tests/admin.test.js && git commit -m "Give a hidden deck to new people as shown"`

### Task 3: Home page hidden section and the hide actions

**Files:**
- Modify: `js/app.js` — `ICONS` (~line 77), `openDeckDialog` (~line 526), `renderHome` (~line 1574)
- Modify: `css/styles.css` — near the `.deck-actions` rules (~line 641) and the phone overrides (~lines 2629, 3344)

**Interfaces:**
- Consumes: `store.isHidden(deck)`, `store.setHidden(id, hidden)` from Task 1.

- [ ] **Step 1: Icon.** Add `hide` to `ICONS`: an eye with a slash, drawn in the same stroke style and 24-unit box as the existing icons.
- [ ] **Step 2: `renderHome`.** Split `store.decks()` into `shown` and `hidden` with `store.isHidden`. Build `all` (and so `todayPanel`) from `shown` only. Keep the empty state keyed on *all* decks (`store.decks().length`), so hiding everything never shows "Create your first deck". In each shown row's `.deck-actions`, add `iconButton('hide', 'Hide deck', …)` before the settings button; it calls `store.setHidden(deck.id, true)`, `toast(\`Hidden “${deck.name}”.\`)`, `render()`.
- [ ] **Step 3: Hidden section.** After the deck list, when `hidden.length`, render `<details class="hidden-decks">` with `<summary>` "Hidden · N" and a `ul.deck-list` of plain rows: the name as a link to `#/deck/<id>`, `deckFrom(deck)`, a meta line `plural(cards, 'card')`, and a `button.btn` "Show" that calls `store.setHidden(deck.id, false)`, `toast(\`“${deck.name}” is back in your decks.\`)`, `render()`. These rows must not use `.deck-actions` (hidden on phones). Keep a module-level `let hiddenOpen = false`; set `open` from it and update it on the `toggle` event, so the section stays open across re-renders.
- [ ] **Step 4: Settings dialog (the phone path).** In `openDeckDialog`, for an existing deck (own or given), add `h('label', { class: 'check' }, checkbox, 'Hide deck from the list')` checked from `store.isHidden(deck)`; on save call `store.setHidden(deck.id, checkbox.checked)` alongside the existing update. Not shown when creating a deck.
- [ ] **Step 5: CSS.** Style `.hidden-decks summary` as a quiet section label in the deck list's type and muted colour, with a chevron that turns when open; hidden rows in the muted text colour, Show button always visible (including at phone width). Use existing colour tokens only, so both themes work.
- [ ] **Step 6: Run** `npm test` — Expected: all PASS.
- [ ] **Step 7: Check in the app** (use the `run` skill): on desktop, hide two decks → they leave the list and the headline count drops; open "Hidden · 2", press Show on one → the section stays open and the deck returns; hide every deck → headline says nothing due, no Start review, no empty state. At phone width, hide a deck via Deck settings, show it from the section. Check both themes.
- [ ] **Step 8: Commit** `git add js/app.js css/styles.css && git commit -m "Hide decks into a folded section at the bottom of the home page"`
