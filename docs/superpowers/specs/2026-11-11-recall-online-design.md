# Recall online: friends-and-family accounts — design

Date: 2026-11-11
Status: awaiting owner approval (builder check done, owner's answers folded in)

## Intent

Recall today is a single-person app: one Node server on the owner's computer, one data file
(`data/recall.json`), no logins, reachable only from `localhost`. The owner wants to put it on
the internet for **a small private group of friends and family** (a guessed 5–30 people), each
with their own account, and to act as **admin** who makes decks (for example the textbook
decks built from `.apkg` packages) and hands them to specific people.

Success: a family member gets an invite code, signs up on their phone, finds the decks the
admin gave them waiting, and studies them every day with their own progress. When the admin
fixes a card, everyone who has that deck sees the fix the next time they study, and nobody
loses progress.

## Goals

1. **Public web address over HTTPS**, working well in a phone browser (primary) and on laptops.
2. **Accounts.** Sign-up needs an **invite code**; then log in with email (or username) and
   password. Each person's decks, cards, progress, statistics and settings are private to them.
3. **Admin role** (the owner). The admin can:
   - see the list of accounts;
   - create invite codes;
   - give a deck to specific people;
   - reset a person's password (there is no reset-by-email).
4. **Assigned decks stay linked.** A deck the admin gives someone is not a frozen copy. When
   the admin edits, adds or deletes cards in it, every recipient's deck reflects that, and
   each recipient keeps their own scheduling progress on every card that still exists.
   Deleting a card removes it for recipients too (owner's call).
5. **Users can import their own decks** (Anki `.apkg`, CSV/Excel) and create cards, exactly as
   now. These are private to that user.
6. **Read-aloud keeps using Google Translate's voice first** (owner's explicit choice), with the
   existing fallbacks behind it. Audio is generated once per sentence **on the server and
   shared by all users**; the phone also caches audio it has played so replays need no
   request. The existing ~53 MB of cached audio is carried over.
7. **The owner's current data becomes the admin account**: all existing decks, cards, progress,
   daily/log stats, settings, images and audio, with nothing lost.
8. **Running cost under $10/month.**
9. **Nightly backups** of all data.

10. **Assigned decks arrive entirely on the recipient's reserve** (owner's decision). Nothing
    from an assigned deck is in study until the recipient pulls cards in themselves, at their
    own pace. Cards the admin adds to the deck later also go onto each recipient's reserve.

## Non-goals

- **The no-login, run-it-on-your-own-computer mode.** The online version replaces it outright
  (owner's decision). The GitHub repository becomes private, and the README is rewritten
  for the hosted app and its deployment.
- App-store apps. (Installable to the home screen as a web app is welcome but optional.)
- Offline study.
- Password-reset emails, or any email sending at all.
- Payments, public sign-up, marketing site.
- Sharing between ordinary users (only the admin gives decks).
- Recipients editing the content of an assigned deck (see open points for the builder).

## Anti-goals (would count as failure even if it "works")

- A stranger who finds the URL can sign up or read anyone's data.
- One person's reviews change another person's schedule or statistics.
- An admin edit to a shared deck resets or loses recipients' progress.
- The owner's existing progress is lost or reset in the move.
- The phone experience gets worse than today's.
- Monthly cost creeps beyond $10.

## Constraints and what exists

- **Stack:** plain HTML/CSS/JS front end (`index.html`, `js/`), one Node server (`server.js`),
  no npm dependencies. `node:sqlite` is already used by `anki.js` (Node ≥ 22.15). Keep the
  no-dependency style unless a dependency is clearly worth it.
- **Sync model today:** the client loads the *whole* state with `GET /api/state` and saves the
  *whole* state with `PUT /api/state` (`js/store.js`), also mirroring it in `localStorage`
  and keeping whichever copy is newer. The state is
  `{ version, decks, cards, daily, log, settings, savedAt }`; cards carry both content
  (`front`, `back`) and schedule fields (`state`, `due`, `stability`, `ease`, …) and a
  `deckId`. Reserve cards have `reserved`/`order`.
- **Server today** refuses requests whose Host is not localhost and has no auth; that must
  change for public hosting.
- **Images** live in `data/media/` named by content hash (already shareable across users);
  **audio** in `data/audio/`, also keyed by content.
- **Existing tests** use `node --test`; new behaviour should come with tests in the same style.
- The `localStorage` mirror must be per user (a shared phone or a logged-out user must not
  see someone else's cards).

## Decisions made

By the owner:
- Audience: friends and family; separate accounts; invite-code sign-up.
- Mostly phones, some laptops.
- Admin gives decks to specific people (not a public library).
- Recipients' copies pick up the admin's later changes and keep their progress.
- Users can import their own decks.
- Google Translate voice, server-cached and shared.
- Budget under $10/month; no hosting chosen yet.
- Assigned decks land fully on the recipient's reserve; later additions go to their reserve too.
- Online version only; no localhost/no-login mode to maintain; repository private.

Calls made by Claude (owner may override):
- **Hosting:** one small VPS (e.g. Hetzner CX22 or similar, ~$4–6/month) running the Node app
  behind **Caddy** for automatic HTTPS, plus a domain (~$10–15/year). Chosen because the app
  writes files to disk and free tiers tend to wipe disks or sleep. Process kept alive with
  systemd.
- **Storage:** move from the single JSON file to a SQLite database (`node:sqlite`), with
  images and audio staying as files on disk.
- **Passwords:** hashed with `crypto.scrypt` (built in), login via an HTTP-only, Secure,
  SameSite cookie session stored server-side.
- **Deleted cards in an assigned deck** disappear for recipients, progress included.
- **Forgotten password:** admin resets it from the admin view.
- **Backups:** nightly copy of the database (SQLite online backup or `VACUUM INTO`) kept for
  30 days on the server, as today. Off-server copies are out of scope for now.
- **Recipient's reserve order:** on assignment, the recipient's reserve takes the deck's
  order as the admin sees it: the admin's studied cards first (oldest first), then the
  admin's reserve in its arranged order. From then on the recipient's reserve order is
  theirs. They can rearrange or reverse it, and the admin's later reordering does not
  reach them. Cards added later go to the end of each recipient's reserve.
- **Deck settings, shared vs personal:** a deck's content settings belong to the deck and
  follow the admin's changes: `frontLang`, `backLang` and `saveAudio` (which governs the
  shared audio cache). Pace and listening settings are per recipient: `newPerDay`,
  scheduler, `retention`, `easyInterval`, `speak` and `speechRate`.
- **Un-assigning** a person hides the deck from them but keeps their progress rows, so giving
  it to them again restores it. **Deleting an assigned deck** removes it and all recipients'
  progress on it, after a confirmation that names how many people have it.
- **Provisioning:** the owner buys the VPS and domain (Claude cannot). The build delivers
  setup and deploy scripts plus a step-by-step runbook. Claude runs them only if the owner
  grants SSH access. The migration is verified on the server by comparing card counts.

## Data model sketch (direction, not a schema)

The key change is separating **card content** from **per-user progress** for decks that are
shared:

- A deck has an **owner** (a user). Its cards' content belongs to the deck.
- A **deck assignment** links a deck to a recipient user.
- **Progress** (the schedule fields, reserve flag/order) is stored per (user, card). For a
  user's own decks this can be the same row as the content or a separate table; for assigned
  decks it must be separate so the admin's edits to content leave it untouched.
- Reserve membership and order are per (user, card). On assignment every card starts on the
  recipient's reserve (see above). A card the admin adds later is created for each recipient
  as a new card at the end of their reserve.
- `daily`, `log` and `settings` become per user. Per-deck settings split into shared content
  settings and per-recipient pace settings, as listed above.

The builder chooses how the client syncs. Two reasonable routes:
1. Keep the client's whole-state model but have the server assemble each user's view (own
   decks + assigned decks merged with that user's progress) on GET, and split it back on PUT,
   rejecting edits to content the user doesn't own.
2. Move to finer-grained API calls (answer a card, edit a card, …).
Route 1 changes the least code; route 2 scales better and avoids lost writes between two
devices. Either is acceptable if the anti-goals hold.

## Screens to add

- **Sign up** (invite code, name, email/username, password) and **log in**, both phone-first
  and in the existing "Night minimal" design (see `DESIGN.md`).
- **Log out** and the signed-in user's name somewhere unobtrusive.
- **Admin view** (admin only): accounts list, create/revoke invite codes, give a deck to people
  (pick a deck, tick recipients), take a deck back from someone, reset a password.
- In a recipient's deck list, assigned decks look like normal decks, perhaps with a quiet
  "from <admin>" note.

## Security essentials

HTTPS only; secure session cookies; CSRF protection on state-changing requests (the existing
`Sec-Fetch-Site` check plus SameSite cookies); rate-limit login and sign-up; every API call
scoped to the session's user; admin endpoints check the role; upload size limits kept; uploaded
SVGs keep the current sandboxed serving. Invite codes are single-use or limited-use and can
be revoked.

## Migration

A one-off step imports the current `data/recall.json`, `data/media/` and `data/audio/` into the
new store under a newly created admin account, preserving all ids, schedules and stats, and
verifies card counts match afterwards.

## Left to the builder

- Exact schema, API shape and sync route (see above).
- Whether recipients may edit an assigned card's text locally (default: no; they can still
  suspend/reserve).
- Home-screen install (web app manifest) — nice to have.
- Deploy mechanism details (a simple script or `git pull` + restart is fine).
- Whether login uses email or username.
- How Google Translate failures surface to users (fallback is already automatic).
