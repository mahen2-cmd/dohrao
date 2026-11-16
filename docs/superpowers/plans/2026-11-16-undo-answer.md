# Undo an Answer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user take back answers given in a study session, from an Undo button or Ctrl+Z / Cmd+Z, and answer the card again.

**Architecture:** The store hands back a copy of the card from before each answer and can put such a copy back. The study screen keeps those copies in a per-session stack; undo pops one, restores it, and shows that card with its answer revealed. A card brought back by undo is answered again without adding to the day's counts.

**Tech Stack:** Plain ES modules in the browser (`js/`), `node:test` (`npm test`).

**Spec:** `docs/superpowers/specs/2026-11-16-undo-answer-design.md`

## Global Constraints

- Undo never lowers `daily` or `log` counts (the server keeps the larger value); it only skips counting the re-answer.
- The restored card must equal the card before the answer, field for field.
- History lives only in the study session: leaving the study screen or switching deck clears it. Not kept across reloads.
- Ctrl+Z / Cmd+Z must not act while focus is in a text field or a dialog is open.
- Button tooltip: `Undo last answer (Ctrl+Z)`. Icon: an anticlockwise arrow named `undo`.

## Review Focus

1. Undo on the "All caught up" screen after the last card: the card must come back and be studiable.
2. Ctrl+Z inside the edit-card dialog or a text box: must do the browser's text undo only, never undo an answer.
3. Undo, then answer, then undo again on the same card: still restores the pre-first-answer card, and the second re-answer is still not counted.
4. A card deleted after it was answered: undo skips that entry instead of crashing.
5. The restored card syncs to the server like any other card change.

---

### Task 1: Store support for undo

**Files:**
- Modify: `js/store.js:1088-1098` (`answerCard`), add `restoreCard` right after it
- Test: `tests/store.test.js`, `tests/sync-client.test.js`

**Interfaces:**
- Produces:
  - `answerCard(id, rating, now = Date.now(), { count = true } = {}) -> object` returns a deep copy (`structuredClone`) of the card as it was before the answer. With `count: false`, `state.daily` and `state.log` are left unchanged.
  - `restoreCard(copy) -> boolean` replaces the stored card with id `copy.id` by a copy of `copy` and saves; returns false (and changes nothing) when no such card exists.

- [ ] **Step 1: Write the failing tests** in `tests/store.test.js`

```js
test('an answer can be undone, and the card comes back exactly as it was', () => {
  const deck = setup();
  const card = store.addCard(deck.id, 'front', 'back', T0);
  const before = structuredClone(store.card(card.id));
  const copy = store.answerCard(card.id, Rating.Good, T0);
  assert.deepEqual(copy, before);
  assert.notEqual(store.card(card.id).state, State.New);
  assert.equal(store.restoreCard(copy), true);
  assert.deepEqual(store.card(card.id), before);
  // The copy handed back is not the stored card.
  copy.front = 'x';
  assert.equal(store.card(card.id).front, 'front');
});

test('an answer given again after undo is not counted twice', () => {
  const deck = setup();
  const card = store.addCard(deck.id, 'front', 'back', T0);
  const copy = store.answerCard(card.id, Rating.Good, T0);
  store.restoreCard(copy);
  store.answerCard(card.id, Rating.Again, T0, { count: false });
  assert.equal(store.stats(T0).reviewedToday, 1);
  const { answers } = store.statistics(deck.id, 30, T0);
  assert.equal(answers.flat().reduce((a, b) => a + b, 0), 1);
});

test('restoring a card that was deleted does nothing', () => {
  const deck = setup();
  const card = store.addCard(deck.id, 'front', 'back', T0);
  const copy = store.answerCard(card.id, Rating.Good, T0);
  store.deleteCard(card.id);
  assert.equal(store.restoreCard(copy), false);
  assert.equal(store.cardsIn(deck.id).length, 0);
});
```

In `tests/sync-client.test.js`, after the existing first-answer sync test pattern, add:

```js
test('an undone answer sends the restored card', async () => {
  const calls = serve((url) => (url === 'api/state' ? json(200, view()) : json(200, { rejected: [] })));
  await store.load();
  const copy = store.answerCard('c1', Rating.Good, T0);
  await settle();
  store.restoreCard(copy);
  await settle();
  const last = syncs(calls).at(-1);
  assert.deepEqual(last.body.cards.map((c) => c.id), ['c1']);
  assert.equal(last.body.cards[0].state, copy.state);
  assert.equal(last.body.cards[0].due, copy.due);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/store.test.js tests/sync-client.test.js`
Expected: FAIL (`answerCard` returns undefined; `store.restoreCard is not a function`).

- [ ] **Step 3: Implement** `answerCard`'s return value and `count` option, and `restoreCard`, in `js/store.js`. Take the copy before anything is changed; `restoreCard` swaps the object in `state.cards` (keep its position) and calls `save()`.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add js/store.js tests/store.test.js tests/sync-client.test.js
git commit -m "Let the store undo an answer"
```

### Task 2: Undo in the study screen

**Files:**
- Modify: `js/app.js` — `ICONS` (line ~78), `session` (line 26), `rate` (line ~3364), `renderStudy` (line ~3451, its `top` bar ~3470), the study keydown handler (line ~4668)
- Modify: `css/styles.css` only if the button needs spacing in the top bar

**Interfaces:**
- Consumes: `store.answerCard(id, rating, now, { count })` returning the pre-answer copy; `store.restoreCard(copy) -> boolean` (Task 1).
- Produces: `undoAnswer()` in `js/app.js`.

- [ ] **Step 1: Session state.** Add `history: []` (pre-answer copies, newest last) and `recount: new Set()` (ids of cards brought back by undo) to `session`. In `renderStudy`'s reset when `session.deckId !== deck.id`, reset both too. Leaving study already nulls `session.deckId` (`render`, ~4657), so the next visit resets them.

- [ ] **Step 2: Record and skip counting in `rate`.** Push the return of `store.answerCard(session.cardId, rating, Date.now(), { count: !session.recount.has(session.cardId) })` onto `session.history`.

- [ ] **Step 3: `undoAnswer()`.** Pop copies until one restores (`store.restoreCard` returns true) or the stack is empty; on success: `session.recount.add(copy.id)`, `session.cardId = copy.id`, `session.revealed = true`, `session.done = Math.max(0, session.done - 1)`, `stopSpeaking()`, `render()`. Nothing to undo: do nothing.

- [ ] **Step 4: Button.** Add an `undo` entry to `ICONS` (anticlockwise arrow, same 24-unit stroke style as its neighbours, e.g. `<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>`). In the study `top` bar, before the `.tools` group and outside the `editable` check, add `session.history.length > 0 && iconButton('undo', 'Undo last answer (Ctrl+Z)', undoAnswer)`. It is in `top`, so it also shows on the "All caught up" screen, and on phones.

- [ ] **Step 5: Shortcut.** In the study keydown handler, before the `ctrlKey/metaKey/altKey` early return, handle `(e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z'`, but only after the existing dialog, text-field and route checks pass (move those checks above it, keep their order). Then `e.preventDefault()` and `undoAnswer()`. The handler's `!session.cardId` check must not block undo, since the "All caught up" screen has no card.

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: `# fail 0`

- [ ] **Step 7: Check it in a browser** (use the `run` skill to start the app locally), on a test deck with two cards:
  - Answer Good, press Ctrl+Z: the same card comes back with its answer shown; the session count goes back by one.
  - Answer both cards to reach "All caught up", click Undo: the last card comes back.
  - Undo twice: both answers come back, newest first.
  - Open the edit dialog, type, press Ctrl+Z: only the text changes.
  - Phone width (390px): the Undo button shows in the top bar after an answer and works.
  - Today's review count on the home page does not grow when an undone card is answered again.

- [ ] **Step 8: Commit**

```bash
git add js/app.js css/styles.css
git commit -m "Undo the last answer from the study screen or Ctrl+Z"
```
