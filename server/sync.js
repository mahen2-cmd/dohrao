// Each user's view of the store, and applying their changes under ownership rules.
import { DECK_SHARED, CARD_CONTENT, split, mergeTopics, mergeDeckTopics } from './fields.js';
import { newSchedule } from '../js/fsrs.js';
import { FRONTS, URDU_FIELDS, switchedFront } from '../js/urdu.js';
import { cleanCounts, mergeCounts } from '../js/counts.js';

// Keys the view adds to given decks; never stored.
const VIEW_ONLY = ['assigned', 'from', 'urduSwitch', 'urduSwitchAt'];

const parse = (text) => (text ? JSON.parse(text) : {});
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

// The most one card's progress and one deck's prefs may take, as JSON. Real ones are a few
// hundred bytes; these leave plenty of room and keep hand-made records small.
const MAX_PROGRESS = 4 * 1024;
const MAX_PREFS = 8 * 1024;
const URDU_SCRIPTS = ['arabic', 'roman'];
// A deck's folder is the id of one of the person's folders.
const MAX_FOLDER_ID = 100;
// The most a card's sides, its content and a deck may take, and how many cards one person may
// own. Real ones are far smaller: the longest side is under 1,000 characters, the largest card
// about 1 KB, the largest deck 11 KB and the biggest account under 10,000 cards.
const MAX_SIDE = 20_000;
const MAX_CARD = 64 * 1024;
const MAX_DECK = 512 * 1024;
const MAX_DECK_NAME = 300;
export const MAX_CARDS = 50_000;
export const MAX_DECKS = 1_000;
// Progress fields the app reads, which must be finite numbers. Others (from a newer version
// of the app) are kept as they come.
const PROGRESS_NUMBERS = ['stability', 'difficulty', 'stability7', 'stabilityFast7', 'difficulty7', 'due', 'scheduledDays', 'ease', 'left', 'reps', 'lapses', 'introduced', 'order', 'pulled'];

/** Whether a card's progress has the types the app relies on, and a sensible size. */
// A key set to undefined is left out, as it is when sent as JSON.
const has = (obj, key) => obj[key] !== undefined;

function validProgress(p) {
  if (has(p, 'state') && !(Number.isInteger(p.state) && p.state >= 0 && p.state <= 3)) return false;
  if (PROGRESS_NUMBERS.some((key) => has(p, key) && !Number.isFinite(p[key]))) return false;
  if (has(p, 'lastReview') && p.lastReview !== null && !Number.isFinite(p.lastReview)) return false;
  if (has(p, 'reserved') && typeof p.reserved !== 'boolean') return false;
  return bytes(p) <= MAX_PROGRESS;
}

/** Whether a card's content fits the limits. Too much is refused, never cut short. */
function validContent(c) {
  const side = (key) => typeof c[key] !== 'string' || c[key].length <= MAX_SIDE;
  return side('front') && side('back') && bytes(c) <= MAX_CARD;
}

/** Whether a deck's shared fields fit the limits. */
const validShared = (d) => (typeof d.name !== 'string' || d.name.length <= MAX_DECK_NAME) && bytes(d) <= MAX_DECK;

/** Whether one person's prefs for a deck hold choices the app has, at a sensible size. */
function validPrefs(p) {
  if (has(p, 'frontShows') && !FRONTS.includes(p.frontShows)) return false;
  if (has(p, 'urduScript') && !URDU_SCRIPTS.includes(p.urduScript)) return false;
  if (has(p, 'folder') && !(typeof p.folder === 'string' && p.folder.length <= MAX_FOLDER_ID)) return false;
  if (has(p, 'homeOrder') && !Number.isFinite(p.homeOrder)) return false;
  return bytes(p) <= MAX_PREFS;
}
const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 100;

// The review log: one entry per answer, never sent back to the app.
const MAX_REVIEW = 1024;
const MAX_REVIEWS_PER_SYNC = 200_000;
const MAX_DURATION = 60_000;
const MAX_ACTIVE = 3_600_000;
const SCHEDULERS = ['sm2', 'fsrs', 'fsrs7'];
const intIn = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
const finiteOrNull = (x) => x === null || Number.isFinite(x);

/** Whether a review log entry has the fields and types the log keeps, at a sensible size. */
function validReview(r) {
  return (
    validId(r.cardId) &&
    validId(r.deckId) &&
    Number.isFinite(r.at) &&
    intIn(r.rating, 1, 4) &&
    intIn(r.state, 0, 3) &&
    ['elapsed', 'retention', 'intervalBefore', 'intervalAfter'].every((k) => finiteOrNull(r[k])) &&
    (r.duration === null || (Number.isFinite(r.duration) && r.duration >= 0 && r.duration <= MAX_DURATION)) &&
    (r.active === undefined || r.active === null || intIn(r.active, 0, MAX_ACTIVE)) &&
    (r.scheduler === null || SCHEDULERS.includes(r.scheduler)) &&
    bytes(r) <= MAX_REVIEW
  );
}

/**
 * Keep one answer in `userId`'s log, once, for a card they can study. An answer to a card that
 * is gone (deleted since, here or on another device) is taken and dropped, as there is nothing
 * left to log it against. A sync can carry many thousands, so the statements and each card's
 * deck and access are looked up once per sync, in `room`.
 */
function applyReview(db, userId, r, room) {
  if (!validReview(r) || room.reviews-- <= 0) return false;
  room.insertReview ??= db.prepare('INSERT OR IGNORE INTO reviews (id, user_id, card_id, at, data) VALUES (?, ?, ?, ?, ?)');
  room.deckOf ??= new Map();
  room.accessTo ??= new Map();
  if (!room.deckOf.has(r.cardId)) room.deckOf.set(r.cardId, deckOfCard(db, r.cardId));
  const deckId = room.deckOf.get(r.cardId);
  if (deckId === undefined) return true;
  if (!room.accessTo.has(deckId)) room.accessTo.set(deckId, access(db, userId, deckId));
  const kind = room.accessTo.get(deckId);
  if (kind !== 'own' && kind !== 'given') return false;
  room.insertReview.run(r.id, userId, r.cardId, r.at, JSON.stringify({ ...r, deckId }));
  return true;
}

/** Everything in `userId`'s review log, oldest first. */
export function reviewsOf(db, userId) {
  return db.prepare('SELECT data FROM reviews WHERE user_id = ? ORDER BY at, rowid').all(userId).map((row) => JSON.parse(row.data));
}

function ownDecks(db, userId) {
  return db.prepare('SELECT id, data FROM decks WHERE owner_id = ? ORDER BY rowid').all(userId);
}

function givenDecks(db, userId) {
  return db.prepare(`
    SELECT d.id, d.data, u.name AS owner, a.urdu, a.urdu_at, a.front FROM assignments a
    JOIN decks d ON d.id = a.deck_id JOIN users u ON u.id = d.owner_id
    WHERE a.user_id = ? AND a.active = 1 AND d.owner_id <> ?
    ORDER BY a.assigned, d.rowid`).all(userId, userId);
}

/** A deck's cards for one user: content plus their progress, new arrivals on their reserve. */
function cardsFor(db, userId, deckId, given) {
  const rows = db.prepare(`
    SELECT c.id, c.data, p.data AS progress FROM cards c
    LEFT JOIN progress p ON p.card_id = c.id AND p.user_id = ?
    WHERE c.deck_id = ? ORDER BY c.rowid`).all(userId, deckId);
  const cards = rows.map((r) => ({ id: r.id, deckId, ...parse(r.data), ...parse(r.progress) }));
  if (!given) return cards;
  const orders = rows.filter((r) => r.progress).map((r) => parse(r.progress).order).filter(Number.isFinite);
  // A loop, not Math.max(...orders): spreading a big deck's cards into a call overflows the stack.
  const maxOrder = orders.length ? orders.reduce((max, order) => (order > max ? order : max)) : -1;
  const fresh = cards.filter((_, i) => !rows[i].progress).sort((a, b) => a.created - b.created);
  fresh.forEach((c, i) => Object.assign(c, newSchedule(c.created), { reserved: true, order: maxOrder + 1 + i }));
  return cards;
}

/** Everything one user sees: their decks, decks given to them, the cards in both, and their state. */
export function buildView(db, userId, now) {
  const prefsOf = (deckId) =>
    parse(db.prepare('SELECT data FROM deck_prefs WHERE user_id = ? AND deck_id = ?').get(userId, deckId)?.data);
  const decks = [];
  const cards = [];
  for (const d of ownDecks(db, userId)) {
    decks.push({ id: d.id, ...parse(d.data), ...prefsOf(d.id) });
    for (const c of cardsFor(db, userId, d.id, false)) cards.push(c);
  }
  for (const d of givenDecks(db, userId)) {
    const given = { id: d.id, ...parse(d.data), ...prefsOf(d.id), assigned: true, from: d.owner };
    if (d.urdu_at !== null) Object.assign(given, { urduSwitch: switchedFront(d), urduSwitchAt: d.urdu_at });
    decks.push(given);
    for (const c of cardsFor(db, userId, d.id, true)) cards.push(c);
  }
  const s = db.prepare('SELECT daily, log, time, settings, saved_at FROM user_state WHERE user_id = ?').get(userId);
  return {
    version: 1,
    decks,
    cards,
    daily: parse(s?.daily),
    log: parse(s?.log),
    time: parse(s?.time),
    settings: parse(s?.settings),
    savedAt: s?.saved_at ?? 0,
  };
}

/** 'own', 'given' (actively assigned to the user), 'other', or null when no such deck. */
export function access(db, userId, deckId) {
  const d = db.prepare('SELECT owner_id FROM decks WHERE id = ?').get(deckId);
  if (!d) return null;
  if (d.owner_id === userId) return 'own';
  const a = db.prepare('SELECT 1 FROM assignments WHERE deck_id = ? AND user_id = ? AND active = 1').get(deckId, userId);
  return a ? 'given' : 'other';
}

const ownedCards = (db, userId) =>
  db.prepare('SELECT count(*) AS n FROM cards c JOIN decks d ON d.id = c.deck_id WHERE d.owner_id = ?').get(userId).n;

const deckOfCard = (db, cardId) => db.prepare('SELECT deck_id FROM cards WHERE id = ?').get(cardId)?.deck_id;

function savePrefs(db, userId, deckId, prefs) {
  db.prepare(`INSERT INTO deck_prefs (user_id, deck_id, data) VALUES (?, ?, ?)
    ON CONFLICT (user_id, deck_id) DO UPDATE SET data = excluded.data`).run(userId, deckId, JSON.stringify(prefs));
}

function saveProgress(db, userId, cardId, progress) {
  db.prepare(`INSERT INTO progress (user_id, card_id, data) VALUES (?, ?, ?)
    ON CONFLICT (user_id, card_id) DO UPDATE SET data = excluded.data`).run(userId, cardId, JSON.stringify(progress));
}

/** `room.decks` is how many more decks the user may own, counted once per sync like cards. */
function applyDeck(db, userId, deck, now, room) {
  const clean = { ...deck };
  for (const key of VIEW_ONLY) delete clean[key];
  const [shared, prefs] = split(clean, DECK_SHARED);
  if (!validPrefs(prefs)) return false;
  const kind = access(db, userId, deck.id);
  if (kind === 'other') return false;
  if ((kind === null || kind === 'own') && !validShared(shared)) return false;
  // A given deck that no longer exists was deleted by its owner; a device still showing it must
  // not bring it back as the recipient's own.
  if (kind === null && deck.assigned) return false;
  if (kind === null) {
    room.decks ??= MAX_DECKS - db.prepare('SELECT count(*) AS n FROM decks WHERE owner_id = ?').get(userId).n;
    if (room.decks <= 0) return false;
    room.decks--;
    db.prepare('INSERT INTO decks (id, owner_id, data) VALUES (?, ?, ?)').run(deck.id, userId, JSON.stringify(shared));
  } else if (kind === 'own') {
    const stored = parse(db.prepare('SELECT data FROM decks WHERE id = ?').get(deck.id).data);
    const merged = mergeDeckTopics(stored, shared);
    db.prepare('UPDATE decks SET data = ? WHERE id = ?').run(JSON.stringify(merged), deck.id);
  }
  // The server stamps when each person last chose what their card fronts show; a device's own
  // clock is never trusted for it. A newer stamp from the device marks a fresh choice, even of
  // the value already stored; an echo of the stored stamp is not one.
  const storedPrefs = parse(db.prepare('SELECT data FROM deck_prefs WHERE user_id = ? AND deck_id = ?').get(userId, deck.id)?.data);
  const chosen = prefs.frontShows !== storedPrefs.frontShows || (prefs.frontShowsAt ?? 0) > (storedPrefs.frontShowsAt ?? 0);
  if (chosen) prefs.frontShowsAt = now;
  else if (storedPrefs.frontShowsAt !== undefined) prefs.frontShowsAt = storedPrefs.frontShowsAt;
  else delete prefs.frontShowsAt;
  savePrefs(db, userId, deck.id, prefs);
  return true;
}

/**
 * `room.left` is how many more cards the user may own; it is counted once per sync and goes
 * down with each card added.
 */
function applyCard(db, userId, card, now, room) {
  if (!validId(card.deckId)) return false;
  const [content, progress] = split(card, CARD_CONTENT);
  if (!validProgress(progress)) return false;
  const current = deckOfCard(db, card.id);
  const target = access(db, userId, card.deckId);
  if (current === undefined) {
    if (target !== 'own' || !validContent(content)) return false;
    room.left ??= MAX_CARDS - ownedCards(db, userId);
    if (room.left <= 0) return false;
    room.left--;
    db.prepare('INSERT INTO cards (id, deck_id, data) VALUES (?, ?, ?)').run(card.id, card.deckId, JSON.stringify(content));
  } else {
    const from = access(db, userId, current);
    if (from === 'own' && target === 'own') {
      if (!validContent(content)) return false;
      const stored = parse(db.prepare('SELECT data FROM cards WHERE id = ?').get(card.id).data);
      // Only the sorter writes 'ai', and it never moves a manual card, so a hand placement
      // (even one made offline before the sort) wins over it whatever the times say.
      const manualOverAi = content.topicBy === 'manual' && stored.topicBy === 'ai';
      const topicMerged = manualOverAi ? content : mergeTopics(stored, content, ['topic', 'topicBy'], 'topicAt');
      // A newer Urdu edit is stamped with the server's clock, the one the translation queue
      // uses, so a device whose clock runs behind can't lose it to a later Google write.
      const urduEdited = URDU_FIELDS.some((key) => key in topicMerged && topicMerged[key] !== stored[key]);
      const urduStamped = urduEdited && (stored.urduAt === undefined || (topicMerged.urduAt ?? 0) > stored.urduAt)
        ? { ...topicMerged, urduAt: now } : topicMerged;
      // The server writes the Urdu itself, so an older device never wipes or overwrites it.
      const merged = mergeTopics(stored, urduStamped, URDU_FIELDS, 'urduAt');
      db.prepare('UPDATE cards SET deck_id = ?, data = ? WHERE id = ?').run(card.deckId, JSON.stringify(merged), card.id);
    } else if (!(from === 'given' && current === card.deckId)) {
      return false;
    }
  }
  saveProgress(db, userId, card.id, progress);
  return true;
}

function applyState(db, userId, changes, now) {
  const s = db.prepare('SELECT daily, log, time, settings, saved_at FROM user_state WHERE user_id = ?').get(userId);
  const pick = (key, column) => (changes[key] !== undefined ? JSON.stringify(changes[key]) : (s?.[column] ?? '{}'));
  // Answer counts from two devices are merged; neither one's count for a day is lost.
  // Only real days and whole counts are kept, on both sides, so hand-made data never sticks.
  const merge = (key) => (changes[key] !== undefined
    ? JSON.stringify(mergeCounts(cleanCounts(parse(s?.[key]), key, now), cleanCounts(changes[key], key, now)))
    : (s?.[key] ?? '{}'));
  db.prepare(`INSERT INTO user_state (user_id, daily, log, time, settings, saved_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET daily = excluded.daily, log = excluded.log, time = excluded.time,
      settings = excluded.settings, saved_at = excluded.saved_at`)
    .run(userId, merge('daily'), merge('log'), merge('time'), pick('settings', 'settings'),
      changes.savedAt !== undefined ? changes.savedAt : (s?.saved_at ?? 0));
}

/**
 * Apply one user's changes in a single transaction. Content changes are allowed only on
 * decks they own; on decks given to them only their own prefs and progress are saved.
 * Returns the ids that were refused.
 */
export function applyChanges(db, userId, changes, now) {
  const rejected = [];
  const each = (list, apply) => {
    for (const item of list ?? []) {
      const id = typeof item === 'object' && item !== null ? item.id : item;
      if (!validId(id) || !apply(item, id)) rejected.push(String(id));
    }
  };
  db.exec('BEGIN');
  try {
    each(changes.deletedCards, (_, id) => {
      const deckId = deckOfCard(db, id);
      if (deckId === undefined) return true; // already gone
      if (access(db, userId, deckId) !== 'own') return false;
      db.prepare('DELETE FROM cards WHERE id = ?').run(id);
      return true;
    });
    each(changes.deletedDecks, (_, id) => {
      const kind = access(db, userId, id);
      if (kind === null) return true; // already gone
      if (kind !== 'own') return false;
      db.prepare('DELETE FROM decks WHERE id = ?').run(id);
      return true;
    });
    // Counted after the deletions above, so decks and cards removed in this sync make room.
    const room = {};
    each(changes.decks, (deck) => applyDeck(db, userId, deck, now, room));
    each(changes.cards, (card) => applyCard(db, userId, card, now, room));
    // After the cards, so an answer to a card made in this same sync finds it.
    room.reviews = MAX_REVIEWS_PER_SYNC;
    each(changes.reviews, (review) => applyReview(db, userId, review, room));
    each(changes.deletedReviews, (_, id) => {
      db.prepare('DELETE FROM reviews WHERE id = ? AND user_id = ?').run(id, userId);
      return true;
    });
    if (['daily', 'log', 'time', 'settings', 'savedAt'].some((k) => changes[k] !== undefined)) applyState(db, userId, changes, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { rejected };
}
