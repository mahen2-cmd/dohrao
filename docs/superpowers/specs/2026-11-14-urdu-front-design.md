# Urdu on the front of Portuguese A1

## Intent

The admin has given the **Portuguese A1** deck to people whose stronger language is Urdu, not English. Today every card's front is English and its back European Portuguese. They should be able to learn the Portuguese from Urdu: each person chooses whether the front shows **English**, **Urdu** or **both**, and the back stays Portuguese.

## Goals

- Every card in Portuguese A1 carries a natural Urdu translation, in Urdu script and in Roman Urdu, taken from Google Translate.
- Each person chooses, in their own **Deck settings** for the deck, what the front shows: English, Urdu or both. Separately they choose the Urdu's script: **Urdu script** (default) or **Roman Urdu**.
- The admin can switch Urdu on for a particular person (per deck). Switching it on sets that person's front to Urdu; they can still change it themselves afterwards.
- The Urdu is read aloud, like the other sides: the speaker button and auto-play read it in an Urdu voice.
- Cards the admin adds or edits later get their Urdu automatically.
- The admin can correct a bad translation by hand in the card editor, and the fix reaches everyone.

## Non-goals

- Not a general "any extra language on any deck" feature (approach C). Only Urdu, only on decks where the admin has switched translation on (Portuguese A1 for now). The code should not make adding another deck or language later hard, but builds nothing for it now.
- The back is unchanged: always Portuguese.
- No change to how cards are scheduled, imported or exported.

## Anti-goals

- Nobody's progress, schedule or reserve changes because of this.
- People who never touch the setting see exactly what they see today (English), unless the admin switches Urdu on for them.
- A person's choice must not be silently undone by syncing from another device or by the admin editing a card.

## Constraints

- Translations come from Google Translate's free, unofficial endpoint (`translate.googleapis.com/translate_a/single?client=gtx&sl=pt&tl=ur&dt=t&dt=rm&q=…`), the same family of no-account Google service the app already uses for voices (`tts.js`). Checked on 2026-11-14: for "Onde moras?" it returns Urdu script `آپ کہاں رہتے ہیں؟` in `[0][0][0]` and Roman Urdu `aap kahan rahte hen?` in the romanisation entry (`[0][1][3]` of the response; the last item of `[0]`). Google could block it someday; translations already saved keep working.
- Google's voice reads Urdu (`translate_tts?tl=ur` returned audio). Azure has `ur-PK-UzmaNeural`; Edge the same voice.
- Shared deck content syncs through `DECK_SHARED` / `CARD_CONTENT` (`server/fields.js`); personal deck settings through `deck_prefs`. A client syncing a stale card overwrites stored content (`applyCard`, `server/sync.js`), so server-written fields need a merge rule, as topics already have (`mergeTopics`).
- The live data is on the production server (see the runbook); the local `data/recall.db` is empty. The backfill must run there.

## Approaches

- **A. Store the Urdu on each card, translated on the server (picked).** New shared card fields hold the Urdu; a one-time script fills every existing card, the server re-translates cards when their Portuguese changes; each person's choice is a personal deck setting. Same Urdu for everyone, instant, works offline, correctable once for everyone, audio cached.
- **B. Translate in each person's browser when a card is shown.** Dropped: no corrections, a wait on first show, no offline, far more calls to the free service.
- **C. General extra front languages for any deck.** Dropped for now: more work for something not asked for; A can grow into it.

## Design

### Turning it on for a deck

- A shared deck field `urdu: true` (added to `DECK_SHARED` in both `server/fields.js` and `js/store.js`). The admin sets it in that deck's **Deck settings** with a checkbox "Translate the front into Urdu" (owner only). Everything below only appears on decks with `urdu: true`.
- Switching it on triggers the server to translate every card in the deck that lacks Urdu (same job as the backfill, below).

### Card data

Shared card fields, added to `CARD_CONTENT`:

- `urdu` — Urdu script text.
- `urduRoman` — Roman Urdu text.
- `urduOf` — the exact Portuguese text these were made from, so a change to the Portuguese can be detected.
- `urduBy` — `'google'` or `'manual'`.
- `urduAt` — when the Urdu was last written, by the queue or by a hand edit.

Which side is Portuguese: the deck's side whose language is `pt-PT` (normally `back`; on a `reversed` card it is the card's `front`). The Urdu always belongs with the **English side** of the card: the front on a normal card, the back on a reversed copy. Reversed copies get their own translation (they are separate cards).

Merge rule in `applyCard` (own decks), *(builder-check call)*: the five Urdu fields merge as one unit by `urduAt`, newest wins, with the same helper as topics (`mergeTopics(stored, incoming, ['urdu','urduRoman','urduOf','urduBy'], 'urduAt')`). An incoming card that lacks them keeps the stored ones, so an admin device that hasn't yet seen the server's translation never erases it. Newest-wins (not "manual beats google") is what lets **Translate again** undo a hand correction, and lets a fresh server translation beat an offline device's stale copy.

`urduBy` only decides what happens when the Portuguese changes: after a sync, if the card's Portuguese no longer matches `urduOf` and `urduBy` is `google`, the card is queued for re-translation. A `manual` translation is kept, and the editor shows a note that the Portuguese changed since.

### Translating

- A small server module (`server/translate.js`) that, given Portuguese text, returns `{ urdu, urduRoman }` from the endpoint above. Text is cleaned first the way speech text is (no images, maths or markup).
- A queue that runs in the background on the server, one request at a time with a short pause between, retrying a failed card later. It runs: when `urdu` is switched on for a deck, after a sync that adds or changes a card's Portuguese on an `urdu` deck, and once at server start for any `urdu` card still missing Urdu.
- After the queue writes a card, people get the new fields through the normal state/sync path the next time their device fetches (as topic sorting already does).
- A script, `scripts/translate-urdu.js --deck "<name>"`, runs the same fill once by hand on the server, and reports how many cards were translated, skipped and failed.

### Each person's choice

Personal deck settings (stored in `deck_prefs`, not shared):

- `frontShows`: `'en'`, `'ur'` or `'both'`.
- `frontShowsAt`: when they last chose it.
- `urduScript`: `'arabic'` (default) or `'roman'`.

*(Builder-check calls.)* `frontShowsAt` is stamped by the server in `applyDeck` when `frontShows` differs from the stored value, so it and the admin's `urdu_at` come from one clock. `giveTo` (`server/admin.js`) drops `frontShows`, `frontShowsAt` and `urduScript` from the owner's prefs it copies to a new recipient, as it already drops `hidden`, so the admin's own choice never reaches anyone else.

In **Deck settings**, on an `urdu` deck, everyone (owner and recipients) sees:

- **Front shows**: English / Urdu / Both.
- **Urdu writing**: Urdu script / Roman Urdu.

### The admin's switch for a person

- Stored on the assignment, not in the person's `deck_prefs`, so the person's devices can't overwrite it when they sync: two new columns on `assignments`, `urdu INTEGER` (0/1) and `urdu_at INTEGER`.
- In the **Give "Portuguese A1" to…** dialog, on an `urdu` deck, each person ticked for the deck gets a second checkbox, **Urdu**. Saving sends it to a new admin route (e.g. `POST /api/admin/decks/:id/urdu` with `{ userId, on }`).
- The person's view gets `urduSwitch` and `urduSwitchAt` as view-only deck fields (added to `VIEW_ONLY` in `server/sync.js`).
- **What the front shows** for a person = whichever is newer: their own `frontShows` (at `frontShowsAt`) or the admin's switch (at `urduSwitchAt`: on → `'ur'`, off → `'en'`). Neither set → `'en'`. So switching it on changes their front to Urdu right away, and their own later choice wins after that.

### On the card

- Study, the card list preview and the editor's preview draw the English side through one function that, on an `urdu` deck, returns English, Urdu or both according to the person's choice and script. With both: English on top, Urdu below it, separated by a little space.
- Urdu script is set right-to-left (`dir="rtl"`, `lang="ur"`) in a font that shows Nastaliq or Naskh well (e.g. Noto Nastaliq Urdu from Google Fonts, falling back to the system). Roman Urdu is left-to-right in the normal font.
- A card with no Urdu yet (translation still pending or failed) shows English, whatever the choice.

### Sound

- Urdu is always read from the Urdu script text, even when Roman Urdu is shown (a voice cannot read Roman Urdu well).
- Add `ur-PK` to `LANGUAGES` (`js/app.js`) and `'ur-PK': 'ur-PK-UzmaNeural'` to `VOICES` (`tts.js`); Google is called with `tl=ur`.
- The English side's speaker button and auto-play read what is shown: English, Urdu, or English then Urdu when both are shown.
- Urdu audio is cached like the rest and made ahead of time when the deck keeps audio.

### Editing

- In the card editor, on an `urdu` deck, the admin sees two more boxes under the English side, **Urdu** and **Roman Urdu**, filled with the current translation. Changing either one saves it as `manual`. A small **Translate again** button replaces both with Google's translation of the current Portuguese and marks it `google` with a new `urduAt`, so it wins over the manual one.
- Recipients can't edit cards (unchanged), so they never see these boxes.

### Rollout on the live server

1. Deploy.
2. Switch on **Translate the front into Urdu** for Portuguese A1 in its Deck settings. The server fills the whole deck in the background, or `scripts/translate-urdu.js` is run on the server to do it at once and see the report.
3. Spot-check translations; correct any in the editor.
4. Switch on **Urdu** for the people who want it in the Give dialog.

## Left to the builder

- Exact parsing of the Google response, with tests on a saved response.
- Request pacing and retry timing for the queue.
- The Urdu font choice and size so it looks even with the English.
- Whether the Admin screen shows translation progress ("312 of 480 translated").
- How the new `assignments` columns are added to an existing database (the schema uses `CREATE TABLE IF NOT EXISTS`, so an `ALTER TABLE` guarded by a column check).
