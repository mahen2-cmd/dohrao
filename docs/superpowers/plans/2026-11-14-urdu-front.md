# Urdu Front Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On decks where the admin switches it on (Portuguese A1), each card's English side can show English, Urdu or both, in Urdu script or Roman Urdu, read aloud. The Urdu comes from Google Translate and is saved on the card.

**Architecture:** Pure helpers in `js/urdu.js` are shared by the browser and the server. The server translates through `server/translate.js` and fills cards from a background queue (`server/urdu-queue.js`) after syncs and at startup. Translations are shared card fields, merged newest-wins by `urduAt`. Each person's choice is a personal deck pref. The admin's per-person switch is two columns on `assignments`. The person's view gets it as view-only fields.

**Tech Stack:** Plain ES modules, Node ≥ 22.15 built-in `node:sqlite` and `node:test` (`npm test`), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-14-urdu-front-design.md`

## Global Constraints

- No new npm dependencies. No external font or script: Urdu script uses the existing system Nastaliq stack from `.brand-ur` in `css/styles.css` (`'Noto Nastaliq Urdu', 'Jameel Noori Nastaleeq', 'Urdu Typesetting', 'Noto Naskh Arabic', serif`).
- Translation endpoint: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=pt&tl=ur&dt=t&dt=rm&q=<text>`. The source is always the card's Portuguese side.
- Urdu voice: language code `ur-PK`. Azure/Edge voice `ur-PK-UzmaNeural`. Google TTS is called with `tl=ur-PK`, which was checked on 2026-11-14 and returns audio.
- Shared deck field `urdu` (boolean). Shared card fields `urdu`, `urduRoman`, `urduOf`, `urduBy` (`'google'` | `'manual'`), `urduAt` (ms).
- Personal deck prefs: `frontShows` (`'en'` | `'ur'` | `'both'`), `frontShowsAt` (ms, server-stamped), `urduScript` (`'arabic'` default | `'roman'`).
- Assignment columns `urdu INTEGER NOT NULL DEFAULT 0`, `urdu_at INTEGER`. View-only deck fields `urduSwitch` (boolean), `urduSwitchAt` (ms).
- UI copy: Deck settings checkbox **Translate the front into Urdu**. Selects **Front shows** (English / Urdu / Both) and **Urdu writing** (Urdu script / Roman Urdu). Give dialog checkbox **Urdu**. Editor boxes **Urdu**, **Roman Urdu** and button **Translate again**.
- Nothing about scheduling, progress or the reserve changes. People with no choice and no switch see English.
- Deploying to the live server is not part of this plan's tasks. Ask the owner first (see Task 9).

## Review Focus

1. **Card whose Portuguese is empty or only an image or maths:** nothing is sent to Google, the card shows English, and the queue doesn't retry it forever. Tested in Task 1 (`needsUrdu` false) and Task 4.
2. **Admin edits a card's English only, not the Portuguese:** the Urdu stays, and no re-translation is queued. Tested in Task 1 (`needsUrdu` stays false when `urduOf` matches).
3. **Google is down or returns an unexpected shape:** the queue logs the failure and moves on, the card keeps showing English, and the next scan retries it. Tested in Task 2 (parse throws `bad-response`) and Task 4 (a failed card is left untouched).
4. **Person chose English, then the admin switches Urdu on later:** they get Urdu, because the switch is newer. If they then choose English again, English sticks. Tested in Task 1 (`frontShows` ordering).
5. **Reversed copies (front Portuguese, back English):** the Urdu goes on the back and is translated from the front. Tested in Task 1 (`englishSide` / `portugueseSide` with `reversed: true`).

---

### Task 1: Shared Urdu helpers

**Files:**
- Create: `js/urdu.js`
- Test: `tests/urdu.test.js`

**Interfaces:**
- Consumes: `speechText(text)` from `js/content.js`, which strips images, maths and markup.
- Produces:
  - `URDU_FIELDS = ['urdu', 'urduRoman', 'urduOf', 'urduBy']`
  - `portugueseSide(card, deck) -> 'front' | 'back'`. When `deck.backLang` starts with `pt`, this is `'back'` for a normal card and `'front'` for a reversed one. Otherwise the mirror.
  - `englishSide(card, deck) -> 'front' | 'back'`, the other side.
  - `portugueseText(card, deck) -> string`, the `speechText` of the Portuguese side, trimmed.
  - `needsUrdu(card, deck) -> boolean`. Returns true when `deck.urdu`, `portugueseText` isn't empty, and either `!card.urdu` or (`card.urduBy !== 'manual'` and `card.urduOf !== portugueseText`).
  - `frontShows(deck) -> 'en' | 'ur' | 'both'`. Picks the newer of the person's own choice (`frontShows` at `frontShowsAt ?? 0`) and the admin's switch (`urduSwitch` at `urduSwitchAt`; on → `'ur'`, off → `'en'`). If neither is set, returns `'en'`. If only the person's choice exists, returns it.
  - `shownSide(card, deck) -> { english: string|null, urdu: string|null, urduLang: 'ur' | 'ur-Latn' }`, for the English side. Urdu only shows when `deck.urdu` and `card.urdu` are set. `urdu` is `card.urduRoman` when `deck.urduScript === 'roman'` and that value is non-empty, otherwise `card.urdu`. `english` is `card[englishSide]`, or null when the choice is `'ur'` and Urdu exists.

- [ ] **Step 1: Write the failing tests**

```js
const deck = { urdu: true, frontLang: 'en-US', backLang: 'pt-PT' };
const card = { front: 'Where do you live?', back: 'Onde moras?' };
test('Portuguese is the back, or the front of a reversed copy', () => {
  assert.equal(portugueseSide(card, deck), 'back');
  assert.equal(portugueseSide({ ...card, reversed: true }, deck), 'front');
  assert.equal(englishSide({ ...card, reversed: true }, deck), 'back');
});
test('needsUrdu', () => {
  assert.equal(needsUrdu(card, deck), true);
  assert.equal(needsUrdu(card, { ...deck, urdu: false }), false);
  assert.equal(needsUrdu({ ...card, back: '[image:a.png]' }, deck), false);
  const done = { ...card, urdu: 'آپ', urduOf: 'Onde moras?', urduBy: 'google' };
  assert.equal(needsUrdu(done, deck), false);
  assert.equal(needsUrdu({ ...done, front: 'Where do you live (informal)?' }, deck), false);
  assert.equal(needsUrdu({ ...done, back: 'Onde vives?' }, deck), true);
  assert.equal(needsUrdu({ ...done, back: 'Onde vives?', urduBy: 'manual' }, deck), false);
});
test('frontShows takes the newer of the choice and the switch', () => {
  assert.equal(frontShows({}), 'en');
  assert.equal(frontShows({ frontShows: 'both', frontShowsAt: 5 }), 'both');
  assert.equal(frontShows({ frontShows: 'en', frontShowsAt: 5, urduSwitch: true, urduSwitchAt: 9 }), 'ur');
  assert.equal(frontShows({ frontShows: 'en', frontShowsAt: 10, urduSwitch: true, urduSwitchAt: 9 }), 'en');
  assert.equal(frontShows({ urduSwitch: false, urduSwitchAt: 9 }), 'en');
});
test('shownSide', () => {
  const c = { ...card, urdu: 'آپ کہاں رہتے ہیں؟', urduRoman: 'aap kahan rahte hen?' };
  assert.deepEqual(shownSide(c, { ...deck, frontShows: 'ur', frontShowsAt: 1 }), { english: null, urdu: 'آپ کہاں رہتے ہیں؟', urduLang: 'ur' });
  assert.deepEqual(shownSide(c, { ...deck, frontShows: 'both', frontShowsAt: 1, urduScript: 'roman' }), { english: 'Where do you live?', urdu: 'aap kahan rahte hen?', urduLang: 'ur-Latn' });
  assert.deepEqual(shownSide(card, { ...deck, frontShows: 'ur', frontShowsAt: 1 }), { english: 'Where do you live?', urdu: null, urduLang: 'ur' });
  assert.deepEqual(shownSide(c, { ...deck, urdu: false, frontShows: 'ur', frontShowsAt: 1 }).urdu, null);
});
```

- [ ] **Step 2:** Run `node --test tests/urdu.test.js`. Expected: FAIL, because the module isn't found.
- [ ] **Step 3:** Implement the exports above in `js/urdu.js`.
- [ ] **Step 4:** Run `node --test tests/urdu.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit with `git add js/urdu.js tests/urdu.test.js && git commit -m "Add the helpers that decide where a card's Urdu goes and when it shows"`.

### Task 2: Translating through Google

**Files:**
- Create: `server/translate.js`
- Test: `tests/translate.test.js`

**Interfaces:**
- Produces:
  - `parseGoogle(json) -> { urdu: string, urduRoman: string }`. `urdu` joins the string `[0]` of every entry in `json[0]` whose `[0]` is a string and whose `[1]` is a string (translation segments). `urduRoman` is `[2]` of the entry in `json[0]` whose `[0]` and `[1]` are null and whose `[2]` is a string, or `''` if there isn't one. Throws `Error('bad-response')` when `urdu` is empty.
  - `createTranslator({ fetch = globalThis.fetch, timeoutMs = 15000 }) -> { toUrdu(text: string): Promise<{ urdu, urduRoman }> }`. Throws `Error('google-<status>')` on a non-OK response.

- [ ] **Step 1: Write the failing tests** using the two responses captured on 2026-11-14:

```js
const ONE = [[["آپ کہاں رہتے ہیں؟","Onde moras?",null,null,3],[null,null,"aap kahan rahte hen?"]],null,"pt"];
const TWO = [[["صبح بخیر ","Bom dia. ",null,null,11],["کیسی ہو؟","Como está?",null,null,11],[null,null,"sabah bakhair kisi ho?"]],null,"pt"];
test('parseGoogle reads script and romanisation', () => {
  assert.deepEqual(parseGoogle(ONE), { urdu: 'آپ کہاں رہتے ہیں؟', urduRoman: 'aap kahan rahte hen?' });
  assert.deepEqual(parseGoogle(TWO), { urdu: 'صبح بخیر کیسی ہو؟', urduRoman: 'sabah bakhair kisi ho?' });
});
test('parseGoogle refuses an unexpected shape', () => {
  assert.throws(() => parseGoogle({}), /bad-response/);
  assert.throws(() => parseGoogle([[]]), /bad-response/);
});
test('toUrdu sends the Portuguese to the gtx endpoint', async () => {
  let url;
  const t = createTranslator({ fetch: async (u) => ((url = new URL(u)), { ok: true, json: async () => ONE }) });
  assert.equal((await t.toUrdu('Onde moras?')).urdu, 'آپ کہاں رہتے ہیں؟');
  assert.equal(url.host, 'translate.googleapis.com');
  assert.deepEqual([url.searchParams.get('sl'), url.searchParams.get('tl'), url.searchParams.getAll('dt')], ['pt', 'ur', ['t', 'rm']]);
  assert.equal(url.searchParams.get('q'), 'Onde moras?');
});
test('toUrdu fails on a bad status', async () => {
  const t = createTranslator({ fetch: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(t.toUrdu('Olá'), /google-429/);
});
```

- [ ] **Step 2:** Run `node --test tests/translate.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement it in `server/translate.js`, using `AbortSignal.timeout(timeoutMs)`.
- [ ] **Step 4:** Run `node --test tests/translate.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Translate Portuguese into Urdu through Google".

### Task 3: Storing and merging the Urdu, and each person's choice

**Files:**
- Modify: `server/fields.js:4,7` (add `'urdu'` to `DECK_SHARED`; add `'urdu', 'urduRoman', 'urduOf', 'urduBy', 'urduAt'` to `CARD_CONTENT`)
- Modify: `js/store.js:403` (`SHARED_DECK_KEYS` gets `'urdu'`), `js/store.js:525` (urdu fields also need `mustEdit`)
- Modify: `server/sync.js` (`applyCard` merge, `applyDeck` stamping)
- Modify: `server/admin.js:50-53` (`giveTo` strips the personal Urdu prefs)
- Test: `tests/sync.test.js`, `tests/admin.test.js`, `tests/store.test.js`

**Interfaces:**
- Consumes: `mergeTopics(stored, incoming, fields, atKey)` from `server/fields.js`.
- Produces: stored cards keep server-written Urdu. `deck_prefs` holds a server-stamped `frontShowsAt`.

- [ ] **Step 1: Write the failing tests** in `tests/sync.test.js` (using its `seed`, `cardOf` and `deckOf`):
  - `'a stale card without Urdu keeps the stored Urdu'`. Write c1's Urdu straight into the db (`urdu: 'x', urduOf: 'back c1', urduBy: 'google', urduAt: NOW + 5`). Then `applyChanges` with c1 holding only `front` changed. The stored c1 must still have `urdu === 'x'` and the new `front`.
  - `'newer Urdu from the editor wins, older loses'`. Apply c1 with `urdu: 'manual', urduBy: 'manual', urduAt: NOW + 9`; stored becomes `'manual'`. Then apply `urdu: 'old', urduAt: NOW + 1`; stored stays `'manual'`.
  - `'frontShowsAt is stamped by the server when frontShows changes'`. Apply the deck with `frontShows: 'ur', frontShowsAt: 1` at `now = NOW + 100`. `buildView` gives `frontShowsAt === NOW + 100`. Applying it again unchanged at `NOW + 200` keeps `NOW + 100`.
  - In `tests/admin.test.js`, `'a new recipient does not get the owner\'s Urdu choice'`. Ana's prefs have `frontShows: 'ur', frontShowsAt: 1, urduScript: 'roman'`. After `assignDeck` to Ben, Ben's view of the deck has none of the three.
  - In `tests/store.test.js`, `'Urdu fields of a given deck cannot be edited'`. `updateCard` on a card of an `assigned` deck with `{ urdu: 'x' }` throws `read-only deck`.
- [ ] **Step 2:** Run `npm test`. Expected: those five FAIL.
- [ ] **Step 3: Implement.**
  - `applyCard`, for own→own: after the topic merge, `merged = mergeTopics(stored, merged, URDU_FIELDS, 'urduAt')`. This also covers the incoming copy lacking the fields, because missing `urduAt` counts as 0.
  - `applyDeck`: read the stored prefs. If `prefs.frontShows !== stored.frontShows`, set `prefs.frontShowsAt = now`. Otherwise copy `stored.frontShowsAt`, or delete it if absent. Pass `now` from `applyChanges` through `each(changes.decks, …)`.
  - `giveTo`: destructure out `frontShows, frontShowsAt, urduScript` beside `hidden`.
- [ ] **Step 4:** Run `npm test`. Expected: all PASS.
- [ ] **Step 5:** Commit with the message "Keep cards' Urdu through syncs and stamp each person's front choice".

### Task 4: The translation queue, its startup scan and the backfill script

**Files:**
- Create: `server/urdu-queue.js`, `scripts/translate-urdu.js`
- Modify: `server.js` (create the queue in `createRecallServer`, scan after `sync`, scan every `urdu` deck at start, accept a `translator` option the way `sorter` and `tts` are accepted)
- Test: `tests/urdu-queue.test.js`, and one case in `tests/http.test.js`

**Interfaces:**
- Consumes: `needsUrdu`, `portugueseText` and `URDU_FIELDS` (Task 1); `createTranslator().toUrdu` (Task 2).
- Produces:
  - `createUrduQueue({ db, translator, pauseMs = 300, now = Date.now, log = console.error }) -> { scanDeck(deckId): void, scanAll(): void, idle(): Promise<{ translated, failed }> }`. `scanDeck` adds the deck's cards where `needsUrdu` is true and that aren't already queued. Cards are worked one at a time with `pauseMs` between them.
  - Write rule: re-read the card just before writing. Write only if its Portuguese still equals the text that was sent **and** its `urduAt` hasn't changed since it was queued. Then set `urdu`, `urduRoman`, `urduOf` (the sent text), `urduBy: 'google'` and `urduAt: now()`. A failed card is logged, left untouched and dropped from the queue, so the next scan retries it. `idle()` resolves when the queue is empty, with counts since the last `idle`.

- [ ] **Step 1: Write the failing tests** (in-memory db seeded through `applyChanges`, a fake translator returning `{ urdu: 'ur:' + text, urduRoman: 'rom:' + text }`, `pauseMs: 0`):
  - `'fills every card of an urdu deck and none of another deck'`
  - `'skips cards whose Portuguese is empty and does not call the translator for them'`
  - `'a card edited by hand while queued is not overwritten'`. The translator awaits a promise; during the wait, write `urduBy: 'manual', urduAt: NOW + 50` to the card; after `idle()` the card still says `manual`.
  - `'a failure is counted, logged and retried on the next scan'`. The translator throws once; `idle()` → `{ translated: 2, failed: 1 }`; `scanDeck` again, `idle()` → `{ translated: 1, failed: 0 }`.
  - `'a card changed to new Portuguese is translated again; a manual one is not'`
  - In `tests/http.test.js`: `'a sync on an urdu deck queues its new cards'`. Start the server with a fake `translator`, sync a deck with `urdu: true` and one card, await `server.urduQueue.idle()`, and check that `GET /api/state` returns the card with `urdu`. Expose `urduQueue` on the returned server object as `sorter` is exposed, or through a test-only option if the server doesn't expose that.
- [ ] **Step 2:** Run `node --test tests/urdu-queue.test.js tests/http.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the queue. Wire it into `server.js`:
  - `translator` option, defaulting to `createTranslator()`.
  - After `applyChanges` in `sync()`, call `urduQueue.scanDeck(id)` for each distinct `deckId` in `changes.cards` and each `id` in `changes.decks`.
  - Call `scanAll()` once after start; it scans decks whose data has `urdu: true`.
  - **Script** `scripts/translate-urdu.js --data <dir> --deck "<name>"`: opens `<dir>/recall.db`, finds the deck by name (exits 1 with "No deck named …" if missing), refuses with "Switch on Translate the front into Urdu first" when `urdu` isn't set, runs `scanDeck` and `idle()`, and prints `Translated N, failed M, already done K.`.
- [ ] **Step 4:** Run `npm test`. Expected: all PASS.
- [ ] **Step 5:** Commit with the message "Translate an Urdu deck's cards in the background, and add a script to fill one at once".

### Task 5: The admin's Urdu switch for a person

**Files:**
- Modify: `server/db.js` (after `db.exec(SCHEMA)`, add the two `assignments` columns when `pragma table_info(assignments)` lacks them)
- Modify: `server/admin.js` (`ownedDecks` recipients get `urdu: boolean`; new `setUrduSwitch`)
- Modify: `server/sync.js` (`givenDecks` selects `a.urdu, a.urdu_at`; `buildView` adds `urduSwitch` and `urduSwitchAt` when `urdu_at` isn't null; `VIEW_ONLY` gets both)
- Modify: `server.js` (route `POST /api/admin/decks/:id/urdu`, body `{ userId, on }`, answering 204; `not-owner` → 404, `not-given` → 400, bad body → 400)
- Modify: `js/api.js` (`admin.setUrdu(deckId, userId, on)`)
- Test: `tests/db.test.js`, `tests/admin.test.js`, `tests/http.test.js`

**Interfaces:**
- Produces:
  - `setUrduSwitch(db, { ownerId, deckId, userId, on }, now) -> void`. Throws `Error('not-owner')` or `Error('not-given')` (no assignment row).
  - View fields `urduSwitch` and `urduSwitchAt`, consumed by `frontShows` (Task 1).
  - `api.admin.setUrdu(deckId, userId, on)`.

- [ ] **Step 1: Write the failing tests:**
  - db: `'an old database gets the assignment Urdu columns'`. Create `assignments` without them, then call `openDb`; `pragma table_info` lists `urdu` and `urdu_at`.
  - admin: `'switching Urdu on shows in the recipient\'s view and survives their sync'`. Give d1 to Ben and call `setUrduSwitch(..., on: true, NOW + 10)`. Ben's view has `urduSwitch: true, urduSwitchAt: NOW + 10`. Then Ben syncs his deck object, including those view fields, with `frontShows: 'en'` at `NOW + 5`. Ben's view still has `urduSwitch: true`, and the switch fields aren't stored in his `deck_prefs`.
  - admin: `'ownedDecks lists each recipient\'s Urdu switch'` and `'setUrduSwitch refuses a deck not given to that person'`.
  - http: `'POST /api/admin/decks/:id/urdu needs the owner'`. A non-admin gets 403. Bad body gets 400.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement as listed under Files.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Let the admin switch Urdu on for a person".

### Task 6: Showing the Urdu, and the choices in Deck settings

**Files:**
- Modify: `js/app.js`:
  - `openDeckDialog`, ~line 540. Owner only: the **Translate the front into Urdu** checkbox, saved as `urdu`. On a deck with `urdu`, for everyone: **Front shows** (`frontShows`) and **Urdu writing** (`urduScript`), shown after the language row with a note: "Urdu comes from Google Translate. The back stays Portuguese."
  - Study face, line ~3111. The card list, line ~2265.
- Modify: `css/styles.css` (`.urdu` class)

**Interfaces:**
- Consumes: `shownSide`, `englishSide` and `frontShows` (Task 1).
- Produces: `sideFace(card, deck, side) -> Node[]` in `js/app.js`. For a side that isn't the English side, or when `shownSide().urdu` is null, it returns today's `rich(card[side])`. Otherwise it returns `rich(english)` (when not null) followed by `<div class="urdu" lang="ur" dir="rtl">` holding Urdu script, or `<div class="urdu roman" lang="ur-Latn">` holding Roman Urdu. Urdu text is set as text, never parsed as markup.

- [ ] **Step 1:** Add `sideFace` and use it on both faces in `renderStudy` and for both columns of the card list. Also use the Urdu text in the `isShort` test of the face, so a short Urdu line gets the large type.
- [ ] **Step 2:** In `css/styles.css`, `.urdu` uses the `.brand-ur` font stack and `line-height: 1.9` (Nastaliq needs the room), with `margin-top: 0.4em` when it follows English. `.urdu.roman` uses the normal font and `font-style: italic`.
- [ ] **Step 3:** Run `npm test`. Expected: PASS (nothing tested breaks).
- [ ] **Step 4: Check in the browser** with the `run` skill on `RECALL_DATA=<scratch dir> node server.js`, using a local deck with `backLang: 'pt-PT'`, `urdu` switched on and a fake or real translation. Expected:
  - with English chosen, the card is as before;
  - with Urdu, the right-to-left Urdu line shows alone;
  - with Both, English sits above the Urdu;
  - Roman Urdu shows in italics;
  - a reversed copy shows Urdu on its back;
  - this works at phone width.
  Take screenshots in light and dark.
- [ ] **Step 5:** Commit with the message "Show a card's Urdu on its English side, as each person chooses".

### Task 7: Reading the Urdu aloud

**Files:**
- Modify: `tts.js:22` (`VOICES` gets `'ur-PK': 'ur-PK-UzmaNeural'`)
- Modify: `js/app.js:383-430` (speech)
- Test: `tests/http.test.js`, or the existing tts test if there is one (`grep -l createTts tests`)

**Interfaces:**
- Consumes: `shownSide` (Task 1). Urdu is always spoken from `card.urdu` (script), never `urduRoman`.
- Produces: `sideSpeech(card, deck, side) -> Array<{ text, lang }>`. The English side with Urdu shown gives `[{ english, sideLang }, { card.urdu, 'ur-PK' }]`, leaving out the English part when it isn't shown. Any other side gives today's single part. `speakSideOf` plays the parts in order, and the next part starts on the previous `Audio`'s `ended` (or, without a server voice, `SpeechSynthesisUtterance`'s `end`). `stopSpeaking` cancels the rest through the existing `speechToken`. `prepareSideSpeech` prepares every part. `speakButton` shows when any part has text.

- [ ] **Step 1: Write the failing test:** `'an ur-PK request picks the Urdu voice'`. With a fake Azure config, `createTts(...).engines('ur-PK')` lists `azure:ur-PK-UzmaNeural` first. If `engines` isn't exported, assert on the `engine` name that `speak` reports instead.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement the `tts.js` line and the `sideSpeech` / sequential playback in `js/app.js`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. Then check in the browser: the speaker button on the front reads English then Urdu with Both, and Urdu alone with Urdu. Auto-play does the same. Moving to the next card mid-speech stops it.
- [ ] **Step 5:** Commit with the message "Read a card's Urdu aloud in an Urdu voice".

### Task 8: Correcting translations, and the Urdu switch in the Give dialog

**Files:**
- Modify: `js/app.js` `openCardDialog` (~line 735), and `openGiveDialog` (~line 3811)

**Interfaces:**
- Consumes: `api.admin.setUrdu` (Task 5); `portugueseText` (Task 1); `recipients[].urdu` from `ownedDecks` (Task 5).
- Produces: no new exports.

- [ ] **Step 1: Card editor.** When editing a card of an owned `urdu` deck, show **Urdu** (`dir="rtl"`, `lang="ur"`, the `.urdu` font) and **Roman Urdu** text boxes under the English side's box, filled from the card.
  - On save, if either box changed, add `urdu`, `urduRoman`, `urduOf: portugueseText(card, deck)`, `urduBy: 'manual'` and `urduAt: Date.now()` to the `updateCard` patch.
  - **Translate again** clears both boxes and, on save, writes `urdu: ''`, `urduRoman: ''`, `urduBy: 'google'` and `urduAt: Date.now()`. The server queue then re-translates the card (`needsUrdu` is true for empty Urdu), and its newer `urduAt` wins.
  - Below the boxes: "Google will translate this again shortly after you save."
  - If `card.urduBy === 'manual'` and `urduOf !== portugueseText`, show "The Portuguese has changed since this Urdu was written."
  - Not shown when adding a card. A new card is translated by the queue.
- [ ] **Step 2: Give dialog.** On a deck whose admin data marks it `urdu`, add an **Urdu** checkbox after each person's name. If `ownedDecks` doesn't carry the deck's `urdu` flag, add `urdu: Boolean(parse(d.data).urdu)` to it and to Task 5's test. The checkbox is enabled only while that person is ticked and is filled from `recipients[].urdu`. On Save, after assign/unassign, call `api.admin.setUrdu` for each person whose box changed, inside the same `adminChange`, and add "Urdu on for X" / "Urdu off for X" to the toast.
- [ ] **Step 3:** Run `npm test`. Expected: PASS.
- [ ] **Step 4: Check in the browser** as admin with a second local account:
  - Tick Urdu for them. They see Urdu on their next refresh.
  - They pick English. English sticks.
  - In the editor, change a translation. The other account sees the fix.
  - Press Translate again. The card's Urdu comes back from Google, which needs network access, so with a fake translator check that the queue ran.
- [ ] **Step 5:** Commit with the message "Correct a card's Urdu in the editor, and switch Urdu on per person when giving a deck".

### Task 9: README, and handing over the rollout

**Files:**
- Modify: `README.md` (one Features bullet, **Urdu on the front.**, and a line under "Giving decks" about the Urdu checkbox)
- Modify: `deploy/RUNBOOK.md` (a short section: switch it on in Deck settings, optionally run `node scripts/translate-urdu.js --data /var/lib/recall --deck "Portuguese A1"` as the `recall` user, spot-check translations, tick Urdu per person)

- [ ] **Step 1:** Write both sections, describing behaviour in the README's plain style.
- [ ] **Step 2:** Run `npm test`. Expected: PASS.
- [ ] **Step 3:** Commit with the message "Describe Urdu on the front and how to roll it out".
- [ ] **Step 4:** Stop and ask the owner before deploying to the live server or switching the deck on there. Both reach other people and send the deck's Portuguese to Google.
