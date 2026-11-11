# Recall Online Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Recall from a single-person localhost app into a hosted app for a private group: invite-code sign-up, per-user data, an admin who gives decks to people, deployed on a small VPS.

**Architecture:** The Node server moves from one JSON file to a SQLite database (`node:sqlite`). Deck and card *content* belong to a deck owner, and *progress* is stored per user and card, so decks the admin gives out stay linked while each person keeps their own schedule. The client still loads the whole state on start (`GET api/state`), but saves only what changed (`POST api/sync`, computed by diffing against a snapshot). This keeps phone traffic small and stops one device from wiping another device's work.

**Tech Stack:** Node ≥ 22.15 (`node:http`, `node:sqlite`, `node:crypto`, `node:test`), plain browser JS/HTML/CSS, Caddy (HTTPS), systemd, Ubuntu 24.04 VPS.

**Spec:** `docs/superpowers/specs/2026-11-11-recall-online-design.md`

## Global Constraints

- No npm dependencies. Use only Node built-ins and what is already in `vendor/`.
- Node ≥ 22.15. `package.json` gets `"engines": { "node": ">=22.15" }`.
- Tests use `node:test` + `node:assert/strict`, in `tests/*.test.js`, run by `npm test`.
- Running cost under $10/month. One VPS, no paid services.
- The voice order stays Google Translate first (`data/tts.json` `"engine": "google"` on the server), with the existing fallbacks.
- Sign-up requires an invite code. There is no email sending and no password-reset email. The admin resets passwords.
- Decks given to a person land **entirely on that person's reserve**, in the owner's order: the owner's studied cards first (oldest `created` first), then the owner's reserve in its arranged order. Cards added to the deck later go to the end of every recipient's reserve.
- Shared deck fields (come from the owner, follow the owner's changes): `name`, `created`, `ankiId`, `frontLang`, `backLang`, `saveAudio`. All other deck fields (`scheduler`, `newPerDay`, `retention`, `easyInterval`, `speak`, `speechRate`, `fsrsParams`) are per user.
- Card content fields: `front`, `back`, `created`, `updated`, `ankiId`, `reversed`. Every other card field except `id` and `deckId` is per-user progress.
- Taking a deck back from someone hides it and keeps their progress. Deleting a deck removes it, and everyone's progress on it, after a confirmation naming how many people have it.
- UI follows `DESIGN.md` ("Night minimal"), works at phone width with a 16px gutter, and works in both themes.
- Online only: the no-login localhost mode is removed.

## Review Focus

1. **Phone and laptop used on the same day:** two syncs from different devices, each touching different cards, must both survive. A device that never saw a card must not delete it. (Test in Task 3.)
2. **Owner edits a card's text while a recipient is mid-way through learning it:** the recipient's schedule on that card is unchanged. (Test in Task 4.)
3. **A recipient sends a crafted request that edits, adds or deletes content in a deck they were given, or touches someone else's deck:** it is rejected, and nothing about the owner's content changes. (Test in Task 3.)
4. **An expired or missing session on a phone:** the API answers 401 and the app shows the login screen instead of an empty or broken app. (Tests in Tasks 5 and 6.)
5. **Invite codes typed with spaces or lower case, reused, or revoked:** trimmed and upper-cased before checking. A single-use code works exactly once, even with two sign-ups at the same moment. A revoked code never works. (Test in Task 2.)

---

## File map

| File | Responsibility |
|---|---|
| `server/db.js` | Open the SQLite file, set pragmas, create the schema |
| `server/fields.js` | Which deck/card fields are shared content vs per-user |
| `server/auth.js` | Passwords, users, invites, sessions, login rate limiter |
| `server/sync.js` | Build a user's view of the state; apply a user's changes under ownership rules |
| `server/admin.js` | Accounts list, owned decks with recipients, give/take back decks |
| `server/backup.js` | Nightly database backup, keep 30 |
| `server.js` | HTTP routing, cookies, host/origin checks, static files, media, TTS, Anki upload |
| `js/store.js` | Client state; snapshot/diff sync; read-only guards for given decks |
| `js/api.js` | Client fetch wrappers for auth and admin endpoints |
| `js/app.js` | Login/sign-up screen, admin screen, topbar changes, hiding edit actions on given decks |
| `css/*` | Styles for the new screens (follow the existing stylesheet layout) |
| `scripts/migrate-json.js` | One-off: import `data/recall.json` into a new database under a new admin |
| `deploy/*` | Caddyfile, systemd unit, server setup script, deploy script, runbook |
| `README.md` | Rewritten for the hosted app |

---

### Task 1: Database and field split

**Files:**
- Create: `server/db.js`, `server/fields.js`
- Test: `tests/db.test.js`
- Modify: `package.json` (add `engines`)

**Interfaces:**
- Produces:
  - `openDb(file: string): DatabaseSync`: `':memory:'` for tests. Runs `PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL` (file DBs only), `PRAGMA busy_timeout = 5000`, then creates the tables below if missing.
  - `DECK_SHARED: string[]`, `CARD_CONTENT: string[]` (values in Global Constraints)
  - `split(obj: object, sharedKeys: string[]): [shared: object, personal: object]`: drops `id` and `deckId` from both halves.

Schema (JSON columns hold the field groups):

```sql
users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      pass TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','user')), created INTEGER NOT NULL)
sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL)
invites(code TEXT PRIMARY KEY, uses_left INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)
decks(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL)
deck_prefs(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE, data TEXT NOT NULL, PRIMARY KEY (user_id, deck_id))
cards(id TEXT PRIMARY KEY, deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE, data TEXT NOT NULL)
progress(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, data TEXT NOT NULL, PRIMARY KEY (user_id, card_id))
assignments(deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, active INTEGER NOT NULL, assigned INTEGER NOT NULL, PRIMARY KEY (deck_id, user_id))
user_state(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, daily TEXT NOT NULL, log TEXT NOT NULL, settings TEXT NOT NULL, saved_at INTEGER NOT NULL)
```

Add indexes on `cards(deck_id)` and `progress(card_id)`.

- [ ] **Step 1: Write failing tests**: `opens an in-memory db with every table` (query `sqlite_master` for the 9 names); `deleting a deck cascades to its cards and progress`; `split separates content from progress`:

```js
const [content, progress] = split({ id: 'c1', deckId: 'd1', front: 'a', back: 'b', created: 1, due: 5, reserved: true }, CARD_CONTENT);
assert.deepEqual(content, { front: 'a', back: 'b', created: 1 });
assert.deepEqual(progress, { due: 5, reserved: true });
```

- [ ] **Step 2: Run** `node --test tests/db.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `server/db.js` and `server/fields.js`.
- [ ] **Step 4: Run** `node --test tests/db.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git add server/db.js server/fields.js tests/db.test.js package.json && git commit -m "Add the SQLite store and the content/progress field split"`

---

### Task 2: Accounts, invites and sessions

**Files:**
- Create: `server/auth.js`
- Test: `tests/auth.test.js`

**Interfaces:**
- Consumes: `openDb`
- Produces (`User = { id, username, name, role }`):
  - `class AuthError extends Error { code: 'bad-username'|'weak-password'|'username-taken'|'bad-invite'|'bad-login' }`
  - `hashPassword(password: string): Promise<string>`: `crypto.scrypt`, 16-byte random salt, keylen 64, stored as `scrypt$<saltHex>$<hashHex>`
  - `verifyPassword(password: string, stored: string): Promise<boolean>`: `timingSafeEqual`
  - `createUser(db, { username, name, password, role = 'user' }, now): Promise<User>`: username `/^[A-Za-z0-9._-]{3,32}$/`, password ≥ 8 chars, name trimmed 1–60 chars; `id` = `randomUUID()`
  - `createInvite(db, { uses = 1 } = {}, now): string`: 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
  - `listInvites(db): { code, usesLeft, revoked, created }[]`, newest first
  - `revokeInvite(db, code: string): void`
  - `signUp(db, { code, username, name, password }, now): Promise<User>`: normalises code with `trim().toUpperCase()`. In one transaction (`BEGIN IMMEDIATE`), it decrements `uses_left` only where `uses_left > 0 AND revoked = 0`, then creates the user. A bad code throws `bad-invite` and creates nothing.
  - `logIn(db, { username, password }): Promise<User>`: throws `bad-login` for an unknown user or a wrong password (same error for both)
  - `createSession(db, userId, now): string`: 32 random bytes base64url. Stores `sha256(token)`, expires `now + 180 days`.
  - `userForSession(db, token, now): User | null`: deletes the session if expired
  - `endSession(db, token): void`
  - `setPassword(db, userId, password): Promise<void>`: validates like `createUser` and deletes all that user's sessions
  - `createLimiter({ max, windowMs }): { hit(key: string, now: number): boolean }`: `true` while allowed

- [ ] **Step 1: Write failing tests:**
  - `sign up with a valid invite creates a user and uses the code up`: a second `signUp` with the same 1-use code rejects `{ code: 'bad-invite' }`.
  - `invite codes ignore spaces and case`: `signUp(db, { code: '  ' + code.toLowerCase() + ' ', ... })` succeeds.
  - `revoked invite is refused`.
  - `two simultaneous sign-ups with a single-use code: exactly one succeeds`: `Promise.allSettled` of two `signUp` calls; one fulfilled, one rejected.
  - `usernames are unique regardless of case`: `Mum` then `mum` rejects `username-taken`.
  - `log in checks the password`: wrong password and unknown user both reject with `bad-login`.
  - `sessions expire`: `userForSession(db, t, now + 181 * DAY)` is `null`.
  - `setPassword ends existing sessions`.
  - `limiter blocks after max hits within the window and frees up after it`: `max: 3`, the 4th hit returns `false`, and a hit after `windowMs` returns `true`.
- [ ] **Step 2: Run** `node --test tests/auth.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `server/auth.js`.
- [ ] **Step 4: Run** `node --test tests/auth.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add accounts, invite codes and sessions"` (with the two files).

---

### Task 3: A user's view and applying their changes

**Files:**
- Create: `server/sync.js`
- Test: `tests/sync.test.js`

**Interfaces:**
- Consumes: `openDb`, `split`, `DECK_SHARED`, `CARD_CONTENT`, `createUser`, `newSchedule` from `js/fsrs.js`
- Produces:
  - `buildView(db, userId, now): State`, where `State = { version: 1, decks, cards, daily, log, settings, savedAt }`. It contains:
    - the user's own decks (shared data + their prefs)
    - active assigned decks, each with `assigned: true` and `from: <owner name>`
    - every card in those decks: content + the user's progress row. An assigned-deck card with no progress row for this user gets `{ ...newSchedule(card.created), reserved: true, order: maxOrder + 1 + i }`, in `created` order, after the user's highest `order` in that deck. This is how cards added later reach recipients.
    - `daily`, `log`, `settings`, `savedAt` from `user_state`, or `{}`, `{}`, `{}`, `0` when there is none
  - `applyChanges(db, userId, changes: Changes, now): { rejected: string[] }`. Runs in one transaction.
    - `Changes = { decks?: Deck[], deletedDecks?: string[], cards?: Card[], deletedCards?: string[], daily?, log?, settings?, savedAt?: number }`
    - Rules, in this order:
      1. **`deletedCards`**: delete a card only if its deck is owned by the user. Otherwise reject the id.
      2. **`deletedDecks`**: delete a deck only if it is owned by the user. Otherwise reject the id.
      3. **`decks`**:
         - owned: update the shared data and the user's prefs
         - assigned (active) to the user: update prefs only
         - new id: insert it, owned by the user
         - any other existing deck: reject the id
      4. **`cards`**:
         - existing card in an owned deck: the target `deckId` must also be owned. Update content (and the deck, if it moved) and the user's progress.
         - existing card in an active assigned deck, with the same `deckId`: update the user's progress only, and ignore content.
         - new card whose `deckId` is owned: insert content + progress.
         - anything else: reject the id.
      5. **`daily`/`log`/`settings`/`savedAt`**: upsert whichever are present into `user_state`.
    - Ids must be strings of 1–100 chars. Any other id is rejected.

- [ ] **Step 1: Write failing tests** (helper `seed()` creates users `ana` and `ben`, plus an owned deck and cards for `ana` via `applyChanges`):
  - `a user's own decks and cards round-trip`: `applyChanges` then `buildView` gives back the same deck and card objects (deep equal, ignoring key order).
  - `a user never sees another user's decks`.
  - `syncs from two devices touching different cards both persist`: two `applyChanges` calls, each with one changed card. Both changes are present, and a card absent from both is still there (Review Focus 1).
  - `a recipient cannot edit, add or delete content in a given deck`: insert an active assignment row directly. Ben's changes, each rejected, all leave ana's view unchanged (Review Focus 3):
    - changing `front`: content unchanged, but ben's `due` change is saved
    - a new card with that `deckId`: rejected
    - `deletedCards: [id]`: rejected
    - `deletedDecks: [deckId]`: rejected
    - a deck change renaming it: name unchanged, but `newPerDay` saved for ben only
  - `a user cannot touch a deck they were not given`: all ids rejected.
  - `daily, log and settings are per user`.
- [ ] **Step 2: Run** `node --test tests/sync.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `server/sync.js`.
- [ ] **Step 4: Run** `node --test tests/sync.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Build each user's view and apply their changes under ownership rules"`

---

### Task 4: Giving decks to people

**Files:**
- Create: `server/admin.js`
- Test: `tests/admin.test.js`

**Interfaces:**
- Consumes: `openDb`, `applyChanges`, `buildView`, `newSchedule`
- Produces:
  - `listUsers(db): { id, username, name, role, created }[]`, ordered by name
  - `ownedDecks(db, ownerId): { id, name, cards: number, recipients: { userId, name, active: boolean }[] }[]`
  - `assignDeck(db, { ownerId, deckId, userIds }, now): void`
    - Throws `Error('not-owner')` unless the deck is the owner's.
    - For a user with no assignment row: insert one with `active = 1`. Insert progress rows for every card: `{ ...newSchedule(now), reserved: true, order: i }`, in the owner's order (owner's non-reserve cards by `created` ascending, then the owner's reserve sorted by `order ?? Infinity`, then `created`). Copy the owner's deck prefs as the recipient's starting prefs.
    - For a user with an inactive row: set `active = 1` and leave their progress as it was.
    - Assigning to the owner is a no-op.
  - `unassignDeck(db, { ownerId, deckId, userIds }): void`: sets `active = 0` and keeps progress

- [ ] **Step 1: Write failing tests:**
  - `a given deck arrives entirely on the recipient's reserve in the owner's order`: the owner has 2 studied cards (created 2, 1) and 2 reserve cards with `order` 1 and 0. The recipient's view has all 4 with `reserved: true` and `order` 0..3, matching card ids `[created1, created2, reserve-order0, reserve-order1]`, all `state: State.New`.
  - `the owner's later edit reaches the recipient and keeps their progress`: the recipient pulls a card in and answers it (set `due`/`reps` via `applyChanges`). The owner changes `front`. The recipient's view shows the new `front` with the same `due`/`reps` (Review Focus 2).
  - `a card the owner adds later lands at the end of the recipient's reserve`.
  - `a card the owner deletes disappears for recipients`.
  - `taking a deck back hides it and giving it again restores progress`.
  - `deleting a given deck removes it for everyone`.
  - `only the owner can give a deck`: throws `not-owner`.
  - `ownedDecks counts cards and lists recipients`.
- [ ] **Step 2: Run** `node --test tests/admin.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `server/admin.js`.
- [ ] **Step 4: Run** `node --test tests/admin.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Let the admin give decks to people and take them back"`

---

### Task 5: The HTTP server

**Files:**
- Modify: `server.js` (most of it is rewritten; `saveImage`, `upload`, `image`, `anki` and `readBody` are kept)
- Create: `server/backup.js`
- Modify: `tts.js` only if needed to let the server pass the `Cache-Control` header (see below)
- Test: `tests/http.test.js`, `tests/backup.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–4
- Produces:
  - `createRecallServer({ dataDir: string, origin?: string, tts?: { speak, engine } }): http.Server`, exported from `server.js`. `server.js` listens on `PORT` (default 5173) on `127.0.0.1` only when run directly (`import.meta.url === pathToFileURL(process.argv[1]).href`). The DB is `<dataDir>/recall.db`.
  - `backupDb(db, dir: string, now: number, keep = 30): string | null`: `VACUUM INTO '<dir>/recall-YYYY-MM-DD.db'` once per day, deleting the oldest beyond `keep`. Called at start-up and hourly.
  - HTTP API (JSON bodies; errors are `{ "error": "<code>" }`):

| Method & path | Auth | Body → result |
|---|---|---|
| `POST api/signup` | none, rate-limited | `{code, username, name, password}` → `201 {user}` + cookie. `400 bad-invite / bad-username / weak-password`, `409 username-taken` |
| `POST api/login` | none, rate-limited | `{username, password}` → `200 {user}` + cookie. `401 bad-login` |
| `POST api/logout` | session | → `204`, cookie cleared |
| `GET api/me` | session | → `{user}` or `401` |
| `GET api/state` | session | → `buildView(...)` |
| `POST api/sync` | session | `Changes` → `{rejected}` |
| `GET api/tts`, `POST api/anki`, `POST api/media`, `GET api/media/:name` | session | as today |
| `GET api/admin/users` | admin | → `listUsers` |
| `GET/POST api/admin/invites`, `DELETE api/admin/invites/:code` | admin | POST `{uses}` → `{code}` |
| `GET api/admin/decks` | admin | → `ownedDecks(db, adminId)` |
| `POST api/admin/decks/:id/assign`, `.../unassign` | admin | `{userIds}` → `204` |
| `POST api/admin/users/:id/password` | admin | `{password}` → `204` |

- Rules:
  - **Cookie:** `recall_session`, `HttpOnly; SameSite=Lax; Path=/; Max-Age=15552000`, plus `Secure` when `origin` starts with `https://`.
  - **Hosts:** the allowed Host values are `localhost`, `127.0.0.1`, `[::1]` and the host of `origin`.
  - **Forged requests:** keep the existing `Sec-Fetch-Site` check. A state-changing request with an `Origin` header that is not the server's own is refused with 403.
  - **Rate limit:** login and sign-up use `createLimiter({ max: 10, windowMs: 15 * 60 * 1000 })`, keyed by the client IP (first `X-Forwarded-For` entry when the socket address is loopback), and return `429` when exceeded.
  - **Speech audio:** `GET api/tts` with saving on answers `Cache-Control: private, max-age=31536000, immutable`, so phones keep audio they have played.
  - **Static files:** `index.html`, `js/`, `css/` and `vendor/` stay served without auth, so the login screen can load.

- [ ] **Step 1: Write failing tests.** Start `createRecallServer` on port 0 with a temp `dataDir` and a fake `tts` that returns `{ body: Buffer.from('x'), type: 'audio/mpeg' }`. Seed an admin and an invite through `openDb` on the same file.
  - `the API needs a session`: `GET api/state`, `GET api/tts`, `POST api/sync` → 401 (Review Focus 4).
  - `sign up, then state and sync work with the cookie`.
  - `logout ends the session`: the old cookie then gets 401.
  - `admin endpoints refuse ordinary users` → 403.
  - `admin gives a deck and the recipient sees it`.
  - `login is rate limited` → 11th attempt gets 429.
  - `requests for another host are refused` → 403.
  - `tts audio is cacheable on the phone`.
  - `tests/backup.test.js`: `one backup per day, oldest removed beyond keep`.
- [ ] **Step 2: Run** `node --test tests/http.test.js tests/backup.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `createRecallServer` and `server/backup.js`. Drop `recall.json` reading/writing, the JSON backup and the `X-Data-File` header.
- [ ] **Step 4: Run** `npm test`. Expected: all PASS, older test files included.
- [ ] **Step 5: Commit** `git commit -m "Serve Recall to signed-in users from the database"`

---

### Task 6: Client store syncs changes and respects given decks

**Files:**
- Modify: `js/store.js`
- Create: `js/api.js`
- Test: `tests/store.test.js` (extend), `tests/sync-client.test.js`

**Interfaces:**
- Consumes: `GET api/state`, `POST api/sync`, `GET api/me`, `POST api/login|signup|logout`, admin endpoints
- Produces:
  - `snapshotOf(state): Snapshot`, where `Snapshot = { decks: Map<id, string>, cards: Map<id, string>, daily: string, log: string, settings: string }` (JSON strings)
  - `diffState(snapshot, state): Changes | null`: changed or new decks/cards by JSON comparison, ids in the snapshot but not in the state as `deletedDecks`/`deletedCards`, and `daily`/`log`/`settings` only when changed. Always includes `savedAt` when there are changes. Returns `null` when nothing changed.
  - `load(): Promise<{ signedIn: boolean }>`: `401` → `{ signedIn: false }`. Otherwise it sets the state from the server and takes the snapshot.
  - `flush()`: sends `diffState` to `POST api/sync`, then on success updates the snapshot to the state that was sent. A non-empty `rejected` reloads the state from the server, re-renders through the `onStorageChange` listener, and shows the toast "Some changes could not be saved". A `401` sets `storageInfo().signedOut = true` and notifies. A network failure retries every 5 s, as today.
  - `editable(deckId): boolean`: `false` for `assigned` decks
  - Content mutators throw `Error('read-only deck')` on a given deck: `addCard`, `addCards`, `updateCard` with any key in `['front', 'back', 'deckId']`, `deleteCard`, `deleteCards`, `deleteDeck`, `addReversed`, and `updateDeck` with any shared key. Reserve and study actions (`pullFromReserve`, `pullCards`, `returnToReserve`, `moveInReserve`, `reverseReserve`, `answerCard`) stay allowed.
  - The `localStorage` copy of the state is removed (so a shared phone keeps nothing after logout). `storageInfo()` returns `{ available, ok, signedOut, voice }`.
  - `js/api.js`: `me()`, `logIn(username, password)`, `signUp({ code, username, name, password })`, `logOut()`, `admin.users()`, `admin.invites()`, `admin.createInvite(uses)`, `admin.revokeInvite(code)`, `admin.decks()`, `admin.assign(deckId, userIds)`, `admin.unassign(deckId, userIds)`, `admin.resetPassword(userId, password)`. Each resolves to parsed JSON, or throws `Error(<error code>)`.

- [ ] **Step 1: Write failing tests:**
  - `diffState finds changed, new and deleted cards and decks only`: one `answerCard` gives exactly that card in `cards` and nothing else.
  - `diffState is null when nothing changed`.
  - `daily and log are sent only when they change`.
  - `a given deck's content cannot be edited, but it can be studied and its reserve used`: a deck with `assigned: true` throws on `addCard`/`updateCard(front)`/`deleteDeck`, and `pullFromReserve` works.
  - `load reports signed out on 401`: stub `globalThis.fetch` to return 401.
- [ ] **Step 2: Run** `node --test tests/store.test.js tests/sync-client.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit** `git commit -m "Save only what changed, and keep given decks read-only"`

---

### Task 7: Sign-up, login and account controls in the app

**Files:**
- Modify: `js/app.js` (boot, `topbar`, `storageChip`, new `renderAuth`), stylesheet(s) in `css/`

**Interfaces:**
- Consumes: `store.load`, `js/api.js` auth calls, `store.storageInfo().signedOut`
- Produces: `renderAuth(mode: 'login' | 'signup')`, shown by `render()` whenever `!signedIn` or `storageInfo().signedOut`. The `#/signup` hash opens the sign-up form.

Behaviour:
- **Login form:** username and password fields, a "Log in" button, and a link "Have an invite code? Sign up".
- **Sign-up form:** invite code, name, username and password fields, and a "Create account" button.
- **Error messages, written exactly:**
  - `bad-invite`: "That invite code doesn't work. Check it with whoever sent it."
  - `username-taken`: "That username is taken."
  - `weak-password`: "Use at least 8 characters."
  - `bad-username`: "Use 3–32 letters, numbers, dots, dashes or underscores."
  - `bad-login`: "Wrong username or password."
  - `429`: "Too many attempts. Try again in a few minutes."
- On success, `location.reload()`.
- **Topbar:**
  - `storageChip` now shows "Saved" or "Not saved, retrying".
  - Remove "Import backup" from the topbar, but keep "Export backup".
  - Add a menu showing the user's name, with "Log out" and, for admins, "Admin" (links to `#/admin`).
  - On phones the menu sits in the top bar, not the bottom tab bar.
- **Fields:** `autocomplete` attributes set (`username`, `current-password`, `new-password`), `autocapitalize="none"` on username and invite code, and inputs of at least 16px font so iOS doesn't zoom in.

- [ ] **Step 1: Verify the signed-out case manually.** Run `RECALL_DATA=$(mktemp -d) node server.js`, open `http://localhost:5173` at 390px width in both themes, and expect the login form. Create an admin + invite with a one-off `node -e` using `openDb`/`createUser`/`createInvite`.
- [ ] **Step 2: Implement** the screens and topbar changes.
- [ ] **Step 3: Verify** each item, at phone width and on desktop, in both themes:
  - sign-up with a bad code shows the bad-invite message
  - sign-up with a good code lands on the home page
  - log out returns to the login screen
  - deleting the `sessions` row and then answering a card shows the login screen (Review Focus 4)
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit** `git commit -m "Add sign-up, login and logout to the app"`

---

### Task 8: Given decks in the app, and the admin screen

**Files:**
- Modify: `js/app.js` (`renderHome`, `renderDeck`, `openDeckDialog`, `openCardDialog`, card actions, `removeDeck`, `render`, new `renderAdmin`), `css/`

**Interfaces:**
- Consumes: `store.editable`, `deck.assigned`, `deck.from`, `js/api.js` admin calls
- Produces: the `#/admin` route (admins only; anyone else is redirected to `#/`)

Behaviour:
- **Given decks (`!store.editable(deck.id)`):**
  - The deck shows a quiet "From <from>" line under its name on the home page and the deck page.
  - Hidden: add card, import into deck, edit card (including the `e` shortcut in study), delete card(s), add reversed, delete deck.
  - The deck dialog shows only the per-user settings (new per day, scheduler, retention, easy interval, read aloud, speech rate).
- **Admin screen**, in three sections:
  - **People:** each account's name and username, with a "Reset password" action that opens a dialog with a password field.
  - **Invite codes:** a "New invite code" button (uses: 1 by default, adjustable 1–20), and a list of active codes, each with a copy button and a revoke button.
  - **Your decks:** each deck with its card count and who has it. A "Give to…" dialog shows a checkbox for each person and saves through assign/unassign for whatever changed.
- **Deleting a deck that has recipients:** `removeDeck` shows "<n> people have this deck. Deleting it removes it and their progress." in `confirmDialog`.

- [ ] **Step 1: Implement** the given-deck restrictions.
- [ ] **Step 2: Verify manually** with two accounts (admin + user):
  - give a 5-card deck: the user sees it with all 5 on reserve and can pull 2 in and study them
  - the admin edits a card's front: after a reload the user sees the change and their two cards keep their due dates
  - none of the hidden actions appear for the user
- [ ] **Step 3: Implement** the admin screen and the delete warning.
- [ ] **Step 4: Verify manually:**
  - create and revoke an invite
  - reset a password, then log in with the new one
  - take a deck back: it disappears for the user; give it again and their progress returns
  - delete a given deck: the warning names the count
  - phone width in both themes
- [ ] **Step 5: Run** `npm test`, then commit: `git commit -m "Show given decks read-only and add the admin screen"`

---

### Task 9: Move the existing data in

**Files:**
- Create: `scripts/migrate-json.js`
- Test: `tests/migrate.test.js`

**Interfaces:**
- Consumes: `openDb`, `createUser`, `applyChanges`, `buildView`
- Produces: `migrateJson({ dataDir, username, name, password }, now): { decks: number, cards: number }`, exported. The CLI is `node scripts/migrate-json.js --data <dir> --username <u> --name "<n>"`, with the password read from env `RECALL_ADMIN_PASSWORD` or prompted without echo.
  - It refuses when `<dir>/recall.db` already has users.
  - It creates the admin user and passes the whole `recall.json` to `applyChanges` as new decks/cards plus `daily`/`log`/`settings`/`savedAt`.
  - It then checks that `buildView` returns the same number of decks and cards, with deep-equal card objects, and exits non-zero on any mismatch.
  - `data/media/` and `data/audio/` stay where they are.

- [ ] **Step 1: Write failing tests:**
  - `migrates a JSON file into an admin account unchanged`: a fixture with 2 decks, 5 cards (one reserved with `order`, one with `ankiId`, one `reversed`), `daily`, `log` and `settings`. The view deep-equals the input after `normalize`-style defaults.
  - `refuses to run twice`.
- [ ] **Step 2: Run** `node --test tests/migrate.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests (PASS), then do a dry run on a copy of the real data: `cp -r data /tmp/recall-mig && RECALL_ADMIN_PASSWORD=test1234 node scripts/migrate-json.js --data /tmp/recall-mig --username admin --name Admin`. Expected: prints `5 decks, 7378 cards` (or the current counts) and exits 0.
- [ ] **Step 5: Commit** `git commit -m "Add a one-off migration from recall.json"`

---

### Task 10: Deployment and README

**Files:**
- Create: `deploy/Caddyfile`, `deploy/recall.service`, `deploy/setup.sh`, `deploy/deploy.sh`, `deploy/RUNBOOK.md`
- Modify: `README.md`, `.gitignore` (add `data/*.db*`)

**Interfaces:**
- Consumes: `server.js` env vars `PORT`, `RECALL_DATA`, `RECALL_ORIGIN`
- Produces:
  - **`deploy/Caddyfile`:** `{$RECALL_DOMAIN} { encode zstd gzip; reverse_proxy 127.0.0.1:5173 }`
  - **`deploy/recall.service`:** runs `node /opt/recall/server.js` as user `recall`, with `Environment=RECALL_DATA=/var/lib/recall RECALL_ORIGIN=https://<domain>`, `Restart=always`, and `NoNewPrivileges=true`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/recall`.
  - **`deploy/setup.sh DOMAIN`:** run once as root on a fresh Ubuntu 24.04 server. It is idempotent and does the following:
    - installs Node 22 (NodeSource) and Caddy (official apt repo)
    - creates the `recall` user, `/opt/recall` and `/var/lib/recall`
    - installs the unit and the Caddyfile with the domain substituted
    - enables a firewall allowing only ports 22, 80 and 443 (`ufw`)
    - writes `/var/lib/recall/tts.json` as `{"engine":"google"}`
  - **`deploy/deploy.sh user@host`:** run locally. It `rsync`s the code (no `data/`, `decks/`, `.git`, `*.pdf`) to `/opt/recall` and restarts the service.
  - **`deploy/RUNBOOK.md`:** the owner's step-by-step guide:
    1. buy a VPS (Hetzner CX22 or similar, Ubuntu 24.04, about €4–6/month) and a domain
    2. point an A record at the server
    3. `ssh-copy-id`, then run `setup.sh`
    4. run the migration locally, then `rsync` `data/recall.db`, `data/media/` and `data/audio/` to `/var/lib/recall/`
    5. run `deploy.sh`
    6. open the site, log in as admin, and create an invite
    7. backups are in `/var/lib/recall/backups`, and here is how to copy one off the server
    8. how to update the app
- **README:** describe the hosted app (accounts, invites, the admin, given decks) and how to run it locally for development (`RECALL_DATA=./data node server.js` plus the migration), and link the runbook. Remove the "clone and run, no setup" pitch. Keep the features list.

- [ ] **Step 1: Write the files.**
- [ ] **Step 2: Verify:**
  - `bash -n deploy/setup.sh deploy/deploy.sh` exits 0
  - `shellcheck deploy/*.sh` if installed
  - `systemd-analyze verify deploy/recall.service` if available (warnings about missing paths are fine)
- [ ] **Step 3: Verify locally end to end:**
  - `RECALL_DATA=/tmp/recall-mig RECALL_ORIGIN=http://localhost:5173 node server.js`
  - log in as the migrated admin: all decks and today's counts match the old app
  - create an invite, sign up a second user in a private window, give them the Software Quality deck, and study one card
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit** `git commit -m "Add deployment scripts, runbook and a README for the hosted app"`

---

## After the plan

The owner buys the VPS and domain and follows `deploy/RUNBOOK.md`. Claude runs it only with SSH access granted. Making the GitHub repository private is a separate, explicit step for the owner to approve.
