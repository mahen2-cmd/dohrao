# Topics and groups inside a deck — design

Date: 2026-11-12
Status: awaiting owner approval (builder check done, owner's answers folded in)

## Intent

Portuguese A1 holds 6,551 cards (6,058 of them on the reserve) and feels like one long,
undifferentiated list. The owner wants to **study one topic at a time**, such as verbs, and
also keep the option of studying everything mixed, as today.

Success: the owner opens Portuguese A1, picks **Verbs**, and gets only verb cards: their due
reviews and new verb cards. Tomorrow they pick **Everything** and get the normal mixed
session. New cards they add later land in the right topic without them doing anything.

## Model

- A deck can have **groups**, and each group holds **topics**. Two levels only.
- Each card belongs to **at most one topic**. A card with no topic is *Unsorted*.
- Example (Portuguese A1, agreed with the owner):

| Group | Topics (from the `new_cards_<topic>.csv` file names) |
|---|---|
| Verbs | verb_ser, verb_estar, verb_ter, verb_ir, verb_fazer, verb_falar, verb_gostar, verb_querer, verb_precisar, verb_morar_viver, verb_chamar_se, verb_questions |
| Grammar | articles_o_a, articles_os_as, articles_um_uma, de_contractions, em_contractions, masculine_nouns, feminine_nouns, gender_exceptions, adjective_agreement, more_plurals, possessives, possession, negation, noun_phrases, this_and_that |
| About me | name_answers, age, origin, address, contact_details, personal_details, personal_info, short_profile, spelling_clarifying, i_am_a |
| Work | professions, everyday_jobs, more_jobs, job_descriptions, job_gender, job_questions, talk_about_work, workplaces |
| Things and places | basic_objects, everyday_objects, home_objects, classroom_objects, clothes, technology, house_rooms, describe_things, talk_about_objects, where_objects_are |
| Out and about | cafe_drinks, cafe_ordering, saying_what_you_need, language_school |
| Everyday phrases | animals, numbers_11-19, short_sentences, who_is_that |

  Topic display names are the file names made readable ("verb_ser" → "Ser",
  "cafe_ordering" → "Café ordering"); exact wording is the builder's call.
  `new_cards_all.csv` is not a topic (it duplicates the others) and is ignored.
  Greetings and introductions (*Olá*, *Bom dia*, *Chamo-me…*) have no file today; the
  sorter (below) will place them, probably in About me or Everyday phrases, or propose a
  new *Greetings* topic.

## Goals

1. **Study by topic.** When starting a session on a deck, the learner chooses:
   - **Everything** (default, identical to today's behaviour);
   - **one group** (all its topics), **one topic**, or **several** groups/topics together.
   The session holds that deck's due learning cards, due reviews and new cards **that are in
   the chosen topics**, and nothing else.
2. **Scheduling is untouched.** A card answered in a topic session is scheduled exactly as in
   a mixed session. The filter only decides which of today's cards are shown. Cards outside
   the filter stay due and wait.
3. **Pull from the reserve by topic.** "Pull in N" can be limited to a group or topic, so the
   owner can bring in 20 new verb cards without touching anything else.
4. **See and change topics.** In a deck's card list: a topic filter, the topic shown on each
   card, and a way to move selected cards to another topic. Topics and groups can be renamed,
   moved between groups, created and deleted (deleting makes its cards Unsorted).
5. **Automatic sorting for the admin's decks.**
   - **Topic files:** importing a CSV/Excel file whose name is `new_cards_<topic>.csv` puts
     its cards in topic `<topic>`. If that topic doesn't exist yet, it is created and placed
     in a group: by name prefix if other topics share it (`verb_…` → Verbs), otherwise by the
     AI sorter. No AI call for the cards themselves.
   - **Everything else** in a deck **owned by the admin** — cards typed in, cards from files
     with other names, Anki imports, and the existing unsorted cards — is sent to an AI
     model, which places each card in one of the deck's existing topics.
   - **A deck with no topics yet** (e.g. Modern Robotics, Pakistani Cooking, the BJJ decks):
     runs only when the admin asks for it ("Sort this deck"), in **two steps** (owner's
     decision):
     1. the AI proposes groups and topics for the deck from its cards, and the admin sees the
        proposal and can rename, merge, move or delete groups and topics;
     2. only after the admin approves are the cards placed, against the approved list.
     Groups and topics the admin approved count as the admin's own (the sorter never renames
     or deletes them); the card placements from step 2 count as `ai`.
   - **"Sort now" only sends Unsorted cards** (Claude's call). Cards already placed by the
     AI are never moved again automatically, so a sort stays cheap and cards don't shift
     after the owner has started studying by topic. The owner moves cards by hand when needed.
   - **When nothing fits,** the sorter may create a new topic in the best group rather than
     forcing a bad fit.
6. **The owner has the last word.** A card or topic the admin placed by hand is never moved
   by the sorter again.
7. **One-off sort of Portuguese A1** as part of shipping this:
   - match existing cards to the topic files by front+back text (measured: **4,825 of 6,551**
     match exactly one file, none match two);
   - create the 7 groups above;
   - send the remaining **1,726** cards (about 493 already studied, 203 from Anki) to the AI
     sorter.

## Who gets what

| | Admin's own decks | Decks given to a user | A user's own decks |
|---|---|---|---|
| Topics and groups exist | Yes | Yes (the admin's) | Yes |
| Study by topic, pull reserve by topic | Yes | Yes | Yes |
| Change topics | Yes | **No** (read-only, like the card content) | Yes, by hand |
| Automatic sorting | File names + AI | — (arrives sorted) | **File names only. No AI, ever.** |

The owner's rule: **only the admin's cards are ever sent to the AI service.** The server must
enforce this (the sort endpoint is admin-only and refuses decks the admin doesn't own), not
just the interface.

## Non-goals

- More than two levels (no sub-sub-topics).
- A card in several topics at once, or free-form tags.
- A single "Today" queue across decks (rejected earlier in PRODUCT.md).
- AI sorting for non-admin users.
- Changing how anything is scheduled.

## Anti-goals (failure even if it "works")

- Any change to due dates, intervals or ease from sorting or filtering.
- The sorter overriding something the owner placed by hand.
- Any non-admin user's card text reaching the AI service.
- Studying blocked or slowed while sorting runs or the AI service is down. New cards are
  usable immediately as Unsorted; sorting catches up in the background.
- A topic session silently using up the whole day's new-card allowance in one topic without
  that being visible (see Constraints).

## Constraints and existing facts

- Stack: plain HTML/CSS/JS in the browser, plain Node server with built-in SQLite, no build
  step. Dependencies are allowed but kept few (PRODUCT.md).
- Storage (`server/db.js`, `server/fields.js`): decks and cards are JSON in `decks.data` and
  `cards.data`. `DECK_SHARED` and `CARD_CONTENT` decide which fields are shared content vs
  per-user progress. Topics/groups and a card's topic are **content** (shared to recipients
  of a given deck); the learner's chosen filter is **personal**.
- Study queue: `queue(deckId, now)` in `js/store.js` builds learning / review / new lists;
  `counts`, `upcoming` and `nextCard` use it. Route is `#/study/<deckId>`.
- The new-cards-per-day allowance stays **one shared total per deck** (owner's decision):
  new cards introduced in a Verbs session count toward the deck's daily total. In `queue()`
  the allowance is computed deck-wide as today, then the new list is filtered by topic and
  sliced. The topic picker shows how many new cards are left today for the deck.
- The owner's live data is on the server (`/var/lib/recall/recall.db`). The local
  `data/recall.db` is empty and `data/recall.json` is an older single-user copy. The one-off
  sort must run against the live database (with a backup first), as `scripts/migrate-json.js`
  did.
- Unsent changes and offline answers (`js/store.js` pending queue) must keep working; topic
  edits travel through the same `api/sync` path as other content changes.

## AI sorting — decided parts

- **Provider:** Anthropic's API, through the official `@anthropic-ai/sdk` package (server
  only). Key read from `ANTHROPIC_API_KEY`, or a file in the data folder like `tts.json`.
  With no key, AI sorting is off and cards stay Unsorted; everything else works.
- **Model:** `claude-opus-5-5` at low effort, using structured outputs
  (`output_config.format`) so the reply is always valid JSON (`card id → topic id`, plus any
  proposed new topics). Server-side refusal fallback (`fallbacks: "default"`) switched on.
  The model id is one setting so the owner can switch to a cheaper model later.
- **Batching:** cards are sent in batches (about 100 per request) with the deck's group/topic
  list, so the 1,726-card backfill is a few dozen requests. A small charge per batch; the
  owner has accepted that.
- **When it runs:** after an import or a card is added to an admin-owned deck, in the
  background on the server. On failure (no network, rate limit, refusal) the cards stay
  Unsorted and are retried later; the admin sees an "N unsorted" count with a "Sort now"
  button.
- **What is sent:** front and back text only (maths as LaTeX source, images left out), plus
  the deck's topic names.
- Each card records how it got its topic (`file`, `ai` or `manual`) so goal 6 can be kept.

## Left to the builder

- Where the topic picker sits (on the Start review step, the deck page, or both) and how it
  looks on a phone, within the "Night minimal" look in PRODUCT.md.
- Whether the last chosen filter is remembered per deck (suggested: yes, as a personal deck
  pref) and how the session's filter is put in the URL.
- Exact prompt wording for the sorter, batch size, retry timing.
- Whether `counts` on the deck list stays deck-wide (suggested: yes) with per-topic counts
  only inside the picker.
- How deleting a group handles its topics (suggested: they become ungrouped topics, not
  deleted).
- Tests: queue filtering, allowance sharing, ownership rules for topic edits on given decks,
  the admin-only gate on sorting, manual placements surviving a re-sort, and the one-off
  matcher.
