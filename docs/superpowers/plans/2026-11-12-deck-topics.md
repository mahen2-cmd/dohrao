# Topics and groups inside a deck — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a deck's cards belong to topics inside groups, study and pull from the reserve by topic, and have the admin's cards sorted into topics automatically (topic file names first, then Claude).

**Architecture:** Groups and topics are shared deck content (`deck.groups`, `deck.topics`); a card's topic is shared card content (`card.topic`, `topicBy`, `topicAt`). Pure helpers live in a new `js/topics.js`; the client store gains topic edits and an optional topic filter on its queue. The server gains a Claude-backed sorter (`server/sorter.js`) and admin-only sort jobs (`server/topics.js`) that write topics straight into the database; the sync code merges topic fields by timestamp so a stale device cannot undo them.

**Tech Stack:** Plain browser JS (no build), Node ≥ 22.15 with built-in `node:sqlite`, `node --test`, and the new dependency `@anthropic-ai/sdk` (server only).

**Spec:** `docs/superpowers/specs/2026-11-12-deck-topics-design.md`

## Global Constraints

- Scheduling is untouched: no task may change `due`, `scheduledDays`, `ease`, `stability`, `difficulty`, `state`, `reps` or `lapses` except through the existing answer path.
- Only the admin's cards ever reach the AI service; the server enforces it (admin role **and** deck `owner_id` = admin's id).
- A placement with `topicBy: 'manual'` is never changed by the sorter. "Sort now" only sends cards with no `topic` and `topicBy !== 'manual'`.
- New-card allowance stays one shared total per deck (`newPerDay` minus cards introduced today, deck-wide), then filtered by topic.
- Studying never waits on sorting: added cards are usable immediately as Unsorted.
- Model `claude-opus-5-5`, `output_config.effort: 'low'`, structured output via `output_config.format` (`json_schema`), server-side fallback `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`. Model id configurable.
- Key from `ANTHROPIC_API_KEY`, else `apiKey` in `<dataDir>/claude.json` (`{ "apiKey": "...", "model": "..." }`). No key → sorting off, everything else works.
- Text sent: card front and back only (LaTeX kept as source, `[image:…]` markers stripped), plus the deck's group and topic names.
- Two levels only (group → topic); at most one topic per card.
- Copy follows PRODUCT.md voice: plain, short sentences. Look follows "Night minimal".

## Review Focus

1. **A phone with an older copy syncs after the server sorted cards** → the server's topics survive (Task 1 test `stale card content keeps the newer topic`).
2. **The saved study filter names a topic or group that was since deleted or renamed** → unknown ids are dropped; if nothing is left, the session is Everything (Task 2 test `filter with only unknown ids means everything`).
3. **A topic session with nothing due while other topics have cards due** → the study screen says this topic is done and offers Everything, not "deck done" (Task 4 test `filtered counts are zero while deck counts are not`; Task 7 UI step).
4. **Claude returns a card id it wasn't sent, an unknown topic id, or malformed JSON** → those placements are ignored and the cards stay Unsorted; nothing throws out of the job (Task 5 test `ignores placements it cannot use`).
5. **A non-admin, or the admin on a deck they don't own (or a given deck)** → 403/404 and the sorter is never called (Task 6 tests).

---

## File Structure

| File | Responsibility |
|---|---|
| `server/fields.js` (modify) | Add topic fields to `DECK_SHARED`/`CARD_CONTENT`; `mergeTopics(stored, incoming)` |
| `server/sync.js` (modify) | Use `mergeTopics` when updating own decks and cards |
| `js/topics.js` (create) | Pure helpers: file-name → topic key, readable names, prefix grouping, filter resolution, text for the AI |
| `js/store.js` (modify) | Topic/group edits, `addCards` topic option, topic-filtered `queue`/`counts`/`nextCard`/`pullFromReserve`/`findCards` |
| `server/sorter.js` (create) | Claude calls: `placeCards`, `proposeTopics`, `groupTopics`; request building and response validation |
| `server/topics.js` (create) | Jobs over the db: `unsortedCards`, `sortDeck`, `proposeForDeck`, `approveProposal`; `topic_proposals` table |
| `server/db.js` (modify) | `topic_proposals` table |
| `server.js` (modify) | Admin routes for sorting; sorter injection; per-deck job lock and status |
| `js/api.js` (modify) | `admin.sort`, `admin.sortStatus`, `admin.propose`, `admin.proposal`, `admin.approve` |
| `js/app.js` (modify) | Topic picker, filtered study, reserve pull by topic, card-list topic filter/move, manage-topics dialog, import topic, admin sort UI, proposal review |
| `css/*.css` (modify) | Styles for the picker and topic chips |
| `scripts/assign-topics.js` (create) | One-off: match a deck's cards to `new_cards_<topic>.csv` files and apply the agreed groups |
| `scripts/portuguese-groups.json` (create) | The 7 groups → topic keys and display names from the spec |
| `package.json`, `package-lock.json`, `deploy/deploy.sh`, `deploy/RUNBOOK.md`, `README.md` (modify) | Dependency, install on deploy, how to set the key and run the one-off |
| Tests: `tests/topics.test.js`, `tests/sorter.test.js`, `tests/topics-server.test.js`, `tests/assign-topics.test.js` (create); `tests/sync.test.js`, `tests/store.test.js`, `tests/http.test.js` (modify) | |

### Data shapes (used by every task)

```js
// deck (shared content)
deck.groups   = [{ id: 'g1', name: 'Verbs' }, ...]
deck.topics   = [{ id: 't1', key: 'verb_ser', name: 'Ser', groupId: 'g1' | null, by: 'file' | 'ai' | 'admin' }, ...]
deck.topicsAt = 1731400000000   // ms of the last change to groups/topics
// deck (personal pref, NOT shared)
deck.studyFilter = ['g:g1', 't:t7', 'unsorted']   // absent or [] = Everything
// card (shared content)
card.topic   = 't1'            // absent = Unsorted
card.topicBy = 'file' | 'ai' | 'manual'
card.topicAt = 1731400000000
// proposal (server only, topic_proposals.data)
{ groups: [{ id, name }], topics: [{ id, name, groupId }], at }
```

Ids are made with the store's existing `uid()` on the client and `randomUUID()` on the server. `key` is the topic-file key (`verb_ser`) when the topic came from a file, otherwise absent.

---

### Task 1: Topic fields travel as shared content and merge by timestamp

**Files:**
- Modify: `server/fields.js`, `server/sync.js:84-118` (`applyDeck`, `applyCard`), `js/store.js:402` (`SHARED_DECK_KEYS`)
- Test: `tests/sync.test.js`

**Interfaces:**
- Produces: `DECK_SHARED` gains `'groups', 'topics', 'topicsAt'`; `CARD_CONTENT` gains `'topic', 'topicBy', 'topicAt'`.
- Produces: `mergeTopics(stored, incoming, fields, atKey) -> object` in `server/fields.js`: returns `incoming` with `fields` (and `atKey`) replaced by `stored`'s values when `(stored[atKey] ?? 0) > (incoming[atKey] ?? 0)`. Deck call: `fields = ['groups', 'topics']`, `atKey = 'topicsAt'`. Card call: `fields = ['topic', 'topicBy']`, `atKey = 'topicAt'`. A field absent in the winner is absent in the result.

- [ ] **Step 1: Write the failing tests** in `tests/sync.test.js`

```js
test('topic fields are shared with people the deck is given to', async () => {
  const { db, ana, ben, deck } = await seed();
  const groups = [{ id: 'g1', name: 'Verbs' }];
  const topics = [{ id: 't1', name: 'Ser', groupId: 'g1', by: 'admin' }];
  applyChanges(db, ana.id, { decks: [{ ...deck, groups, topics, topicsAt: NOW + 1 }],
    cards: [cardOf('c1', { topic: 't1', topicBy: 'manual', topicAt: NOW + 1 })] }, NOW);
  give(db, 'd1', ben.id);
  const view = buildView(db, ben.id, NOW);
  assert.deepEqual(view.decks[0].topics, topics);
  assert.equal(view.cards.find((c) => c.id === 'c1').topic, 't1');
});

test('stale card content keeps the newer topic', async () => {
  const { db, ana } = await seed();
  db.prepare('UPDATE cards SET data = json_set(data, \'$.topic\', \'t9\', \'$.topicBy\', \'ai\', \'$.topicAt\', ?) WHERE id = ?').run(NOW + 50, 'c1');
  applyChanges(db, ana.id, { cards: [cardOf('c1', { reps: 1 })] }, NOW);   // an answer from an old copy
  const c1 = buildView(db, ana.id, NOW).cards.find((c) => c.id === 'c1');
  assert.equal(c1.topic, 't9');
  assert.equal(c1.topicBy, 'ai');
  assert.equal(c1.reps, 1);
});

test('a newer manual topic wins over the stored one', async () => { /* stored topicAt NOW+50 't9'; incoming topicAt NOW+60 't2' → 't2' */ });

test('stale deck content keeps the newer groups and topics', async () => { /* same pattern on decks.data with topicsAt */ });

test('a recipient cannot change topics of a given deck', async () => {
  /* ben sends the given deck with different topics and c1 with topic 't2' → stored content unchanged */
});
```

- [ ] **Step 2: Run** `node --test tests/sync.test.js` — Expected: the new tests FAIL (topics missing from the view / stale overwrite).
- [ ] **Step 3: Implement** the field lists, `mergeTopics`, and call it in `applyDeck` (`kind === 'own'` branch: read stored `decks.data`, merge, write) and `applyCard` (own→own update branch: read stored `cards.data`, merge, write). Update `SHARED_DECK_KEYS` in `js/store.js` to the same list (the existing test at `tests/store.test.js:517` loops over `DECK_SHARED` and will then cover the new keys).
- [ ] **Step 4: Run** `npm test` — Expected: all PASS.
- [ ] **Step 5: Commit** `git commit -m "Share topic fields with a deck and keep the newer topic on sync"`

---

### Task 2: Pure topic helpers

**Files:**
- Create: `js/topics.js`
- Test: `tests/topics.test.js`

**Interfaces:**
- Produces (all pure, no state):
  - `topicKeyFromFileName(name: string) -> string | null` — `'new_cards_verb_ser.csv'` → `'verb_ser'`; also `.xlsx`, `.tsv`, `.txt`; case-insensitive; `'new_cards_all.csv'` → `null`; any other name → `null`.
  - `readableTopicName(key: string) -> string` — drops a leading `verb_`, `_` → space, first letter upper case: `'cafe_ordering'` → `'Cafe ordering'`, `'verb_ser'` → `'Ser'`.
  - `prefixGroup(deck, key) -> string | null` — the `groupId` shared by every existing topic whose `key` starts with the same first segment (`'verb'` from `'verb_ir'`), when there is at least one and they agree; else `null`.
  - `resolveFilter(deck, filter: string[] | undefined) -> Set<string> | null` — `null` means Everything. `'g:<id>'` expands to its topics' ids, `'t:<id>'` adds that id, `'unsorted'` adds `''`. Unknown ids are dropped; an empty result is `null`.
  - `inFilter(card, set) -> boolean` — `set === null || set.has(card.topic ?? '')`.
  - `filterLabel(deck, filter) -> string` — `'Everything'`, a single group/topic name, or `'<first> and N more'`.
  - `aiText(side: string) -> string` — strips `[image:…]` markers and trims; LaTeX untouched.

- [ ] **Step 1: Write the failing tests** in `tests/topics.test.js` covering each function, including:

```js
test('filter with only unknown ids means everything', () => {
  assert.equal(resolveFilter(deck, ['t:gone', 'g:gone']), null);
});
test('a group expands to its topics and unsorted is the empty key', () => {
  assert.deepEqual([...resolveFilter(deck, ['g:g1', 'unsorted'])].sort(), ['', 't1', 't2']);
});
test('prefixGroup needs agreeing topics with the same first segment', () => {
  assert.equal(prefixGroup(deck, 'verb_ir'), 'g1');      // verb_ser, verb_ter in g1
  assert.equal(prefixGroup(deck, 'animals'), null);
});
test('new_cards_all is not a topic', () => assert.equal(topicKeyFromFileName('new_cards_all.csv'), null));
```

- [ ] **Step 2: Run** `node --test tests/topics.test.js` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `js/topics.js` (ES module, no imports).
- [ ] **Step 4: Run** `node --test tests/topics.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add topic helpers: file names, readable names, filters"`

---

### Task 3: Store — editing groups, topics and card placements; import with a topic

**Files:**
- Modify: `js/store.js` (new "Topics" section after Cards; `addCards`)
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: `readableTopicName`, `prefixGroup` from `js/topics.js`.
- Produces (each calls `mustEdit(deckId)`, sets `deck.topicsAt = now` when groups/topics change, then `save()`):
  - `createGroup(deckId, name, now = Date.now()) -> group`
  - `renameGroup(deckId, groupId, name, now)`, `deleteGroup(deckId, groupId, now)` — its topics become `groupId: null` (kept).
  - `ensureTopic(deckId, key, now) -> topic` — returns the topic with that `key`, or creates `{ id, key, name: readableTopicName(key), groupId: prefixGroup(deck, key), by: 'file' }`.
  - `createTopic(deckId, name, groupId, now) -> topic` (`by: 'admin'`), `renameTopic(deckId, topicId, name, now)`, `moveTopic(deckId, topicId, groupId | null, now)`.
  - `deleteTopic(deckId, topicId, now)` — removes it; its cards lose `topic` and `topicBy` and get `topicAt = now` (they become eligible for sorting again).
  - `setCardsTopic(ids: string[], topicId: string | null, now) -> number` — sets `topic` (or deletes it for `null`), `topicBy: 'manual'`, `topicAt: now`.
  - `addCards(deckId, pairs, now, { reserved = false, topicKey } = {})` — with `topicKey`, every card gets `topic: ensureTopic(...).id`, `topicBy: 'file'`, `topicAt: now`.
  - `unsortedCount(deckId) -> number` — cards with no `topic` and `topicBy !== 'manual'`.

- [ ] **Step 1: Write the failing tests**, including:

```js
test('importing a topic file creates the topic once and joins its prefix group', () => {
  const deck = setup();
  const verbs = store.createGroup(deck.id, 'Verbs', T0);
  store.addCards(deck.id, [['to be', 'ser']], T0, { topicKey: 'verb_ser' });
  store.moveTopic(deck.id, store.deck(deck.id).topics[0].id, verbs.id, T0);
  store.addCards(deck.id, [['to go', 'ir']], T0, { topicKey: 'verb_ir' });
  store.addCards(deck.id, [['I am', 'sou']], T0, { topicKey: 'verb_ser' });
  const topics = store.deck(deck.id).topics;
  assert.equal(topics.length, 2);
  assert.ok(topics.every((t) => t.groupId === verbs.id));
  assert.ok(store.cardsIn(deck.id).every((c) => c.topicBy === 'file'));
});
test('deleting a topic makes its cards sortable again', () => { /* unsortedCount goes from 0 to n */ });
test('moving cards by hand marks them manual and they are not counted as unsorted', () => { /* setCardsTopic(ids, null) → unsortedCount 0 */ });
test('topic edits on a given deck are refused', () => { /* each function throws read-only for an assigned deck */ });
test('topic edits never touch scheduling fields', () => { /* snapshot due/state/ease before and after */ });
```

- [ ] **Step 2: Run** `node --test tests/store.test.js` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** the functions in `js/store.js`.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Let a deck's cards be placed in topics and groups"`

---

### Task 4: Store — study, count and pull by topic

**Files:**
- Modify: `js/store.js` (`queue`, `counts`, `nextCard`, `pullFromReserve`, `findCards`)
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: `resolveFilter`, `inFilter` from `js/topics.js`.
- Produces (new last/option parameter, default = today's behaviour):
  - `queue(deckId, now, filter)` — allowance computed deck-wide exactly as today; then `learning`, `review` and `fresh` filtered with `inFilter`; `fresh` sliced to the allowance **after** filtering.
  - `counts(deckId, now = Date.now(), filter)` — `new/learning/review/total` use the filtered queue; `cards`, `reserve`, `tomorrow` stay deck-wide. Adds `newLeft` = the deck-wide allowance left today.
  - `nextCard(deckId, now = Date.now(), filter)`
  - `pullFromReserve(deckId, n = Infinity, now = Date.now(), filter)` — takes the first `n` reserve cards that pass the filter, in reserve order.
  - `findCards(deckId, { ..., topics = [] })` — `topics` is a filter array as in `resolveFilter`; empty = all.
  - `topicCounts(deckId, now = Date.now()) -> Map<topicId | '', { due: number, fresh: number, reserve: number }>` — for the picker.
- `upcoming` and statistics stay deck-wide (spec: deck list counts stay deck-wide).

- [ ] **Step 1: Write the failing tests**, including:

```js
test('a topic session shows only that topic and shares the daily new allowance', () => {
  const deck = setup({ newPerDay: 3 });
  store.addCards(deck.id, [['a', '1'], ['b', '2'], ['c', '3']], T0, { topicKey: 'verb_ser' });
  store.addCards(deck.id, [['d', '4'], ['e', '5']], T0, { topicKey: 'animals' });
  const ser = ['t:' + store.deck(deck.id).topics.find((t) => t.key === 'verb_ser').id];
  assert.equal(store.counts(deck.id, T0, ser).new, 3);
  for (let i = 0; i < 2; i++) store.answerCard(store.nextCard(deck.id, T0, ser).id, Rating.Good, T0);
  assert.equal(store.counts(deck.id, T0).new, 1);           // deck-wide: 3 allowed, 2 used
  assert.equal(store.counts(deck.id, T0, ser).newLeft, 1);
});
test('filtered counts are zero while deck counts are not', () => { /* animals due, filter verbs → total 0, deck total > 0 */ });
test('pulling by topic takes that topic in reserve order', () => { /* 5 reserve cards mixed; pull 2 with filter → the first 2 of that topic */ });
test('answering in a topic session schedules exactly as in a mixed one', () => {
  /* two identical decks; answer the same card with and without filter; compare due/state/scheduledDays */
});
test('findCards filters by topic and unsorted', () => { /* topics: ['unsorted'] returns only cards without a topic */ });
```

- [ ] **Step 2: Run** `node --test tests/store.test.js` — Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Study, count and pull from the reserve by topic"`

---

### Task 5: Claude sorter

**Files:**
- Create: `server/sorter.js`
- Modify: `package.json` (dependency `@anthropic-ai/sdk`, latest release), `package-lock.json`, `deploy/deploy.sh` (after rsync: `ssh "$target" 'cd /opt/recall && npm ci --omit=dev'` before the restart)
- Test: `tests/sorter.test.js`

**Interfaces:**
- Consumes: `aiText` from `js/topics.js`.
- Produces:
  - `createSorter({ client, model = 'claude-opus-5-5' }) -> sorter` — `client` is an `Anthropic` instance (tests pass a fake with `beta.messages.create`).
  - `loadSorter(dataDir) -> sorter | null` — key from `process.env.ANTHROPIC_API_KEY` or `<dataDir>/claude.json` `apiKey`; model from `claude.json` `model`; `null` without a key.
  - `sorter.placeCards({ deckName, groups, topics, cards: [{ id, front, back }] }) -> Promise<{ placements: [{ id, topic }], newTopics: [{ ref, name, groupId }] }>` — `topic` is an existing topic id or a `ref` like `'new:1'` that names one of `newTopics`.
  - `sorter.proposeTopics({ deckName, cards }) -> Promise<{ groups: [{ id, name }], topics: [{ id, name, groupId }] }>` — ids are `'g1'…`/`'t1'…` local to the proposal.
  - `sorter.groupTopics({ deckName, groups, topics: [{ id, name }] }) -> Promise<[{ id, groupId }]>` — places ungrouped topics into existing groups.
- Every call: `client.beta.messages.create({ model, max_tokens: 16000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'low', format: { type: 'json_schema', schema } }, system, messages })`. Read the JSON from the first `text` block; treat `stop_reason === 'refusal'`, a parse error or a schema mismatch as an empty result (no throw for those; network/API errors do throw so the job can retry).
- Validation: drop placements whose `id` wasn't sent or whose `topic` is neither a known topic id nor a returned `ref`; drop `newTopics` whose `groupId` is unknown (set to `null`).
- Prompt rules to include: one topic per card; prefer an existing topic; create a new topic only when nothing fits; keep names short and in the deck's language of study; cards are flashcards (front = prompt, back = answer).

- [ ] **Step 1: Write the failing tests** with a fake client recording the request:

```js
test('placeCards sends only front and back text and the topic list', async () => { /* assert request.model, effort 'low', fallbacks 'default', no other card fields in the user message, [image:x] stripped */ });
test('ignores placements it cannot use', async () => {
  /* fake returns placements for unknown card id, unknown topic id, and one valid → only the valid one */
});
test('a refusal or bad JSON gives an empty result', async () => { /* stop_reason 'refusal' → { placements: [], newTopics: [] } */ });
test('loadSorter is null without a key', () => { /* temp dataDir, env unset */ });
```

- [ ] **Step 2: Run** `node --test tests/sorter.test.js` — Expected: FAIL.
- [ ] **Step 3: Install** `npm install @anthropic-ai/sdk` and implement `server/sorter.js`; update `deploy/deploy.sh`.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add a Claude sorter that places cards in a deck's topics"`

---

### Task 6: Sort jobs and admin endpoints

**Files:**
- Create: `server/topics.js`
- Modify: `server/db.js` (table), `server.js` (routes, `createRecallServer({ ..., sorter })` option defaulting to `loadSorter(dataDir)`), `js/api.js`
- Test: `tests/topics-server.test.js`, `tests/http.test.js`

**Interfaces:**
- Consumes: sorter from Task 5; `mergeTopics` semantics from Task 1 (writes set `topicAt`/`topicsAt` to `now` so they win).
- Produces in `server/topics.js`:
  - `ownedDeck(db, userId, deckId) -> { id, data } | null` — only when `owner_id = userId`.
  - `unsortedCards(db, deckId) -> [{ id, front, back }]` — no `topic`, `topicBy !== 'manual'`, in `rowid` order.
  - `sortDeck(db, sorter, deckId, now, { batch = 100 }) -> Promise<{ sorted, created, remaining }>` — first `groupTopics` for topics with `groupId: null` (only when the deck has groups), then batches of `unsortedCards`; writes `topic`, `topicBy: 'ai'`, `topicAt: now` into `cards.data`; adds new topics (`by: 'ai'`) to `decks.data` with `topicsAt: now`. Re-reads each card before writing and skips it if it gained a topic meanwhile.
  - `proposeForDeck(db, sorter, deckId, now) -> proposal` — sends at most 300 cards, spread evenly through the deck; stores in `topic_proposals`.
  - `approveProposal(db, deckId, { groups, topics }, now)` — validates (names non-empty ≤ 60 chars, every `groupId` known), writes them as the deck's `groups`/`topics` (`by: 'admin'`, fresh ids), deletes the proposal.
- Table: `CREATE TABLE IF NOT EXISTS topic_proposals (deck_id TEXT PRIMARY KEY REFERENCES decks(id) ON DELETE CASCADE, data TEXT NOT NULL)`.
- Routes (all under the existing admin gate, plus `ownedDeck` → else 404):
  - `POST /api/admin/decks/:id/sort` → 202 `{ running: true }`; starts `sortDeck` in the background unless one is already running for that deck (in-memory `Set`); errors are logged and the job ends.
  - `GET /api/admin/decks/:id/sort` → `{ running: boolean, unsorted: number }`.
  - `POST /api/admin/decks/:id/propose` → 200 proposal (awaits the call); `GET .../proposal` → proposal or 404; `POST .../proposal/approve` body `{ groups, topics }` → 204 and starts a sort.
  - With no sorter: sort/propose return 503 `{ error: 'no-sorter' }`; `GET .../sort` still answers.
- `js/api.js` `admin` gains `sort(deckId)`, `sortStatus(deckId)`, `propose(deckId)`, `proposal(deckId)`, `approve(deckId, body)`.

- [ ] **Step 1: Write the failing tests**, with a fake sorter counting calls:

```js
test('sortDeck places only unsorted, non-manual cards and keeps scheduling', async () => { /* 3 cards: one manual-unsorted, one file-sorted, one bare → sorter sees 1 card */ });
test('a card placed by hand during a sort is left alone', async () => { /* fake sorter sets the card's topic manually before returning */ });
test('a recipient view shows the sorted topics', async () => { /* buildView for a user the deck is given to */ });
// http.test.js
test('sorting is refused to non-admins and for decks the admin does not own', async () => { /* 403 for user; 404 for a given deck; fake sorter call count 0 */ });
test('sorting without a key answers 503 and the app still works', async () => {});
test('approving a proposal writes the topics and starts a sort', async () => {});
```

- [ ] **Step 2: Run** `node --test tests/topics-server.test.js tests/http.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Sort the admin's decks on the server, admin only"`

---

### Task 7: Study by topic and pull from the reserve by topic (UI)

**Files:**
- Modify: `js/app.js` (deck page header, `renderStudy`, `currentStudyCard`, `reserveBar`), CSS
- Test: manual (the app has no UI tests); store behaviour is covered by Task 4.

**Interfaces:**
- Consumes: `counts/nextCard/pullFromReserve(…, filter)`, `topicCounts`, `filterLabel`, `deck.studyFilter`.
- Produces: `openTopicPicker(deck)` — dialog listing Everything, then each group (checkbox, with due/new counts from `topicCounts`) expandable to its topics, then Unsorted when any card has no topic. Saving calls `store.updateDeck(deck.id, { studyFilter })` (personal, allowed on given decks). Hidden when the deck has no topics.

- [ ] **Step 1:** On the deck page, next to "Study N", show the current `filterLabel` as a button opening `openTopicPicker`; "Study N" uses the filtered `counts`. The picker shows "N new cards left today for this deck" (`newLeft`).
- [ ] **Step 2:** `renderStudy`/`currentStudyCard` pass `deck.studyFilter` to `counts`/`nextCard`; the study title shows `deck.name · filterLabel`. When the filtered total is 0 but the deck total isn't, the done screen says "<label> is done for today" with a "Study everything" button (sets `studyFilter: []`).
- [ ] **Step 3:** In `reserveBar`, when the deck has topics, a select beside "Pull in" (Everything / groups / topics) passes its filter to `pullFromReserve`.
- [ ] **Step 4: Verify** with `npm start` and an admin account holding a deck with two topics: pick one topic → only its cards come up; Everything → mixed; new-card count shared; phone width (375px) has no horizontal scroll; dark and light themes; keyboard (`Space`, `1`–`4`) still works.
- [ ] **Step 5: Commit** `git commit -m "Choose which topics to study, and pull them from the reserve"`

---

### Task 8: See and change topics (UI)

**Files:**
- Modify: `js/app.js` (`renderDeck` filters and card rows, `openCardDialog`), CSS

**Interfaces:**
- Consumes: Task 3 edit functions; `findCards({ topics })`.
- Produces: `openTopicsDialog(deck)` — manage groups and topics: rename, move a topic to another group (or none), create, delete (confirm says how many cards become Unsorted). Read-only notice for given decks.

- [ ] **Step 1:** Card list: a topic filter (same choices as the picker) feeding `findCards({ topics })`; each card row shows its topic name in muted text.
- [ ] **Step 2:** Bulk selection gains "Move to topic…" (choices: topics, Unsorted) → `setCardsTopic`. Card editor gains a topic select.
- [ ] **Step 3:** Deck menu gains "Topics…" → `openTopicsDialog`.
- [ ] **Step 4: Verify** by hand: rename a topic and see it in the picker; delete a topic and its cards show as Unsorted; a given deck shows topics but offers no edits.
- [ ] **Step 5: Commit** `git commit -m "Show, move and manage topics in a deck"`

---

### Task 9: Automatic sorting in the app (UI)

**Files:**
- Modify: `js/app.js` (`openImportDialog`, `openCardDialog` save, Anki import completion, deck page, new proposal dialog)

**Interfaces:**
- Consumes: `topicKeyFromFileName`, `addCards(…, { topicKey })`, `unsortedCount`, `api.admin.sort/sortStatus/propose/proposal/approve`, `store.flush`, `store.refresh`.
- Produces: `requestSort(deckId)` — only when `account.role === 'admin'` and the deck is not `assigned`: `await store.flush()`, `api.admin.sort(deckId)`, then poll `sortStatus` every 5 s until `running` is false, then `store.refresh()` and toast "Sorted N cards". A 503 shows "Sorting is off: no API key on the server" once.

- [ ] **Step 1:** Import dialog: when `topicKeyFromFileName(fileName)` gives a key, show "Cards go into the topic <name>" and pass `topicKey` (for every user).
- [ ] **Step 2:** After an import, an added card, or an Anki import into an admin-owned deck that has topics: `requestSort(deckId)`.
- [ ] **Step 3:** Deck page (admin, own deck): when `unsortedCount > 0` and the deck has topics, show "N unsorted · Sort now". When the deck has no topics: "Sort this deck into topics" → `api.admin.propose` → proposal dialog (rename/merge/move/delete groups and topics, Approve) → `api.admin.approve` → `requestSort` polling.
- [ ] **Step 4: Verify** by hand with a real key on a small test deck: proposal shows before any card moves; approve places cards; a user account never sees the sort controls; with no key, the 503 message appears and studying still works.
- [ ] **Step 5: Commit** `git commit -m "Sort the admin's new cards into topics automatically"`

---

### Task 10: One-off sort of Portuguese A1, and docs

**Files:**
- Create: `scripts/assign-topics.js`, `scripts/portuguese-groups.json`
- Modify: `deploy/RUNBOOK.md`, `README.md`
- Test: `tests/assign-topics.test.js`

**Interfaces:**
- `scripts/portuguese-groups.json`: `[{ "group": "Verbs", "topics": { "verb_ser": "Ser", ... } }, ...]` — the 7 groups and 63 topic keys exactly as in the spec's table, display names written out (e.g. `"verb_chamar_se": "Chamar-se"`, `"cafe_ordering": "Café ordering"`, `"numbers_11-19": "Numbers 11–19"`).
- `assignTopics(db, { ownerUsername, deckName, files: Map<topicKey, [front, back][]>, groups, now }) -> { matched, ambiguous, unmatched }` — matches a card when its normalised `front|back` (or `back|front`) equals a file row (normalise: strip tags, lower case, collapse spaces); ambiguous matches are left unsorted; writes `groups`/`topics` (`by: 'admin'`) to the deck and `topic`, `topicBy: 'file'`, `topicAt: now` to matched cards. Cards that already have a topic are skipped.
- CLI: `node scripts/assign-topics.js --data <dir> --username <admin> --deck "Portuguese A1" --files <dir with new_cards_*.csv> [--dry-run]`. Before writing: `VACUUM INTO '<data>/backups/recall-before-topics-<YYYY-MM-DD>.db'`. Prints matched/ambiguous/unmatched counts.

- [ ] **Step 1: Write the failing test**: a tiny in-memory db with 4 cards and two files → 2 matched (one reversed), 1 unmatched, 1 already sorted untouched; scheduling fields unchanged.
- [ ] **Step 2: Run** `node --test tests/assign-topics.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the script and the JSON.
- [ ] **Step 4: Run** `npm test` — Expected: PASS. Then a dry run against a copy of the live database, expecting about **4,825 matched** and about **1,726 unmatched** for Portuguese A1.
- [ ] **Step 5: Docs.** RUNBOOK: setting the key (`/var/lib/recall/claude.json` or `Environment=ANTHROPIC_API_KEY` in the service), copying the CSVs to the server, running the script (stop the service first, as in the migration), then "Sort now" in the app for the rest. README: Topics section (studying by topic, pulling by topic, topic files, automatic sorting for the admin only) and the new dependency.
- [ ] **Step 6: Commit** `git commit -m "Sort Portuguese A1 into topics from the topic files"`

Running the script against the live server is the owner's step (it changes production data); the plan ends with it ready and documented.
