// Admin actions: listing people, and giving decks to them and taking them back.
import { newSchedule } from '../js/fsrs.js';

const parse = (text) => (text ? JSON.parse(text) : {});

export function listUsers(db) {
  return db.prepare('SELECT id, username, name, role, created FROM users ORDER BY name COLLATE NOCASE, rowid').all();
}

/** The owner's decks with card counts and everyone the deck has been given to. */
export function ownedDecks(db, ownerId) {
  const recipients = db.prepare(`
    SELECT a.user_id, u.name, a.active FROM assignments a JOIN users u ON u.id = a.user_id
    WHERE a.deck_id = ? ORDER BY a.assigned, u.name`);
  const count = db.prepare('SELECT COUNT(*) AS n FROM cards WHERE deck_id = ?');
  return db.prepare('SELECT id, data FROM decks WHERE owner_id = ? ORDER BY rowid').all(ownerId).map((d) => ({
    id: d.id,
    name: parse(d.data).name,
    cards: count.get(d.id).n,
    recipients: recipients.all(d.id).map((r) => ({ userId: r.user_id, name: r.name, active: r.active === 1 })),
  }));
}

/** Card ids in the owner's order: studied cards by age, then the reserve as arranged. */
function ownerOrder(db, ownerId, deckId) {
  const rows = db.prepare(`
    SELECT c.id, c.data, p.data AS progress FROM cards c
    LEFT JOIN progress p ON p.card_id = c.id AND p.user_id = ?
    WHERE c.deck_id = ? ORDER BY c.rowid`).all(ownerId, deckId)
    .map((r) => ({ id: r.id, created: parse(r.data).created ?? 0, ...parse(r.progress) }));
  const studied = rows.filter((c) => !c.reserved).sort((a, b) => a.created - b.created);
  const reserve = rows.filter((c) => c.reserved).sort(
    (a, b) => ((a.order ?? Infinity) - (b.order ?? Infinity)) || a.created - b.created);
  return [...studied, ...reserve].map((c) => c.id);
}

function giveTo(db, ownerId, deckId, userId, ids, now) {
  const row = db.prepare('SELECT active FROM assignments WHERE deck_id = ? AND user_id = ?').get(deckId, userId);
  if (row) {
    db.prepare('UPDATE assignments SET active = 1 WHERE deck_id = ? AND user_id = ?').run(deckId, userId);
    return;
  }
  db.prepare('INSERT INTO assignments (deck_id, user_id, active, assigned) VALUES (?, ?, 1, ?)').run(deckId, userId, now);
  const insert = db.prepare('INSERT OR IGNORE INTO progress (user_id, card_id, data) VALUES (?, ?, ?)');
  ids.forEach((id, i) => insert.run(userId, id, JSON.stringify({ ...newSchedule(now), reserved: true, order: i })));
  const prefs = db.prepare('SELECT data FROM deck_prefs WHERE user_id = ? AND deck_id = ?').get(ownerId, deckId);
  if (prefs) {
    db.prepare('INSERT OR IGNORE INTO deck_prefs (user_id, deck_id, data) VALUES (?, ?, ?)').run(userId, deckId, prefs.data);
  }
}

/** Give a deck to people. New people get every card on their reserve; returning people keep their progress. */
export function assignDeck(db, { ownerId, deckId, userIds }, now) {
  const own = db.prepare('SELECT 1 FROM decks WHERE id = ? AND owner_id = ?').get(deckId, ownerId);
  if (!own) throw new Error('not-owner');
  db.exec('BEGIN');
  try {
    const ids = ownerOrder(db, ownerId, deckId);
    for (const userId of userIds) {
      if (userId !== ownerId) giveTo(db, ownerId, deckId, userId, ids, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Take a deck back from people: it disappears for them, their progress stays. */
export function unassignDeck(db, { ownerId, deckId, userIds }) {
  const own = db.prepare('SELECT 1 FROM decks WHERE id = ? AND owner_id = ?').get(deckId, ownerId);
  if (!own) throw new Error('not-owner');
  const off = db.prepare('UPDATE assignments SET active = 0 WHERE deck_id = ? AND user_id = ?');
  db.exec('BEGIN');
  try {
    for (const userId of userIds) off.run(deckId, userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
