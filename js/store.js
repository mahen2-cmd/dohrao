// App state: decks, cards, saving to the server and the study queue.

import * as api from './api.js';
import { mergeCounts } from './counts.js';
import { dayKey, streakOf } from './progress.js';
import { readableTopicName, prefixGroup, resolveFilter, inFilter } from './topics.js';
import { DAY, State, dayStart, newSchedule, nextDayAt, preview, schedule } from './fsrs.js';

// Per-deck settings.
//   scheduler     'sm2' (Anki's default algorithm) or 'fsrs' (Anki with FSRS switched on)
//   retention     desired retention, used by FSRS
//   easyInterval  days until the next review when Easy is pressed on a card still being
//                 learned for the first time, like Anki's "Easy interval"
//   speak         side read aloud automatically: 'none', 'front', 'back' or 'both'
//   frontLang     language the front is read in, such as 'en-US'
//   backLang      language the back is read in
//   speechRate    playback speed of that audio, where 1 is the voice's natural pace
//   saveAudio     whether the server keeps the audio it makes for the deck's cards; off, it
//                 is made each time it is played, and `npm run cache-voice` leaves the deck out
// A deck imported from Anki may also carry `fsrsParams`, its own FSRS parameters.
export const DECK_DEFAULTS = {
  scheduler: 'sm2',
  newPerDay: 20,
  retention: 0.9,
  easyInterval: 4,
  speak: 'none',
  frontLang: 'en-US',
  backLang: 'pt-PT',
  speechRate: 0.8,
  saveAudio: true,
};

// `daily` counts the answers given on each day. `log` breaks the same answers down:
// log[day][deckId] holds twelve counts, Again to Easy for each kind in ANSWER_KINDS.
const emptyState = () => ({ version: 1, decks: [], cards: [], daily: {}, log: {}, settings: {} });

let state = emptyState();

// ---- Persistence ------------------------------------------------------------
// The state lives on the server, which keeps each user's own. It is loaded from `api/state`,
// and each change sends `api/sync` only the decks, cards and figures that differ from what
// the server last took, so a phone and a laptop used on the same day do not overwrite each
// other's work. Until the server has them, those changes are also kept in the browser under
// the user's id, so answers given with no signal survive the page being closed. Nothing else is
// kept there, and logging out clears it.

const server = { available: false, ok: true, signedOut: false, voice: null };
// What the server holds, as last loaded or saved.
let snapshot = snapshotOf(emptyState());
let userId = null;
let writing = false;
// The save on its way, which resolves once it and any changes made meanwhile are sent or kept.
let sending = Promise.resolve();
let dirty = false;
let retry = null;
let notify = () => {};

/** Whether the state came from the server and saves reach it, and the server's voice. */
export const storageInfo = () => ({ ...server });

/**
 * Call `listener` whenever saving starts failing or recovers, the session ends, or the state is
 * reloaded from the server. A reload after refused changes passes the message to show.
 */
export function onStorageChange(listener) {
  notify = listener;
}

/**
 * Each deck and card as JSON, by id, and the daily figures, log and settings as JSON,
 * so a later state can be compared with this one.
 */
export function snapshotOf(s) {
  return {
    decks: new Map(s.decks.map((d) => [d.id, JSON.stringify(d)])),
    cards: new Map(s.cards.map((c) => [c.id, JSON.stringify(c)])),
    daily: JSON.stringify(s.daily),
    log: JSON.stringify(s.log),
    settings: JSON.stringify(s.settings),
  };
}

/** What differs from `before` in `after`, both snapshots, as the changes `api/sync` takes, or null. */
function changesBetween(before, after, savedAt) {
  const changes = {};
  for (const kind of ['decks', 'cards']) {
    const changed = [...after[kind]].filter(([id, json]) => before[kind].get(id) !== json).map(([, json]) => JSON.parse(json));
    const gone = [...before[kind].keys()].filter((id) => !after[kind].has(id));
    if (changed.length) changes[kind] = changed;
    if (gone.length) changes[kind === 'decks' ? 'deletedDecks' : 'deletedCards'] = gone;
  }
  for (const key of ['daily', 'log', 'settings']) {
    if (before[key] !== after[key]) changes[key] = JSON.parse(after[key]);
  }
  if (!Object.keys(changes).length) return null;
  return { ...changes, savedAt: savedAt ?? Date.now() };
}

/**
 * The changes that turn the state `snapshot` was taken of into `s`: decks and cards that are new
 * or differ, the ids of those removed, and the daily figures, log and settings when they changed.
 * Null when nothing changed.
 */
export const diffState = (snap, s) => changesBetween(snap, snapshotOf(s), s.savedAt);

/** What the server has not taken yet, or null. */
const unsent = () => changesBetween(snapshot, snapshotOf(state), state.savedAt);

/** The ids of every deck and card a set of changes touches. */
const idsOf = (changes) => [
  ...(changes.decks ?? []).map((d) => d.id),
  ...(changes.cards ?? []).map((c) => c.id),
  ...(changes.deletedDecks ?? []),
  ...(changes.deletedCards ?? []),
];

// ---- Changes not yet sent, kept in the browser

const pendingKey = () => `recall.pending.${userId}`;

function readPending() {
  try {
    const raw = userId && globalThis.localStorage?.getItem(pendingKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writePending(changes) {
  try {
    const storage = globalThis.localStorage;
    if (!storage || !userId) return;
    if (changes) storage.setItem(pendingKey(), JSON.stringify(changes));
    else storage.removeItem(pendingKey());
  } catch {
    // Browser storage full or blocked; the changes still go to the server when it can be reached.
  }
}

/** Keep what the server has not taken yet, so closing the page does not lose it. */
const keepPending = () => writePending(unsent());

/**
 * Lay changes made here over the state, leaving out those to the ids in `skip`. Answer counts
 * are merged, keeping the larger count, as the server does.
 */
function applyLocal(changes, skip = new Set()) {
  const put = (list, items) => {
    const at = new Map(list.map((x, i) => [x.id, i]));
    for (const item of items ?? []) {
      if (skip.has(item.id)) continue;
      if (at.has(item.id)) list[at.get(item.id)] = item;
      else list.push(item);
    }
  };
  const gone = (ids) => new Set((ids ?? []).filter((id) => !skip.has(id)));
  const deletedDecks = gone(changes.deletedDecks);
  const deletedCards = gone(changes.deletedCards);
  state.decks = state.decks.filter((d) => !deletedDecks.has(d.id));
  state.cards = state.cards.filter((c) => !deletedCards.has(c.id) && !deletedDecks.has(c.deckId));
  put(state.decks, changes.decks);
  put(state.cards, changes.cards);
  if (changes.daily) state.daily = mergeCounts(state.daily, changes.daily);
  if (changes.log) state.log = mergeCounts(state.log, changes.log);
  if (changes.settings) state.settings = changes.settings;
}

// ---- Talking to the server

/** Fetch this user's state; null when signed out. Throws when the server cannot be reached. */
async function fetchState() {
  const res = await fetch('api/state', { cache: 'no-store' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`load failed: ${res.status}`);
  server.voice = decodeURIComponent(res.headers.get('X-Tts-Engine') ?? '') || null;
  return normalize(await res.json());
}

/** Take `data` as the state the server holds. */
function useState(data) {
  state = data;
  // Taken after normalize, so the defaults it fills in are not sent back as changes.
  snapshot = snapshotOf(state);
}

/** Who is signed in, or null. */
async function whoAmI() {
  try {
    return (await api.me()).user;
  } catch (error) {
    if (error.message === 'signed-out') return null;
    throw error;
  }
}

/**
 * Load the signed-in user's state from the server, then lay over it any changes this browser
 * made for the same user that never reached the server, and send them. Throws when the server
 * cannot be reached.
 */
export async function load() {
  const [user, data] = await Promise.all([whoAmI(), fetchState()]);
  if (!user || !data) return { signedIn: false };
  userId = user.id;
  useState(data);
  server.available = true;
  server.signedOut = false;
  server.ok = true;
  const pending = readPending();
  if (pending) {
    applyLocal(pending);
    flush();
  }
  return { signedIn: true };
}

/**
 * Take the state from the server again, as another device may have changed it, unless changes
 * made here are still on their way. Tells the listener when it did.
 */
export async function refresh() {
  if (!server.available || server.signedOut || writing || unsent()) return false;
  const before = snapshot;
  let data;
  try {
    data = await fetchState();
  } catch {
    return false;
  }
  if (!data) {
    signOut();
    return false;
  }
  // Something was changed or saved while it loaded; that is newer than what came back.
  if (writing || snapshot !== before || unsent()) return false;
  useState(data);
  notify();
  return true;
}

/**
 * Send what is left, waiting for a save already on its way, then log out and forget this user's
 * changes kept in the browser. Throws Error('unsaved'), staying signed in with those changes
 * kept, when the server has not taken them all, and Error('signed-out') when the session had
 * already ended.
 */
export async function logOut() {
  await flush();
  if (server.signedOut) throw new Error('signed-out');
  if (unsent()) throw new Error('unsaved');
  await api.logOut();
  // Anything changed while logging out stays kept for this user's next login.
  keepPending();
  userId = null;
  server.available = false;
  useState(emptyState());
}

function setOk(ok) {
  if (server.ok === ok) return;
  server.ok = ok;
  notify();
}

function signOut() {
  server.signedOut = true;
  notify();
}

/**
 * Some changes were refused: start again from what the server holds, then lay over it the
 * changes made since `sent` was sent, except those to the ids in `refused`. Returns whether
 * the state was reloaded.
 */
async function reload(sent, refused) {
  let data;
  try {
    data = await fetchState();
  } catch {
    return false;
  }
  if (!data) {
    signOut();
    return false;
  }
  const later = changesBetween(sent, snapshotOf(state), state.savedAt);
  useState(data);
  if (later) applyLocal(later, refused);
  notify('Some changes could not be saved');
  return true;
}

/**
 * Send the server what changed since it last saved. Each change is read when it is sent, and
 * only what was sent counts as saved, so edits made meanwhile go in the next request.
 * A failure to reach the server is retried every 5 seconds. Resolves when nothing is on its way,
 * waiting for a save already being sent.
 */
export function flush() {
  if (!server.available || server.signedOut) return Promise.resolve();
  if (writing) {
    dirty = true;
    return sending;
  }
  writing = true;
  sending = send();
  return sending;
}

/** Send changes until none are left or sending fails. */
async function send() {
  clearTimeout(retry);
  do {
    dirty = false;
    const next = snapshotOf(state);
    const changes = changesBetween(snapshot, next, state.savedAt);
    if (!changes) break;
    try {
      const res = await fetch('api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      if (res.status === 401) {
        signOut();
        break;
      }
      // Any other refusal of the whole request would only be refused again: start over.
      const refusedAll = res.status >= 400 && res.status < 500 && res.status !== 429;
      if (!res.ok && !refusedAll) throw new Error(`save failed: ${res.status}`);
      const { rejected = [] } = refusedAll ? { rejected: idsOf(changes) } : await res.json();
      if (!refusedAll) snapshot = next;
      setOk(true);
      if (refusedAll || rejected.length) {
        if (!(await reload(next, new Set(rejected)))) {
          if (server.signedOut) break;
          throw new Error('reload failed');
        }
        dirty = true;
      }
    } catch {
      setOk(false);
      retry = setTimeout(flush, 5000);
      break;
    }
  } while (dirty && !server.signedOut);
  writing = false;
  keepPending();
}

function save() {
  state.savedAt = Date.now();
  keepPending();
  flush();
}

function normalize(data) {
  if (!data || !Array.isArray(data.decks) || !Array.isArray(data.cards)) {
    throw new Error('Not a valid backup file');
  }
  const decks = data.decks
    .filter((d) => d && d.id && typeof d.name === 'string')
    .map((d) => ({ ...DECK_DEFAULTS, created: Date.now(), ...d }));
  const ids = new Set(decks.map((d) => d.id));
  const cards = data.cards
    .filter((c) => c && c.id && ids.has(c.deckId))
    .map((c) => ({ ...newSchedule(c.created ?? Date.now()), front: '', back: '', ...c }));
  return {
    ...emptyState(),
    savedAt: data.savedAt ?? 0,
    daily: data.daily ?? {},
    log: data.log ?? {},
    settings: data.settings ?? {},
    decks,
    cards,
  };
}

const uid = () =>
  globalThis.crypto?.randomUUID?.() ??
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export { dayKey };

// ---- Settings -------------------------------------------------------------

export const setting = (name) => state.settings[name];

export function setSetting(name, value) {
  state.settings[name] = value;
  save();
}

// ---- Decks ----------------------------------------------------------------

export const decks = () => state.decks;
export const deck = (id) => state.decks.find((d) => d.id === id);

// A deck given by the admin (`assigned: true`, from its owner `from`) is studied like any other,
// but its name, languages and cards are the owner's. These deck fields come from the owner, as
// listed in server/fields.js.
const SHARED_DECK_KEYS = ['name', 'created', 'ankiId', 'frontLang', 'backLang', 'saveAudio', 'groups', 'topics', 'topicsAt', 'deletedGroupIds', 'deletedTopicIds'];

/** Whether a deck's name and cards can be changed here: not for a deck given by the admin. */
export const editable = (deckId) => !deck(deckId)?.assigned;

function mustEdit(deckId) {
  if (!editable(deckId)) throw new Error('read-only deck');
}

export function createDeck({ name, ...options }) {
  const d = { ...DECK_DEFAULTS, ...options, id: uid(), name, created: Date.now() };
  state.decks.push(d);
  save();
  return d;
}

export function updateDeck(id, patch) {
  if (SHARED_DECK_KEYS.some((key) => key in patch)) mustEdit(id);
  Object.assign(deck(id), patch);
  save();
}

export function deleteDeck(id) {
  mustEdit(id);
  state.decks = state.decks.filter((d) => d.id !== id);
  state.cards = state.cards.filter((c) => c.deckId !== id);
  save();
}

// ---- Cards ----------------------------------------------------------------

export const card = (id) => state.cards.find((c) => c.id === id);
export const cardsIn = (deckId) => state.cards.filter((c) => c.deckId === deckId);

// A card on reserve (`reserved: true`) is kept out of study until it is pulled in.
const reserveFlag = (reserved) => (reserved ? { reserved: true } : {});

export function addCard(deckId, front, back, now = Date.now(), { reserved = false } = {}) {
  mustEdit(deckId);
  const c = { id: uid(), deckId, front, back, created: now, updated: now, ...newSchedule(now), ...reserveFlag(reserved) };
  state.cards.push(c);
  save();
  return c;
}

/**
 * Add many cards at once from `[front, back]` pairs. Returns how many were added. With `topicKey`
 * (from a topic file's name), every card is placed in that topic, which is made if it is new.
 */
export function addCards(deckId, pairs, now = Date.now(), { reserved = false, topicKey } = {}) {
  mustEdit(deckId);
  const place = topicKey ? { topic: ensureTopic(deckId, topicKey, now).id, topicBy: 'file', topicAt: now } : {};
  pairs.forEach(([front, back], i) => {
    // Stagger creation times so the cards keep the order they had in the file.
    const created = now + i;
    state.cards.push({ id: uid(), deckId, front, back, created, updated: created, ...newSchedule(now), ...reserveFlag(reserved), ...place });
  });
  save();
  return pairs.length;
}

/**
 * Add decks read from an Anki file by the server, with every card's schedule as it was.
 * Importing the same file again adds only the cards that are not here yet. With `reserved`,
 * the new cards go on their deck's reserve, in Anki's order; cards already being studied keep
 * their schedule. Returns how many cards were added; a `touched` Set collects the ids of the decks that got cards.
 */
export function importAnkiDecks(imported, now = Date.now(), { reserved = false, touched } = {}) {
  const known = ankiCardIds();
  let added = 0;
  for (const { ankiId, name, settings, cards } of imported) {
    const fresh = cards.filter((c) => !known.has(c.ankiId));
    if (!fresh.length) continue;
    // A given deck from the same file is the owner's; the import makes a deck of your own.
    let d = state.decks.find((x) => x.ankiId === ankiId && editable(x.id));
    if (!d) {
      d = { ...DECK_DEFAULTS, ...settings, id: uid(), name, ankiId, created: now };
      state.decks.push(d);
    }
    for (const c of fresh) {
      state.cards.push({ ...newSchedule(now), ...c, id: uid(), deckId: d.id, ...reserveFlag(reserved && c.state === State.New) });
    }
    added += fresh.length;
    touched?.add(d.id);
  }
  if (added) save();
  return added;
}

/** Anki's ids of the cards already imported. */
export const ankiCardIds = () => new Set(state.cards.map((c) => c.ankiId).filter(Boolean));

/**
 * Where the cards of an Anki file that are already here live: `[{ deck, cards }]`, one entry
 * per deck holding some, by that deck's name here. A file whose cards reuse another deck's
 * ids is otherwise silently skipped.
 */
export function ankiDuplicates(imported) {
  const deckOf = new Map(state.cards.filter((c) => c.ankiId).map((c) => [c.ankiId, c.deckId]));
  const counts = new Map();
  for (const { cards } of imported) {
    for (const c of cards) {
      const deckId = deckOf.get(c.ankiId);
      if (deckId) counts.set(deckId, (counts.get(deckId) ?? 0) + 1);
    }
  }
  return [...counts].map(([deckId, cards]) => ({ deck: state.decks.find((d) => d.id === deckId)?.name ?? 'a deleted deck', cards }));
}

export function updateCard(id, patch) {
  const c = card(id);
  if (['front', 'back', 'deckId'].some((key) => key in patch)) {
    mustEdit(c.deckId);
    if (patch.deckId) mustEdit(patch.deckId);
  }
  const moved = patch.deckId && patch.deckId !== c.deckId;
  Object.assign(c, patch, { updated: Date.now() });
  // A place in the reserve does not outlast leaving it, or changing deck.
  if (!c.reserved || moved) delete c.order;
  save();
}

// Once a reserve has been rearranged its cards carry their place in `order`. Cards added
// after that have none, and wait behind the rest, oldest first.
const byReserveOrder = (a, b) => {
  const placed = (a.order ?? Infinity) - (b.order ?? Infinity);
  return placed || a.created - b.created;
};

/** A deck's reserve in the order its cards are pulled in: as arranged, otherwise oldest first. */
export const reserveIn = (deckId) => cardsIn(deckId).filter((c) => c.reserved).sort(byReserveOrder);

/**
 * Move cards of a deck's reserve together to a new place in it, keeping their own order:
 * just `before` or `after` the card with that id, or to the end when neither is given.
 * Returns how many moved.
 */
export function moveInReserve(deckId, ids, { before, after } = {}) {
  const moving = new Set(ids);
  const all = reserveIn(deckId);
  const moved = all.filter((c) => moving.has(c.id));
  if (!moved.length) return 0;
  const rest = all.filter((c) => !moving.has(c.id));
  const anchor = rest.findIndex((c) => c.id === (before ?? after));
  rest.splice(anchor < 0 ? rest.length : anchor + (before ? 0 : 1), 0, ...moved);
  rest.forEach((c, i) => {
    c.order = i;
  });
  save();
  return moved.length;
}

/** Turn a deck's whole reserve around, so the last card is pulled in first. Returns how many cards it holds. */
export function reverseReserve(deckId) {
  const all = reserveIn(deckId).reverse();
  all.forEach((c, i) => {
    c.order = i;
  });
  save();
  return all.length;
}

/**
 * Move up to `n` cards from the front of a deck's reserve in with its new cards, where
 * they wait behind the new cards already there, in the order they had. Returns how many moved.
 * With a study `filter` (see `resolveFilter`), only reserve cards in it count: the first `n` of them.
 */
export function pullFromReserve(deckId, n = Infinity, now = Date.now(), filter) {
  const set = resolveFilter(deck(deckId), filter);
  return pullIn(reserveIn(deckId).filter((c) => inFilter(c, set)).slice(0, Math.max(0, n)), now);
}

/**
 * Move the reserve cards named in with their decks' new cards, in the order they had on the
 * reserve, behind the new cards already there. Cards not on reserve are skipped. Returns how many moved.
 */
export function pullCards(ids, now = Date.now()) {
  const named = new Set(ids);
  const deckIds = [...new Set(ids.map(card).filter((c) => c?.reserved).map((c) => c.deckId))];
  return pullIn(deckIds.flatMap((deckId) => reserveIn(deckId).filter((c) => named.has(c.id))), now);
}

function pullIn(pulled, now) {
  pulled.forEach((c, i) => {
    delete c.reserved;
    delete c.order;
    c.pulled = now + i;
  });
  if (pulled.length) save();
  return pulled.length;
}

/**
 * Put the cards named back on their deck's reserve, at the end of it in the order given.
 * A card already studied starts over as a new card, since the reserve holds only those.
 * Cards already on reserve are skipped. Returns how many went back.
 */
export function returnToReserve(ids, now = Date.now()) {
  const back = ids.map(card).filter((c) => c && !c.reserved);
  for (const c of back) {
    if (c.state !== State.New) Object.assign(c, newSchedule(now));
    delete c.pulled;
    c.reserved = true;
    c.updated = now;
  }
  // Number them behind the rest of each reserve, so they wait at the end, whatever their age.
  for (const deckId of new Set(back.map((c) => c.deckId))) {
    const all = reserveIn(deckId).filter((c) => !back.includes(c));
    all.push(...back.filter((c) => c.deckId === deckId));
    all.forEach((c, i) => {
      c.order = i;
    });
  }
  if (back.length) save();
  return back.length;
}

/**
 * Add a reversed copy of each card named, its back as the front, to the end of its deck's
 * reserve. A copy is marked `reversed`, so each side is still read in its own language.
 * Cards whose reverse is already in their deck are skipped. Returns the cards added.
 */
export function addReversed(ids, now = Date.now()) {
  const key = (deckId, front, back) => [deckId, front, back].map((text) => text.trim().toLowerCase()).join('\n');
  const known = new Set(state.cards.map((c) => key(c.deckId, c.front, c.back)));
  const named = ids.map(card).filter(Boolean);
  for (const c of named) mustEdit(c.deckId);
  const added = [];
  for (const c of named) {
    const copy = key(c.deckId, c.back, c.front);
    if (known.has(copy)) continue;
    known.add(copy);
    // Stagger creation times so the copies keep the order of their originals.
    const created = now + added.length;
    added.push({ id: uid(), deckId: c.deckId, front: c.back, back: c.front, created, updated: created, ...newSchedule(now), reserved: true, ...(!c.reversed && { reversed: true }) });
  }
  state.cards.push(...added);
  if (added.length) save();
  return added;
}

/** Delete several cards at once. Returns how many were deleted. */
export function deleteCards(ids) {
  for (const c of ids.map(card).filter(Boolean)) mustEdit(c.deckId);
  const doomed = new Set(ids);
  const before = state.cards.length;
  state.cards = state.cards.filter((c) => !doomed.has(c.id));
  if (state.cards.length !== before) save();
  return before - state.cards.length;
}

/** The group a card is listed under: 'reserve', 'new', 'learning', 'due' or 'later'. */
export function cardGroup(c, now = Date.now()) {
  if (c.reserved) return 'reserve';
  if (c.state === State.New) return 'new';
  if (isLearning(c)) return 'learning';
  return c.due < nextDayAt(now) ? 'due' : 'later';
}

const SORTS = {
  newest: (a, b) => b.created - a.created,
  oldest: (a, b) => a.created - b.created,
  front: (a, b) => a.front.localeCompare(b.front, undefined, { sensitivity: 'base' }),
  lapses: (a, b) => b.lapses - a.lapses || b.created - a.created,
  reserve: (a, b) => Boolean(b.reserved) - Boolean(a.reserved) || (a.reserved ? byReserveOrder(a, b) : b.created - a.created),
};

/**
 * The cards of a deck that pass every filter given, sorted.
 *   text    words to find on either side
 *   groups  card groups to keep (see `cardGroup`); none means all of them
 *   due     'overdue', 'today' (or earlier), 'week' or 'month': when the next review falls.
 *           New and reserve cards have no review coming, so any of these leaves them out.
 *   added   'today', 'week' or 'month': how recently the card was created
 *   lapses  'some' (forgotten at least once) or 'many' (three times or more)
 *   topics  a study filter (see `resolveFilter`: `g:` groups, `t:` topics, `'unsorted'`); none means all
 *   sort    'newest', 'oldest', 'due' (soonest first), 'front' (A to Z), 'lapses' or
 *           'reserve' (the reserve first, in the order it is pulled in)
 */
export function findCards(deckId, { text = '', groups = [], due = 'any', added = 'any', lapses = 'any', topics = [], sort = 'newest' } = {}, now = Date.now()) {
  const q = text.trim().toLowerCase();
  const today = dayStart(now);
  const tomorrow = nextDayAt(now);
  const wanted = new Set(groups);
  const topicSet = resolveFilter(deck(deckId), topics);
  const scheduled = (c) => !c.reserved && c.state !== State.New;
  const dueBefore = { today: tomorrow, week: tomorrow + 6 * DAY, month: tomorrow + 29 * DAY }[due];
  const addedSince = { today, week: today - 6 * DAY, month: today - 29 * DAY }[added];
  const minLapses = { some: 1, many: 3 }[lapses] ?? 0;
  const dueAt = (c) => (scheduled(c) ? c.due : Infinity);

  return cardsIn(deckId)
    .filter(
      (c) =>
        (!q || `${c.front}\n${c.back}`.toLowerCase().includes(q)) &&
        (!wanted.size || wanted.has(cardGroup(c, now))) &&
        inFilter(c, topicSet) &&
        (due !== 'overdue' || (c.state === State.Review && !c.reserved && c.due < today)) &&
        (!dueBefore || (scheduled(c) && c.due < dueBefore)) &&
        (!addedSince || c.created >= addedSince) &&
        c.lapses >= minLapses,
    )
    .sort(sort === 'due' ? (a, b) => dueAt(a) - dueAt(b) || b.created - a.created : (SORTS[sort] ?? SORTS.newest));
}

export function deleteCard(id) {
  const c = card(id);
  if (c) mustEdit(c.deckId);
  state.cards = state.cards.filter((c) => c.id !== id);
  save();
}

// ---- Topics ---------------------------------------------------------------
// A deck's cards sit in topics, and topics sit in groups (or on their own). Both are the owner's
// content, so none of this can change in a given deck. None of it touches a card's schedule.

// Stamp a change to the deck's groups or topics, and save.
function touchTopics(d, now) {
  d.topicsAt = now;
  save();
}

export function createGroup(deckId, name, now = Date.now()) {
  mustEdit(deckId);
  const d = deck(deckId);
  const group = { id: uid(), name };
  (d.groups ??= []).push(group);
  touchTopics(d, now);
  return group;
}

export function renameGroup(deckId, groupId, name, now = Date.now()) {
  mustEdit(deckId);
  const d = deck(deckId);
  const group = (d.groups ?? []).find((g) => g.id === groupId);
  if (!group) return;
  group.name = name;
  touchTopics(d, now);
}

// Remember a deleted group or topic id (the most recent 500), so a sync never brings it back.
const remember = (list, id) => [...(list ?? []).filter((x) => x !== id), id].slice(-500);

/** Remove a group. Its topics are kept, outside any group. */
export function deleteGroup(deckId, groupId, now = Date.now()) {
  mustEdit(deckId);
  const d = deck(deckId);
  d.groups = (d.groups ?? []).filter((g) => g.id !== groupId);
  d.deletedGroupIds = remember(d.deletedGroupIds, groupId);
  for (const t of d.topics ?? []) if (t.groupId === groupId) t.groupId = null;
  touchTopics(d, now);
}

/** The topic with this file key, made (named from the key, in its prefix's group) if it is new. */
export function ensureTopic(deckId, key, now = Date.now()) {
  mustEdit(deckId);
  const d = deck(deckId);
  const known = (d.topics ?? []).find((t) => t.key === key);
  if (known) return known;
  const topic = { id: uid(), key, name: readableTopicName(key), groupId: prefixGroup(d, key), by: 'file' };
  (d.topics ??= []).push(topic);
  touchTopics(d, now);
  return topic;
}

export function createTopic(deckId, name, groupId = null, now = Date.now()) {
  mustEdit(deckId);
  const d = deck(deckId);
  const topic = { id: uid(), name, groupId: groupId ?? null, by: 'admin' };
  (d.topics ??= []).push(topic);
  touchTopics(d, now);
  return topic;
}

export function renameTopic(deckId, topicId, name, now = Date.now()) {
  mustEdit(deckId);
  const d = deck(deckId);
  const topic = (d.topics ?? []).find((t) => t.id === topicId);
  if (!topic) return;
  topic.name = name;
  touchTopics(d, now);
}

/** Put a topic in a group, or on its own with `null`. */
export function moveTopic(deckId, topicId, groupId, now = Date.now()) {
  mustEdit(deckId);
  const d = deck(deckId);
  const topic = (d.topics ?? []).find((t) => t.id === topicId);
  if (!topic) return;
  topic.groupId = groupId ?? null;
  touchTopics(d, now);
}

/** Remove a topic. Its cards become unsorted again, and the clearing wins when decks sync. */
export function deleteTopic(deckId, topicId, now = Date.now()) {
  mustEdit(deckId);
  const d = deck(deckId);
  d.topics = (d.topics ?? []).filter((t) => t.id !== topicId);
  d.deletedTopicIds = remember(d.deletedTopicIds, topicId);
  for (const c of cardsIn(deckId)) {
    if (c.topic !== topicId) continue;
    delete c.topic;
    delete c.topicBy;
    c.topicAt = now;
  }
  touchTopics(d, now);
}

/**
 * Place cards in a topic by hand, or with `null` take them out of any topic. Either way the
 * placement is theirs to keep: the sorter leaves it alone. Returns how many cards changed.
 */
export function setCardsTopic(ids, topicId, now = Date.now()) {
  const cards = ids.map(card).filter(Boolean);
  for (const c of cards) mustEdit(c.deckId);
  for (const c of cards) {
    if (topicId) c.topic = topicId;
    else delete c.topic;
    c.topicBy = 'manual';
    c.topicAt = now;
  }
  if (cards.length) save();
  return cards.length;
}

/** How many cards in a deck have no topic and were not left that way by hand. */
export const unsortedCount = (deckId) => cardsIn(deckId).filter((c) => !c.topic && c.topicBy !== 'manual').length;

/**
 * For each topic id (`''` is Unsorted) with cards, what it holds now: `due` learning and review
 * cards, `fresh` new cards (all of them, not only today's allowance) and `reserve` cards.
 */
export function topicCounts(deckId, now = Date.now()) {
  const out = new Map();
  const end = nextDayAt(now);
  for (const c of cardsIn(deckId)) {
    const n = out.get(c.topic ?? '') ?? { due: 0, fresh: 0, reserve: 0 };
    if (c.reserved) n.reserve++;
    else if (c.state === State.New) n.fresh++;
    else if (c.state === State.Review ? c.due < end : isLearning(c)) n.due++;
    out.set(c.topic ?? '', n);
  }
  return out;
}

// ---- Study queue ----------------------------------------------------------

const isLearning = (c) => c.state === State.Learning || c.state === State.Relearning;

// The cards to study today. The new-card allowance is the deck's, whatever the `filter` (a study
// filter, see `resolveFilter`): the filter picks which cards fill it, and none means all of them.
function queue(deckId, now, filter) {
  const d = deck(deckId);
  const set = resolveFilter(d, filter);
  const today = dayStart(now);
  const all = cardsIn(deckId).filter((c) => !c.reserved);
  const introduced = all.filter((c) => c.introduced >= today).length;
  const allowance = Math.max(0, d.newPerDay - introduced);
  return {
    allowance,
    learning: all.filter((c) => isLearning(c) && inFilter(c, set)).sort((a, b) => a.due - b.due),
    // Review cards are scheduled in whole days, so anything due today counts.
    review: all
      .filter((c) => c.state === State.Review && c.due < nextDayAt(now) && inFilter(c, set))
      .sort((a, b) => a.due - b.due),
    fresh: all
      .filter((c) => c.state === State.New && inFilter(c, set))
      .sort((a, b) => (a.pulled ?? a.created) - (b.pulled ?? b.created))
      .slice(0, allowance),
  };
}

/**
 * How many cards are waiting in a deck today, by kind, and how many it holds in all and on reserve.
 * `tomorrow` counts the same kinds for tomorrow, as `upcoming` does.
 * With a study `filter`, `new`, `learning`, `review` and `total` count only cards in it; the rest
 * stay deck-wide. `newLeft` is the deck's new-card allowance left today, which a filter shares.
 */
export function counts(deckId, now = Date.now(), filter) {
  const q = queue(deckId, now, filter);
  const n = { new: q.fresh.length, learning: q.learning.length, review: q.review.length };
  const all = cardsIn(deckId);
  const { start, ...tomorrow } = upcoming(deckId, 2, now)[1];
  return {
    ...n,
    total: n.new + n.learning + n.review,
    newLeft: q.allowance,
    tomorrow,
    cards: all.length,
    reserve: all.filter((c) => c.reserved).length,
  };
}

/**
 * The cards coming up on each of the next `days` days, starting with today, for one deck or,
 * without `deckId`, for all of them. Each day is `{ start, new, learning, review, total }`.
 * Today is what the study queue holds now, overdue cards included. Later days suppose every
 * day's cards are studied: the learning and review cards already scheduled for that day, and new
 * cards at the deck's daily limit until none are left. The reserve is left out, as its cards only
 * come in when pulled, and so are the reviews of cards not yet studied, as their days are not known.
 */
export function upcoming(deckId, days = 30, now = Date.now()) {
  const out = [];
  for (let i = 0, start = dayStart(now); i < days; i++, start = nextDayAt(start)) {
    out.push({ start, new: 0, learning: 0, review: 0, total: 0 });
  }
  for (const d of deckId ? [deck(deckId)] : state.decks) {
    const q = queue(d.id, now);
    out[0].new += q.fresh.length;
    out[0].learning += q.learning.length;
    out[0].review += q.review.length;
    const studied = cardsIn(d.id).filter((c) => !c.reserved);
    let waiting = studied.filter((c) => c.state === State.New).length - q.fresh.length;
    for (const day of out.slice(1)) {
      const n = Math.min(d.newPerDay, waiting);
      day.new += n;
      waiting -= n;
    }
    for (const c of studied) {
      if (c.state === State.New) continue;
      // Rounded, as a day can be an hour short or long when the clocks change.
      const i = Math.round((dayStart(c.due) - out[0].start) / DAY);
      if (i > 0 && i < days) out[i][isLearning(c) ? 'learning' : 'review']++;
    }
  }
  for (const day of out) day.total = day.new + day.learning + day.review;
  return out;
}

/** The next card to study, or `undefined` when the deck is done for today. `filter` limits it to a study filter. */
export function nextCard(deckId, now = Date.now(), filter) {
  const q = queue(deckId, now, filter);
  if (q.learning[0]?.due <= now) return q.learning[0];
  // Otherwise show waiting learning cards early rather than making the user wait.
  return q.review[0] ?? q.fresh[0] ?? q.learning[0];
}

// Deterministic per card and review, so the intervals shown are the ones applied.
function fuzzFactor(c) {
  let h = 2166136261;
  for (const ch of `${c.id}:${c.reps}`) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}

function schedulingOptions(c) {
  const { scheduler, retention, easyInterval, fsrsParams } = deck(c.deckId);
  return { scheduler, retention, easyInterval, w: fsrsParams, fuzz: fuzzFactor(c) };
}

export function previewCard(id, now = Date.now()) {
  const c = card(id);
  return preview(c, now, schedulingOptions(c));
}

export function answerCard(id, rating, now = Date.now()) {
  const c = card(id);
  const next = schedule(c, rating, now, schedulingOptions(c));
  if (c.state === State.New) c.introduced = now;
  const kind = c.state !== State.Review ? 0 : c.scheduledDays < MATURE_DAYS ? 1 : 2;
  Object.assign(c, next);
  const key = dayKey(now);
  state.daily[key] = (state.daily[key] ?? 0) + 1;
  const answers = ((state.log[key] ??= {})[c.deckId] ??= Array(12).fill(0));
  answers[kind * 4 + rating - 1]++;
  save();
}

// ---- Stats and backup -----------------------------------------------------

// A review card is mature once its interval reaches three weeks, as in Anki.
const MATURE_DAYS = 21;

/** The kinds of card an answer is logged under, in the order `statistics` reports them. */
export const ANSWER_KINDS = ['Learning', 'Young', 'Mature'];

export const stats = (now = Date.now()) => streakOf(state.daily, now);

/** Reviews on each of the last `n` days, oldest first and ending today, as `{ date, n }`. */
export function recentDays(n, now = Date.now()) {
  const day = new Date(dayStart(now));
  day.setDate(day.getDate() - (n - 1));
  const days = [];
  for (let i = 0; i < n; i++, day.setDate(day.getDate() + 1)) days.push({ date: new Date(day), n: state.daily[dayKey(day)] ?? 0 });
  return days;
}

/**
 * Figures for the statistics page, for one deck or, without `deckId`, for all of them.
 *   cards      how many cards are new, learning, young and mature, leaving out the reserve
 *   perDay     answers given on each day, keyed like '2026-01-31'
 *   forecast   cards coming due on each of the next `days` days; today includes overdue ones
 *   answers    Again, Hard, Good and Easy counts over the last `days` days, per ANSWER_KINDS
 *   loggedFrom the first day `answers` has data for, or null
 *   partial    whether answers were given before `loggedFrom`, which `answers` (and a
 *              single deck's `perDay`) cannot include
 */
export function statistics(deckId, days = 30, now = Date.now()) {
  const today = dayStart(now);
  const mine = (deckId ? cardsIn(deckId) : state.cards).filter((c) => !c.reserved);

  const cards = { new: 0, learning: 0, young: 0, mature: 0 };
  const forecast = Array(days).fill(0);
  for (const c of mine) {
    if (c.state === State.New) {
      cards.new++;
      continue;
    }
    if (isLearning(c)) cards.learning++;
    else if (c.scheduledDays < MATURE_DAYS) cards.young++;
    else cards.mature++;
    const offset = Math.max(0, Math.round((dayStart(c.due) - today) / DAY));
    if (offset < days) forecast[offset]++;
  }

  const first = new Date(today);
  first.setDate(first.getDate() - (days - 1));
  const from = dayKey(first);
  const answers = ANSWER_KINDS.map(() => [0, 0, 0, 0]);
  const logged = {};
  for (const [key, byDeck] of Object.entries(state.log)) {
    for (const [id, row] of Object.entries(byDeck)) {
      if (deckId && id !== deckId) continue;
      logged[key] = (logged[key] ?? 0) + row.reduce((sum, n) => sum + n, 0);
      if (key >= from) row.forEach((n, i) => (answers[Math.floor(i / 4)][i % 4] += n));
    }
  }
  const loggedFrom = Object.keys(logged).sort()[0] ?? null;
  const perDay = deckId ? logged : state.daily;

  return {
    cards,
    perDay,
    ...streakOf(perDay, now),
    forecast,
    answers,
    loggedFrom,
    partial: Object.keys(state.daily).some((key) => !loggedFrom || key < loggedFrom),
  };
}

export const exportData = () => JSON.stringify(state, null, 2);

export function importData(json) {
  state = normalize(JSON.parse(json));
  save();
}

export function reset() {
  state = emptyState();
  save();
}
