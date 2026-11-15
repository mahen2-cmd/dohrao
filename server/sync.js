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
// Progress fields the app reads, which must be finite numbers. Others (from a newer version
// of the app) are kept as they come.
const PROGRESS_NUMBERS = ['stability', 'difficulty', 'due', 'scheduledDays', 'ease', 'left', 'reps', 'lapses', 'introduced', 'order', 'pulled'];

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

/** Whether one person's prefs for a deck hold choices the app has, at a sensible size. */
function validPrefs(p) {
  if (has(p, 'frontShows') && !FRONTS.includes(p.frontShows)) return false;
  if (has(p, 'urduScript') && !URDU_SCRIPTS.includes(p.urduScript)) return false;
  return bytes(p) <= MAX_PREFS;
}
const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 100;

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
  const s = db.prepare('SELECT daily, log, settings, saved_at FROM user_state WHERE user_id = ?').get(userId);
  return {
    version: 1,
    decks,
    cards,
    daily: parse(s?.daily),
    log: parse(s?.log),
    settings: parse(s?.settings),
    savedAt: s?.saved_at ?? 0,
  };
}

/** 'own', 'given' (actively assigned to the user), 'other', or null when no such deck. */
function access(db, userId, deckId) {
  const d = db.prepare('SELECT owner_id FROM decks WHERE id = ?').get(deckId);
  if (!d) return null;
  if (d.owner_id === userId) return 'own';
  const a = db.prepare('SELECT 1 FROM assignments WHERE deck_id = ? AND user_id = ? AND active = 1').get(deckId, userId);
  return a ? 'given' : 'other';
}

const deckOfCard = (db, cardId) => db.prepare('SELECT deck_id FROM cards WHERE id = ?').get(cardId)?.deck_id;

function savePrefs(db, userId, deckId, prefs) {
  db.prepare(`INSERT INTO deck_prefs (user_id, deck_id, data) VALUES (?, ?, ?)
    ON CONFLICT (user_id, deck_id) DO UPDATE SET data = excluded.data`).run(userId, deckId, JSON.stringify(prefs));
}

function saveProgress(db, userId, cardId, progress) {
  db.prepare(`INSERT INTO progress (user_id, card_id, data) VALUES (?, ?, ?)
    ON CONFLICT (user_id, card_id) DO UPDATE SET data = excluded.data`).run(userId, cardId, JSON.stringify(progress));
}

function applyDeck(db, userId, deck, now) {
  const clean = { ...deck };
  for (const key of VIEW_ONLY) delete clean[key];
  const [shared, prefs] = split(clean, DECK_SHARED);
  if (!validPrefs(prefs)) return false;
  const kind = access(db, userId, deck.id);
  if (kind === 'other') return false;
  // A given deck that no longer exists was deleted by its owner; a device still showing it must
  // not bring it back as the recipient's own.
  if (kind === null && deck.assigned) return false;
  if (kind === null) {
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

function applyCard(db, userId, card, now) {
  if (!validId(card.deckId)) return false;
  const [content, progress] = split(card, CARD_CONTENT);
  if (!validProgress(progress)) return false;
  const current = deckOfCard(db, card.id);
  const target = access(db, userId, card.deckId);
  if (current === undefined) {
    if (target !== 'own') return false;
    db.prepare('INSERT INTO cards (id, deck_id, data) VALUES (?, ?, ?)').run(card.id, card.deckId, JSON.stringify(content));
  } else {
    const from = access(db, userId, current);
    if (from === 'own' && target === 'own') {
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
  const s = db.prepare('SELECT daily, log, settings, saved_at FROM user_state WHERE user_id = ?').get(userId);
  const pick = (key, column) => (changes[key] !== undefined ? JSON.stringify(changes[key]) : (s?.[column] ?? '{}'));
  // Answer counts from two devices are merged; neither one's count for a day is lost.
  // Only real days and whole counts are kept, on both sides, so hand-made data never sticks.
  const merge = (key) => (changes[key] !== undefined
    ? JSON.stringify(mergeCounts(cleanCounts(parse(s?.[key]), key, now), cleanCounts(changes[key], key, now)))
    : (s?.[key] ?? '{}'));
  db.prepare(`INSERT INTO user_state (user_id, daily, log, settings, saved_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET daily = excluded.daily, log = excluded.log,
      settings = excluded.settings, saved_at = excluded.saved_at`)
    .run(userId, merge('daily'), merge('log'), pick('settings', 'settings'),
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
    each(changes.decks, (deck) => applyDeck(db, userId, deck, now));
    each(changes.cards, (card) => applyCard(db, userId, card, now));
    if (['daily', 'log', 'settings', 'savedAt'].some((k) => changes[k] !== undefined)) applyState(db, userId, changes, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { rejected };
}
