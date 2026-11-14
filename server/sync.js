// Each user's view of the store, and applying their changes under ownership rules.
import { DECK_SHARED, CARD_CONTENT, split, mergeTopics, mergeDeckTopics } from './fields.js';
import { newSchedule } from '../js/fsrs.js';
import { URDU_FIELDS } from '../js/urdu.js';
import { mergeCounts } from '../js/counts.js';

// Keys the view adds to given decks; never stored.
const VIEW_ONLY = ['assigned', 'from'];

const parse = (text) => (text ? JSON.parse(text) : {});
const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 100;

function ownDecks(db, userId) {
  return db.prepare('SELECT id, data FROM decks WHERE owner_id = ? ORDER BY rowid').all(userId);
}

function givenDecks(db, userId) {
  return db.prepare(`
    SELECT d.id, d.data, u.name AS owner FROM assignments a
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
  const maxOrder = orders.length ? Math.max(...orders) : -1;
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
    cards.push(...cardsFor(db, userId, d.id, false));
  }
  for (const d of givenDecks(db, userId)) {
    decks.push({ id: d.id, ...parse(d.data), ...prefsOf(d.id), assigned: true, from: d.owner });
    cards.push(...cardsFor(db, userId, d.id, true));
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
  // clock is never trusted for it.
  const storedPrefs = parse(db.prepare('SELECT data FROM deck_prefs WHERE user_id = ? AND deck_id = ?').get(userId, deck.id)?.data);
  if (prefs.frontShows !== storedPrefs.frontShows) prefs.frontShowsAt = now;
  else if (storedPrefs.frontShowsAt !== undefined) prefs.frontShowsAt = storedPrefs.frontShowsAt;
  else delete prefs.frontShowsAt;
  savePrefs(db, userId, deck.id, prefs);
  return true;
}

function applyCard(db, userId, card, now) {
  if (!validId(card.deckId)) return false;
  const [content, progress] = split(card, CARD_CONTENT);
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

function applyState(db, userId, changes) {
  const s = db.prepare('SELECT daily, log, settings, saved_at FROM user_state WHERE user_id = ?').get(userId);
  const pick = (key, column) => (changes[key] !== undefined ? JSON.stringify(changes[key]) : (s?.[column] ?? '{}'));
  // Answer counts from two devices are merged; neither one's count for a day is lost.
  const merge = (key) => (changes[key] !== undefined ? JSON.stringify(mergeCounts(parse(s?.[key]), changes[key])) : (s?.[key] ?? '{}'));
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
    if (['daily', 'log', 'settings', 'savedAt'].some((k) => changes[k] !== undefined)) applyState(db, userId, changes);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { rejected };
}
