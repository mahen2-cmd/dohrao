// Jobs that put a deck's cards into topics: sorting with the AI service, proposing topics,
// and approving a proposal. Scheduling data (progress rows) is never touched here.
import { randomUUID } from 'node:crypto';
import { addTombstone } from './fields.js';

const parse = (text) => (text ? JSON.parse(text) : {});
const NAME_MAX = 60;
const PROPOSE_MAX = 300;

/** The deck row, only when `userId` owns it; otherwise null. */
export function ownedDeck(db, userId, deckId) {
  return db.prepare('SELECT id, data FROM decks WHERE id = ? AND owner_id = ?').get(deckId, userId) ?? null;
}

const deckData = (db, deckId) => parse(db.prepare('SELECT data FROM decks WHERE id = ?').get(deckId)?.data);
const saveDeck = (db, deckId, deck) =>
  db.prepare('UPDATE decks SET data = ? WHERE id = ?').run(JSON.stringify(deck), deckId);

/** Cards with no topic that nobody placed by hand, in the deck's order. */
export function unsortedCards(db, deckId) {
  return db.prepare('SELECT id, data FROM cards WHERE deck_id = ? ORDER BY rowid').all(deckId)
    .map((r) => ({ id: r.id, ...parse(r.data) }))
    .filter((c) => !c.topic && c.topicBy !== 'manual')
    .map((c) => ({ id: c.id, front: c.front ?? '', back: c.back ?? '' }));
}

/** A topicsAt that is never behind what is stored, so these writes always win a merge. */
const stamp = (deck, now) => Math.max(now, (deck.topicsAt ?? 0) + 1);

/** Put loose topics into the deck's groups (only when it has groups). */
async function groupLooseTopics(db, sorter, deckId, now) {
  const deck = deckData(db, deckId);
  const loose = (deck.topics ?? []).filter((t) => !t.groupId);
  if (!(deck.groups ?? []).length || !loose.length) return;
  const answer = await sorter.groupTopics({
    deckName: deck.name,
    groups: deck.groups,
    topics: loose.map((t) => ({ id: t.id, name: t.name })),
  });
  // The deck may have changed during the call: re-read it and apply only what still fits.
  const fresh = deckData(db, deckId);
  const groupIds = new Set((fresh.groups ?? []).map((g) => g.id));
  const groupOf = new Map(answer.map((a) => [a.id, a.groupId]));
  let changed = false;
  for (const t of fresh.topics ?? []) {
    if (!t.groupId && groupIds.has(groupOf.get(t.id))) {
      t.groupId = groupOf.get(t.id);
      changed = true;
    }
  }
  if (!changed) return;
  fresh.topicsAt = stamp(fresh, now);
  saveDeck(db, deckId, fresh);
}

/**
 * Place the deck's unsorted cards in topics, `batch` cards per request. Each placement is
 * written only if the card is still unplaced, so a hand placement made meanwhile wins.
 */
export async function sortDeck(db, sorter, deckId, now, { batch = 100 } = {}) {
  await groupLooseTopics(db, sorter, deckId, now);
  const pending = unsortedCards(db, deckId);
  const read = db.prepare('SELECT data FROM cards WHERE id = ? AND deck_id = ?');
  const write = db.prepare('UPDATE cards SET data = ? WHERE id = ?');
  let sorted = 0;
  let created = 0;
  for (let i = 0; i < pending.length; i += batch) {
    const deck = deckData(db, deckId);
    const answer = await sorter.placeCards({
      deckName: deck.name,
      groups: deck.groups ?? [],
      topics: deck.topics ?? [],
      cards: pending.slice(i, i + batch),
    });
    // The deck may have changed while the service was thinking, so read it again.
    const fresh = deckData(db, deckId);
    const known = new Set((fresh.topics ?? []).map((t) => t.id));
    const used = new Set(answer.placements.map((p) => p.topic));
    const ids = new Map();
    const added = [];
    for (const t of answer.newTopics) {
      if (!used.has(t.ref)) continue;
      const id = randomUUID();
      ids.set(t.ref, id);
      added.push({ id, name: t.name, groupId: t.groupId ?? null, by: 'ai' });
    }
    const placedIn = new Set();
    let placed = 0;
    for (const p of answer.placements) {
      const topic = ids.get(p.topic) ?? p.topic;
      const row = read.get(p.id, deckId);
      if (!row || (!ids.has(p.topic) && !known.has(topic))) continue;
      const card = parse(row.data);
      if (card.topic || card.topicBy === 'manual') continue;
      write.run(JSON.stringify({ ...card, topic, topicBy: 'ai', topicAt: now }), p.id);
      placedIn.add(topic);
      placed++;
    }
    if (added.length) {
      // A new topic nobody ended up in is not kept.
      const kept = added.filter((t) => placedIn.has(t.id));
      if (kept.length) {
        fresh.topics = [...(fresh.topics ?? []), ...kept];
        fresh.topicsAt = stamp(fresh, now);
        saveDeck(db, deckId, fresh);
        created += kept.length;
      }
    }
    sorted += placed;
  }
  return { sorted, created, remaining: unsortedCards(db, deckId).length };
}

/** Ask for groups and topics for the deck from up to 300 cards, and keep the answer. */
export async function proposeForDeck(db, sorter, deckId, now) {
  const rows = db.prepare('SELECT id, data FROM cards WHERE deck_id = ? ORDER BY rowid').all(deckId);
  const picks = rows.length <= PROPOSE_MAX
    ? rows
    : Array.from({ length: PROPOSE_MAX }, (_, i) => rows[Math.floor((i * rows.length) / PROPOSE_MAX)]);
  const answer = await sorter.proposeTopics({
    deckName: deckData(db, deckId).name,
    cards: picks.map((r) => ({ id: r.id, front: parse(r.data).front ?? '', back: parse(r.data).back ?? '' })),
  });
  const proposal = { groups: answer.groups, topics: answer.topics, at: now };
  db.prepare(`INSERT INTO topic_proposals (deck_id, data) VALUES (?, ?)
    ON CONFLICT (deck_id) DO UPDATE SET data = excluded.data`).run(deckId, JSON.stringify(proposal));
  return proposal;
}

const goodName = (x) => typeof x?.name === 'string' && x.name.trim() !== '' && x.name.trim().length <= NAME_MAX;

/**
 * Make the (possibly edited) proposal the deck's groups and topics, with new ids. Cards that
 * were in a topic that is now gone, and were not placed by hand, become unsorted again.
 * Throws `Error('bad-request')` for bad names or unknown groups.
 */
export function approveProposal(db, deckId, { groups, topics }, now) {
  const bad = () => new Error('bad-request');
  if (!Array.isArray(groups) || !Array.isArray(topics)) throw bad();
  if (!groups.every(goodName) || !topics.every(goodName)) throw bad();
  const groupIds = new Map(groups.map((g) => [g.id, randomUUID()]));
  if (topics.some((t) => t.groupId != null && !groupIds.has(t.groupId))) throw bad();

  const deck = deckData(db, deckId);
  // The old groups and topics are deleted; remember them so a device that still has them
  // cannot bring them back.
  for (const g of deck.groups ?? []) deck.deletedGroupIds = addTombstone(deck.deletedGroupIds, g.id);
  for (const t of deck.topics ?? []) deck.deletedTopicIds = addTombstone(deck.deletedTopicIds, t.id);
  deck.groups = groups.map((g) => ({ id: groupIds.get(g.id), name: g.name.trim() }));
  deck.topics = topics.map((t) => ({
    id: randomUUID(), name: t.name.trim(), groupId: t.groupId == null ? null : groupIds.get(t.groupId), by: 'admin',
  }));
  deck.topicsAt = stamp(deck, now);
  const live = new Set(deck.topics.map((t) => t.id));

  db.exec('BEGIN');
  try {
    saveDeck(db, deckId, deck);
    const write = db.prepare('UPDATE cards SET data = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, data FROM cards WHERE deck_id = ?').all(deckId)) {
      const { topic, topicBy, ...card } = parse(r.data);
      if (!topic || live.has(topic) || topicBy === 'manual') continue;
      write.run(JSON.stringify({ ...card, topicAt: now }), r.id);
    }
    db.prepare('DELETE FROM topic_proposals WHERE deck_id = ?').run(deckId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
