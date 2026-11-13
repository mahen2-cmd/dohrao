import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { buildView, applyChanges } from '../server/sync.js';
import { newSchedule } from '../js/fsrs.js';

const NOW = 1_700_000_000_000;

const deckOf = (over = {}) => ({
  id: 'd1', name: 'Spanish', created: NOW, frontLang: 'es', backLang: 'en', saveAudio: false,
  scheduler: 'fsrs', newPerDay: 20, retention: 0.9, ...over,
});
const cardOf = (id, over = {}) => ({
  id, deckId: 'd1', front: `front ${id}`, back: `back ${id}`, created: NOW, updated: NOW, ...newSchedule(NOW), ...over,
});

/** Users ana and ben; ana owns deck d1 with cards c1..c3. */
async function seed() {
  const db = openDb(':memory:');
  const ana = await createUser(db, { username: 'ana', name: 'Ana', password: 'password-ana' }, NOW);
  const ben = await createUser(db, { username: 'ben', name: 'Ben', password: 'password-ben' }, NOW);
  const deck = deckOf();
  const cards = [cardOf('c1'), cardOf('c2', { created: NOW + 1 }), cardOf('c3', { created: NOW + 2 })];
  assert.deepEqual(applyChanges(db, ana.id, { decks: [deck], cards }, NOW), { rejected: [] });
  return { db, ana, ben, deck, cards };
}

const give = (db, deckId, userId) =>
  db.prepare('INSERT INTO assignments (deck_id, user_id, active, assigned) VALUES (?, ?, 1, ?)').run(deckId, userId, NOW);

const byId = (list) => [...list].sort((a, b) => a.id.localeCompare(b.id));

test("a user's own decks and cards round-trip", async () => {
  const { db, ana, deck, cards } = await seed();
  applyChanges(db, ana.id, { savedAt: NOW + 5 }, NOW);
  const view = buildView(db, ana.id, NOW);
  assert.equal(view.version, 1);
  assert.deepEqual(view.decks, [deck]);
  assert.deepEqual(byId(view.cards), byId(cards));
  assert.equal(view.savedAt, NOW + 5);
});

test('an empty user gets empty state', async () => {
  const { db, ben } = await seed();
  assert.deepEqual(buildView(db, ben.id, NOW), {
    version: 1, decks: [], cards: [], daily: {}, log: {}, settings: {}, savedAt: 0,
  });
});

test("a user never sees another user's decks", async () => {
  const { db, ben } = await seed();
  applyChanges(db, ben.id, { decks: [deckOf({ id: 'b1', name: 'Mine' })] }, NOW);
  const view = buildView(db, ben.id, NOW);
  assert.deepEqual(view.decks.map((d) => d.id), ['b1']);
  assert.deepEqual(view.cards, []);
});

test('syncs from two devices touching different cards both persist', async () => {
  const { db, ana } = await seed();
  applyChanges(db, ana.id, { cards: [cardOf('c1', { due: NOW + 111, reps: 1 })] }, NOW);
  applyChanges(db, ana.id, { cards: [cardOf('c2', { back: 'edited', due: NOW + 222 })] }, NOW);
  const cards = Object.fromEntries(buildView(db, ana.id, NOW).cards.map((c) => [c.id, c]));
  assert.equal(cards.c1.due, NOW + 111);
  assert.equal(cards.c1.reps, 1);
  assert.equal(cards.c2.back, 'edited');
  assert.equal(cards.c2.due, NOW + 222);
  assert.deepEqual(cards.c3, cardOf('c3', { created: NOW + 2 }));
});

test('a recipient cannot edit, add or delete content in a given deck', async () => {
  const { db, ana, ben } = await seed();
  give(db, 'd1', ben.id);
  const before = buildView(db, ana.id, NOW);

  const given = buildView(db, ben.id, NOW);
  assert.deepEqual(given.decks.map((d) => [d.id, d.assigned, d.from]), [['d1', true, 'Ana']]);
  const c1 = given.cards.find((c) => c.id === 'c1');

  assert.deepEqual(applyChanges(db, ben.id, { cards: [{ ...c1, front: 'hacked', due: NOW + 999 }] }, NOW), { rejected: [] });
  const benC1 = buildView(db, ben.id, NOW).cards.find((c) => c.id === 'c1');
  assert.equal(benC1.front, 'front c1');
  assert.equal(benC1.due, NOW + 999);

  assert.deepEqual(applyChanges(db, ben.id, { cards: [cardOf('new1')] }, NOW), { rejected: ['new1'] });
  assert.deepEqual(applyChanges(db, ben.id, { deletedCards: ['c1'] }, NOW), { rejected: ['c1'] });
  assert.deepEqual(applyChanges(db, ben.id, { deletedDecks: ['d1'] }, NOW), { rejected: ['d1'] });

  const benDeck = buildView(db, ben.id, NOW).decks[0];
  assert.deepEqual(applyChanges(db, ben.id, { decks: [{ ...benDeck, name: 'Renamed', newPerDay: 5 }] }, NOW), { rejected: [] });
  const after = buildView(db, ben.id, NOW).decks[0];
  assert.equal(after.name, 'Spanish');
  assert.equal(after.newPerDay, 5);

  assert.deepEqual(buildView(db, ana.id, NOW), before);
});

test('a recipient cannot move a given card to another deck', async () => {
  const { db, ben } = await seed();
  give(db, 'd1', ben.id);
  applyChanges(db, ben.id, { decks: [deckOf({ id: 'b1' })] }, NOW);
  assert.deepEqual(applyChanges(db, ben.id, { cards: [cardOf('c1', { deckId: 'b1' })] }, NOW), { rejected: ['c1'] });
});

test('the view-only keys assigned and from are never stored', async () => {
  const { db, ana, ben } = await seed();
  give(db, 'd1', ben.id);
  const benDeck = buildView(db, ben.id, NOW).decks[0];
  applyChanges(db, ben.id, { decks: [{ ...benDeck, assigned: false, from: 'Mallory' }] }, NOW);
  const anaDeck = buildView(db, ana.id, NOW).decks[0];
  applyChanges(db, ana.id, { decks: [{ ...anaDeck, assigned: true, from: 'Mallory' }] }, NOW);

  for (const table of ['decks', 'deck_prefs']) {
    for (const { data } of db.prepare(`SELECT data FROM ${table}`).all()) {
      const stored = JSON.parse(data);
      assert.equal('assigned' in stored, false, `${table} stored assigned`);
      assert.equal('from' in stored, false, `${table} stored from`);
    }
  }
  assert.equal(buildView(db, ben.id, NOW).decks[0].from, 'Ana');
  assert.equal('assigned' in buildView(db, ana.id, NOW).decks[0], false);
});

test('a user cannot touch a deck they were not given', async () => {
  const { db, ana, ben } = await seed();
  const before = buildView(db, ana.id, NOW);
  const result = applyChanges(db, ben.id, {
    decks: [deckOf({ name: 'Stolen' })],
    cards: [cardOf('c1', { front: 'x' }), cardOf('c9')],
    deletedCards: ['c2'],
    deletedDecks: ['d1'],
  }, NOW);
  assert.deepEqual(result.rejected.sort(), ['c1', 'c2', 'c9', 'd1', 'd1']);
  assert.deepEqual(buildView(db, ana.id, NOW), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress WHERE user_id = ?').get(ben.id).n, 0);
});

test('a deck taken back is hidden and its changes rejected', async () => {
  const { db, ben } = await seed();
  give(db, 'd1', ben.id);
  db.prepare('UPDATE assignments SET active = 0').run();
  assert.deepEqual(buildView(db, ben.id, NOW).decks, []);
  assert.deepEqual(applyChanges(db, ben.id, { cards: [cardOf('c1')] }, NOW), { rejected: ['c1'] });
});

test('a given deck the admin deleted is not recreated by a recipient still showing it', async () => {
  const { db, ben } = await seed();
  give(db, 'd1', ben.id);
  const view = buildView(db, ben.id, NOW);
  db.prepare('DELETE FROM decks WHERE id = ?').run('d1');
  const result = applyChanges(db, ben.id, { decks: view.decks, cards: view.cards }, NOW);
  assert.deepEqual(result.rejected.sort(), ['c1', 'c2', 'c3', 'd1']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM decks').get().n, 0);
  assert.deepEqual(buildView(db, ben.id, NOW).decks, []);
});

test('ids that are not strings of 1-100 chars are rejected', async () => {
  const { db, ana } = await seed();
  const long = 'x'.repeat(101);
  const result = applyChanges(db, ana.id, {
    decks: [deckOf({ id: '' }), deckOf({ id: long })],
    cards: [cardOf(42)],
    deletedCards: [null],
  }, NOW);
  assert.deepEqual(result.rejected, ['null', '', long, '42']);
  assert.equal(buildView(db, ana.id, NOW).decks.length, 1);
});

test('owners can move, delete cards and delete decks', async () => {
  const { db, ana } = await seed();
  applyChanges(db, ana.id, { decks: [deckOf({ id: 'd2', name: 'Other' })], cards: [cardOf('c1', { deckId: 'd2' })] }, NOW);
  assert.equal(buildView(db, ana.id, NOW).cards.find((c) => c.id === 'c1').deckId, 'd2');
  assert.deepEqual(applyChanges(db, ana.id, { deletedCards: ['c2'], deletedDecks: ['d2'] }, NOW), { rejected: [] });
  assert.deepEqual(buildView(db, ana.id, NOW).cards.map((c) => c.id), ['c3']);
});

test('cards added later reach recipients at the end of their reserve', async () => {
  const { db, ana, ben } = await seed();
  give(db, 'd1', ben.id);
  const first = buildView(db, ben.id, NOW).cards;
  assert.deepEqual(first.map((c) => [c.id, c.reserved, c.order]), [['c1', true, 0], ['c2', true, 1], ['c3', true, 2]]);
  assert.equal(first[1].due, NOW + 1);
  applyChanges(db, ben.id, { cards: first }, NOW);
  applyChanges(db, ana.id, { cards: [cardOf('c5', { created: NOW + 5 }), cardOf('c4', { created: NOW + 4 })] }, NOW);
  const later = buildView(db, ben.id, NOW).cards.filter((c) => c.id === 'c4' || c.id === 'c5');
  assert.deepEqual(later.map((c) => [c.id, c.order]).sort(), [['c4', 3], ['c5', 4]]);
});

test('deleting something already gone is done, not rejected', async () => {
  const { db, ana } = await seed();
  const gone = { deletedCards: ['c1'], deletedDecks: ['d1'] };
  assert.deepEqual(applyChanges(db, ana.id, gone, NOW), { rejected: [] });
  assert.deepEqual(applyChanges(db, ana.id, gone, NOW), { rejected: [] });
  assert.deepEqual(applyChanges(db, ana.id, { deletedCards: ['never'], deletedDecks: ['never'] }, NOW), { rejected: [] });
});

test('daily, log and settings are per user', async () => {
  const { db, ana, ben } = await seed();
  applyChanges(db, ana.id, { daily: { a: 1 }, log: { x: [1] }, settings: { theme: 'dark' }, savedAt: NOW }, NOW);
  applyChanges(db, ben.id, { settings: { theme: 'light' } }, NOW);
  applyChanges(db, ana.id, { log: { x: [1, 2] } }, NOW);
  const a = buildView(db, ana.id, NOW);
  const b = buildView(db, ben.id, NOW);
  assert.deepEqual([a.daily, a.log, a.settings, a.savedAt], [{ a: 1 }, { x: [1, 2] }, { theme: 'dark' }, NOW]);
  assert.deepEqual([b.daily, b.log, b.settings, b.savedAt], [{}, {}, { theme: 'light' }, 0]);
});

test('daily and log from two devices are merged, keeping the larger count', async () => {
  const { db, ana } = await seed();
  applyChanges(db, ana.id, { daily: { '2026-01-01': 5, '2026-01-02': 3 }, log: { '2026-01-02': { d1: [3, 0, 0, 0] } } }, NOW);
  // The laptop answered twice on the 2nd, and once on the 3rd, without knowing the phone's counts.
  applyChanges(db, ana.id, { daily: { '2026-01-02': 2, '2026-01-03': 1 }, log: { '2026-01-02': { d1: [0, 2, 0, 0], d2: [1] } } }, NOW);
  const view = buildView(db, ana.id, NOW);
  assert.deepEqual(view.daily, { '2026-01-01': 5, '2026-01-02': 3, '2026-01-03': 1 });
  assert.deepEqual(view.log, { '2026-01-02': { d1: [3, 2, 0, 0], d2: [1] } });
});

const setStored = (db, table, id, patch) => {
  const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
  db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify({ ...JSON.parse(row.data), ...patch }), id);
};

test('topic fields are shared with people the deck is given to', async () => {
  const { db, ana, ben, deck } = await seed();
  const groups = [{ id: 'g1', name: 'Verbs' }];
  const topics = [{ id: 't1', name: 'Ser', groupId: 'g1', by: 'admin' }];
  applyChanges(db, ana.id, { decks: [{ ...deck, groups, topics, topicsAt: NOW + 1 }],
    cards: [cardOf('c1', { topic: 't1', topicBy: 'manual', topicAt: NOW + 1 })] }, NOW);
  give(db, 'd1', ben.id);
  const view = buildView(db, ben.id, NOW);
  assert.deepEqual(view.decks[0].topics, topics);
  assert.deepEqual(view.decks[0].groups, groups);
  assert.equal(view.cards.find((c) => c.id === 'c1').topic, 't1');
});

test('stale card content keeps the newer topic', async () => {
  const { db, ana } = await seed();
  setStored(db, 'cards', 'c1', { topic: 't9', topicBy: 'ai', topicAt: NOW + 50 });
  applyChanges(db, ana.id, { cards: [cardOf('c1', { reps: 1 })] }, NOW);   // an answer from an old copy
  const c1 = buildView(db, ana.id, NOW).cards.find((c) => c.id === 'c1');
  assert.equal(c1.topic, 't9');
  assert.equal(c1.topicBy, 'ai');
  assert.equal(c1.topicAt, NOW + 50);
  assert.equal(c1.reps, 1);
});

test('a newer manual topic wins over the stored one', async () => {
  const { db, ana } = await seed();
  setStored(db, 'cards', 'c1', { topic: 't9', topicBy: 'ai', topicAt: NOW + 50 });
  applyChanges(db, ana.id, { cards: [cardOf('c1', { topic: 't2', topicBy: 'manual', topicAt: NOW + 60 })] }, NOW);
  const c1 = buildView(db, ana.id, NOW).cards.find((c) => c.id === 'c1');
  assert.equal(c1.topic, 't2');
  assert.equal(c1.topicBy, 'manual');
  assert.equal(c1.topicAt, NOW + 60);
});

test('stale deck content keeps the newer groups and topics', async () => {
  const { db, ana, deck } = await seed();
  const groups = [{ id: 'g9', name: 'Nouns' }];
  const topics = [{ id: 't9', name: 'Food', groupId: 'g9', by: 'ai' }];
  setStored(db, 'decks', 'd1', { groups, topics, topicsAt: NOW + 50 });
  applyChanges(db, ana.id, { decks: [{ ...deck, name: 'Spanish 2' }] }, NOW);   // an old copy renames the deck
  const d = buildView(db, ana.id, NOW).decks[0];
  assert.equal(d.name, 'Spanish 2');
  assert.deepEqual(d.groups, groups);
  assert.deepEqual(d.topics, topics);
  assert.equal(d.topicsAt, NOW + 50);
});

test('a newer deck topic list wins for shared items and keeps the older side\'s others', async () => {
  const { db, ana, deck } = await seed();
  setStored(db, 'decks', 'd1', { groups: [{ id: 'g9', name: 'Old' }], topics: [{ id: 't2', name: 'Was', groupId: null, by: 'admin' }], topicsAt: NOW + 50 });
  applyChanges(db, ana.id, { decks: [{ ...deck, topics: [{ id: 't2', name: 'New', groupId: null, by: 'admin' }], topicsAt: NOW + 60 }] }, NOW);
  const d = buildView(db, ana.id, NOW).decks[0];
  assert.deepEqual(d.topics.map((t) => t.name), ['New']);
  assert.deepEqual(d.groups, [{ id: 'g9', name: 'Old' }]);   // not deleted by the newer side, so kept
  assert.equal(d.topicsAt, NOW + 60);
});

const T = (id, name, over = {}) => ({ id, name, groupId: null, by: 'admin', ...over });

test('a rename from a client keeps a topic the server added meanwhile', async () => {
  const { db, ana, deck } = await seed();
  setStored(db, 'decks', 'd1', { topics: [T('t1', 'Ser'), T('t9', 'Food', { by: 'ai' })], topicsAt: NOW + 50 });
  applyChanges(db, ana.id, { decks: [{ ...deck, topics: [T('t1', 'Ser and estar')], topicsAt: NOW + 60 }] }, NOW);
  const d = buildView(db, ana.id, NOW).decks[0];
  assert.deepEqual(byId(d.topics).map((t) => [t.id, t.name]), [['t1', 'Ser and estar'], ['t9', 'Food']]);
  assert.equal(d.topicsAt, NOW + 60);
});

test('a delete from a client removes only that topic', async () => {
  const { db, ana, deck } = await seed();
  setStored(db, 'decks', 'd1', { topics: [T('t1', 'Ser'), T('t2', 'Ir'), T('t9', 'Food', { by: 'ai' })], topicsAt: NOW + 50 });
  applyChanges(db, ana.id, { decks: [{ ...deck, topics: [T('t1', 'Ser')], deletedTopicIds: ['t2'], topicsAt: NOW + 60 }] }, NOW);
  const d = buildView(db, ana.id, NOW).decks[0];
  assert.deepEqual(byId(d.topics).map((t) => t.id), ['t1', 't9']);
  assert.deepEqual(d.deletedTopicIds, ['t2']);
});

test('a stale client without a new topic does not remove it', async () => {
  const { db, ana, deck } = await seed();
  setStored(db, 'decks', 'd1', { topics: [T('t1', 'Ser'), T('t9', 'Food', { by: 'ai' })], topicsAt: NOW + 50 });
  applyChanges(db, ana.id, { decks: [{ ...deck, topics: [T('t1', 'Old name')], topicsAt: NOW + 10 }] }, NOW);
  const d = buildView(db, ana.id, NOW).decks[0];
  assert.deepEqual(byId(d.topics).map((t) => [t.id, t.name]), [['t1', 'Ser'], ['t9', 'Food']]);
  assert.equal(d.topicsAt, NOW + 50);
});

test('a group deleted on either side stays deleted, and tombstones are kept from both', async () => {
  const { db, ana, deck } = await seed();
  setStored(db, 'decks', 'd1', {
    groups: [{ id: 'g1', name: 'Verbs' }], topics: [T('t1', 'Ser', { groupId: 'g1' })],
    deletedTopicIds: ['t7'], topicsAt: NOW + 50,
  });
  // An older copy still has t7, and deleted g1 itself (but its stamp is older).
  applyChanges(db, ana.id, { decks: [{ ...deck, groups: [], topics: [T('t1', 'Ser'), T('t7', 'Gone')], deletedGroupIds: ['g1'], topicsAt: NOW + 10 }] }, NOW);
  const d = buildView(db, ana.id, NOW).decks[0];
  assert.deepEqual(d.groups, []);
  assert.deepEqual(d.topics, [T('t1', 'Ser')]);   // the newer t1, out of the deleted group
  assert.deepEqual(d.deletedGroupIds, ['g1']);
  assert.deepEqual(d.deletedTopicIds, ['t7']);
});

test('a recipient cannot change topics of a given deck', async () => {
  const { db, ana, ben, deck } = await seed();
  const topics = [{ id: 't1', name: 'Ser', groupId: null, by: 'admin' }];
  applyChanges(db, ana.id, { decks: [{ ...deck, topics, topicsAt: NOW + 1 }],
    cards: [cardOf('c1', { topic: 't1', topicBy: 'manual', topicAt: NOW + 1 })] }, NOW);
  give(db, 'd1', ben.id);
  const before = buildView(db, ana.id, NOW);
  const rejected = applyChanges(db, ben.id, {
    decks: [{ ...deck, assigned: true, topics: [{ id: 't2', name: 'Mine', groupId: null, by: 'admin' }], topicsAt: NOW + 99 }],
    cards: [cardOf('c1', { topic: 't2', topicBy: 'manual', topicAt: NOW + 99 })],
  }, NOW);
  assert.deepEqual(rejected, { rejected: [] });   // ignored, as with other content edits
  assert.deepEqual(buildView(db, ana.id, NOW), before);
});
