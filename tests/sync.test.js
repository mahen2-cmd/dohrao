import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { buildView, applyChanges, reviewsOf } from '../server/sync.js';
import { newSchedule } from '../js/fsrs.js';
import { setUrduSwitch } from '../server/admin.js';
import { frontShows } from '../js/urdu.js';

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
    version: 1, decks: [], cards: [], daily: {}, log: {}, time: {}, settings: {}, savedAt: 0,
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
  applyChanges(db, ana.id, { daily: { '2023-11-01': 1 }, log: { '2023-11-01': { d1: [1] } }, settings: { theme: 'dark' }, savedAt: NOW }, NOW);
  applyChanges(db, ben.id, { settings: { theme: 'light' } }, NOW);
  applyChanges(db, ana.id, { log: { '2023-11-01': { d1: [1, 2] } } }, NOW);
  const a = buildView(db, ana.id, NOW);
  const b = buildView(db, ben.id, NOW);
  assert.deepEqual([a.daily, a.log, a.settings, a.savedAt], [{ '2023-11-01': 1 }, { '2023-11-01': { d1: [1, 2] } }, { theme: 'dark' }, NOW]);
  assert.deepEqual([b.daily, b.log, b.settings, b.savedAt], [{}, {}, { theme: 'light' }, 0]);
});

test('daily and log from two devices are merged, keeping the larger count', async () => {
  const { db, ana } = await seed();
  applyChanges(db, ana.id, { daily: { '2023-01-01': 5, '2023-01-02': 3 }, log: { '2023-01-02': { d1: [3, 0, 0, 0] } } }, NOW);
  // The laptop answered twice on the 2nd, and once on the 3rd, without knowing the phone's counts.
  applyChanges(db, ana.id, { daily: { '2023-01-02': 2, '2023-01-03': 1 }, log: { '2023-01-02': { d1: [0, 2, 0, 0], d2: [1] } } }, NOW);
  const view = buildView(db, ana.id, NOW);
  assert.deepEqual(view.daily, { '2023-01-01': 5, '2023-01-02': 3, '2023-01-03': 1 });
  assert.deepEqual(view.log, { '2023-01-02': { d1: [3, 2, 0, 0], d2: [1] } });
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

test('an offline manual placement beats a later AI placement', async () => {
  const { db, ana } = await seed();
  setStored(db, 'cards', 'c1', { topic: 't9', topicBy: 'ai', topicAt: NOW + 50 });
  applyChanges(db, ana.id, { cards: [cardOf('c1', { topic: 't2', topicBy: 'manual', topicAt: NOW + 10 })] }, NOW);
  const c1 = buildView(db, ana.id, NOW).cards.find((c) => c.id === 'c1');
  assert.equal(c1.topic, 't2');
  assert.equal(c1.topicBy, 'manual');
  assert.equal(c1.topicAt, NOW + 10);
});

test('an older manual placement does not beat a newer file placement', async () => {
  const { db, ana } = await seed();
  setStored(db, 'cards', 'c1', { topic: 't9', topicBy: 'file', topicAt: NOW + 50 });
  applyChanges(db, ana.id, { cards: [cardOf('c1', { topic: 't2', topicBy: 'manual', topicAt: NOW + 10 })] }, NOW);
  const c1 = buildView(db, ana.id, NOW).cards.find((c) => c.id === 'c1');
  assert.equal(c1.topic, 't9');
  assert.equal(c1.topicBy, 'file');
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

const storedCard = (db, id) => JSON.parse(db.prepare('SELECT data FROM cards WHERE id = ?').get(id).data);

test('a stale card without Urdu keeps the stored Urdu', async () => {
  const { db, ana } = await seed();
  const data = { ...storedCard(db, 'c1'), urdu: 'x', urduOf: 'back c1', urduBy: 'google', urduAt: NOW + 5 };
  db.prepare('UPDATE cards SET data = ? WHERE id = ?').run(JSON.stringify(data), 'c1');
  applyChanges(db, ana.id, { cards: [cardOf('c1', { front: 'new front' })] }, NOW);
  const stored = storedCard(db, 'c1');
  assert.equal(stored.urdu, 'x');
  assert.equal(stored.front, 'new front');
});

test('newer Urdu from the editor wins, older loses', async () => {
  const { db, ana } = await seed();
  applyChanges(db, ana.id, { cards: [cardOf('c1', { urdu: 'manual', urduBy: 'manual', urduAt: NOW + 9 })] }, NOW + 10);
  assert.equal(storedCard(db, 'c1').urdu, 'manual');
  applyChanges(db, ana.id, { cards: [cardOf('c1', { urdu: 'old', urduAt: NOW + 1 })] }, NOW + 20);
  assert.equal(storedCard(db, 'c1').urdu, 'manual');
});

test("a newer Urdu edit is stamped with the server's clock, so a slow device's edit still orders after Google", async () => {
  const { db, ana } = await seed();
  const google = { ...storedCard(db, 'c1'), urdu: 'google', urduRoman: 'g', urduOf: 'back c1', urduBy: 'google', urduAt: NOW + 1000 };
  db.prepare('UPDATE cards SET data = ? WHERE id = ?').run(JSON.stringify(google), 'c1');
  // The device's clock is behind the server's: its edit says NOW + 1500, the server's time is NOW + 2000.
  const edit = { urdu: 'hand', urduRoman: 'h', urduOf: 'back c1', urduBy: 'manual', urduAt: NOW + 1500 };
  applyChanges(db, ana.id, { cards: [cardOf('c1', edit)] }, NOW + 2000);
  assert.equal(storedCard(db, 'c1').urdu, 'hand');
  assert.equal(storedCard(db, 'c1').urduAt, NOW + 2000);
  // A Google write the server made at NOW + 1900, before the edit arrived, comes back from another
  // device. It is older than the edit by the server's clock, so it loses.
  const later = { urdu: 'google 2', urduRoman: 'g2', urduOf: 'back c1', urduBy: 'google', urduAt: NOW + 1900 };
  applyChanges(db, ana.id, { cards: [cardOf('c1', later)] }, NOW + 2100);
  assert.equal(storedCard(db, 'c1').urdu, 'hand');
  assert.equal(storedCard(db, 'c1').urduAt, NOW + 2000);
});

test('frontShowsAt is stamped by the server when frontShows changes', async () => {
  const { db, ana } = await seed();
  const changed = deckOf({ frontShows: 'ur', frontShowsAt: 1 });
  applyChanges(db, ana.id, { decks: [changed] }, NOW + 100);
  assert.equal(buildView(db, ana.id, NOW).decks[0].frontShowsAt, NOW + 100);
  applyChanges(db, ana.id, { decks: [changed] }, NOW + 200);
  assert.equal(buildView(db, ana.id, NOW).decks[0].frontShowsAt, NOW + 100);
});

test('picking the stored front choice again after a newer admin switch wins over the switch', async () => {
  const { db, ana, ben } = await seed();
  give(db, 'd1', ben.id);
  const viewDeck = () => buildView(db, ben.id, NOW).decks[0];
  applyChanges(db, ben.id, { decks: [{ ...viewDeck(), frontShows: 'en' }] }, NOW + 100);
  setUrduSwitch(db, { ownerId: ana.id, deckId: 'd1', userId: ben.id, on: true }, NOW + 200);
  assert.equal(frontShows(viewDeck()), 'ur');
  // The person picks English again: the value is unchanged, but the choice is newer than the switch.
  const seen = viewDeck();
  const chosenAt = Math.max(NOW + 150, seen.urduSwitchAt + 1);
  applyChanges(db, ben.id, { decks: [{ ...seen, frontShows: 'en', frontShowsAt: chosenAt }] }, NOW + 300);
  assert.equal(viewDeck().frontShowsAt, NOW + 300);
  assert.equal(frontShows(viewDeck()), 'en');
});

test('a device echoing the stored frontShowsAt does not re-stamp it', async () => {
  const { db, ana } = await seed();
  applyChanges(db, ana.id, { decks: [deckOf({ frontShows: 'ur', frontShowsAt: NOW + 50 })] }, NOW + 100);
  const seen = buildView(db, ana.id, NOW).decks[0];
  assert.equal(seen.frontShowsAt, NOW + 100);
  applyChanges(db, ana.id, { decks: [{ ...seen, newPerDay: 5 }] }, NOW + 200);
  assert.equal(buildView(db, ana.id, NOW).decks[0].frontShowsAt, NOW + 100);
  // A stale device still holding its own older stamp doesn't re-stamp either.
  applyChanges(db, ana.id, { decks: [{ ...seen, frontShowsAt: NOW + 50 }] }, NOW + 300);
  assert.equal(buildView(db, ana.id, NOW).decks[0].frontShowsAt, NOW + 100);
});

test('answer counts keep only real days up to tomorrow, with whole counts of zero or more', async () => {
  const { db, ana } = await seed();
  const { dayKey } = await import('../js/progress.js');
  const DAY = 86_400_000;
  const today = dayKey(NOW);
  const yesterday = dayKey(NOW - DAY);
  const tomorrow = dayKey(NOW + DAY);
  const later = dayKey(NOW + 5 * DAY);
  const daily = { [today]: 4, [yesterday]: -500, [tomorrow]: 2, [later]: 7, 'invalid-date': 42, '9999-99-99': 100, '2023-02-30': 9, '2023-01-01': 2.5 };
  const log = {
    [today]: { d1: [1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0], d2: [1, -3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], d3: 'x' },
    'invalid-date': { d1: [9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  };
  applyChanges(db, ana.id, { daily, log, savedAt: NOW }, NOW);
  const view = buildView(db, ana.id, NOW);
  assert.deepEqual(view.daily, { [today]: 4, [tomorrow]: 2 });
  assert.deepEqual(view.log, { [today]: { d1: [1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0] } });
});

test('bad answer counts already stored are dropped at the next save', async () => {
  const { db, ana } = await seed();
  const { dayKey } = await import('../js/progress.js');
  const today = dayKey(NOW);
  db.prepare(`INSERT INTO user_state (user_id, daily, log, settings, saved_at) VALUES (?, ?, '{}', '{}', 0)`)
    .run(ana.id, JSON.stringify({ [today]: 1, 'invalid-date': 42 }));
  applyChanges(db, ana.id, { daily: { [today]: 3 }, savedAt: NOW }, NOW);
  assert.deepEqual(buildView(db, ana.id, NOW).daily, { [today]: 3 });
});

test('card progress with a value of the wrong type is rejected, and nothing of it is saved', async () => {
  const { db, ana } = await seed();
  const bad = [
    ['c1', { due: 'not-a-time' }],
    ['c2', { state: 9 }],
    ['c3', { state: 1.5 }],
    ['n1', { stability: null }],
    ['n2', { reps: '3' }],
    ['n3', { lastReview: 'yesterday' }],
    ['n4', { reserved: 'yes' }],
    ['n5', { order: [] }],
    ['n6', { pulled: {} }],
    ['n7', { stability7: 'x' }],
    ['n8', { stabilityFast7: null }],
    ['n9', { difficulty7: {} }],
  ];
  const { rejected } = applyChanges(db, ana.id, { cards: bad.map(([id, over]) => cardOf(id, { ...over, front: 'changed' })) }, NOW);
  assert.deepEqual(rejected, bad.map(([id]) => id));
  const view = buildView(db, ana.id, NOW);
  assert.deepEqual(view.cards.map((c) => c.front).sort(), ['front c1', 'front c2', 'front c3']);
  assert.equal(view.cards[0].due, NOW);
});

test('valid card progress still saves, with null lastReview, a reserve flag and keys from newer versions', async () => {
  const { db, ana } = await seed();
  const card = cardOf('c1', { state: 2, due: NOW + 5, lastReview: NOW - 1, reserved: true, order: 3, pulled: NOW, introduced: NOW, stability7: 3.9, stabilityFast7: 3.1, difficulty7: 3.5, someFutureField: { any: 'thing' } });
  const fresh = cardOf('c9', { lastReview: null });
  assert.deepEqual(applyChanges(db, ana.id, { cards: [card, fresh] }, NOW), { rejected: [] });
  const saved = buildView(db, ana.id, NOW).cards.find((c) => c.id === 'c1');
  assert.equal(saved.due, NOW + 5);
  assert.deepEqual(saved.someFutureField, { any: 'thing' });
  assert.equal(saved.stability7, 3.9);
});

test('a progress record over 4 KB is rejected', async () => {
  const { db, ana } = await seed();
  const { rejected } = applyChanges(db, ana.id, { cards: [cardOf('c1', { note: 'x'.repeat(4096) }), cardOf('c2', { note: 'x'.repeat(3500) })] }, NOW);
  assert.deepEqual(rejected, ['c1']);
});

test('a homeOrder that is not a finite number is refused', async () => {
  const { db, ana } = await seed();
  const decks = [
    deckOf({ id: 'o1', homeOrder: 'x' }),
    deckOf({ id: 'o2', homeOrder: null }),
    deckOf({ id: 'o3', homeOrder: 3 }),
  ];
  assert.deepEqual(applyChanges(db, ana.id, { decks }, NOW).rejected, ['o1', 'o2']);
  const saved = buildView(db, ana.id, NOW).decks.find((d) => d.id === 'o3');
  assert.equal(saved.homeOrder, 3);
});

test('deck prefs over 8 KB, or with a front, Urdu script or folder the app does not have, are rejected', async () => {
  const { db, ana } = await seed();
  const decks = [
    deckOf({ id: 'p1', bulky: 'x'.repeat(8192) }),
    deckOf({ id: 'p2', frontShows: 'klingon' }),
    deckOf({ id: 'p3', urduScript: 'cursive' }),
    deckOf({ id: 'p4', frontShows: 'both', urduScript: 'roman' }),
    deckOf({ id: 'p5', fsrsParams: Array.from({ length: 21 }, (_, i) => i / 7), learnSteps: [1, 10], relearnSteps: [10] }),
    deckOf({ id: 'p6', folder: 'f'.repeat(101) }),
    deckOf({ id: 'p7', folder: 7 }),
    deckOf({ id: 'p8', folder: 'f'.repeat(100) }),
  ];
  assert.deepEqual(applyChanges(db, ana.id, { decks }, NOW).rejected, ['p1', 'p2', 'p3', 'p6', 'p7']);
  assert.deepEqual(buildView(db, ana.id, NOW).decks.map((d) => d.id), ['d1', 'p4', 'p5', 'p8']);
  assert.equal(buildView(db, ana.id, NOW).decks[3].folder, 'f'.repeat(100));
  // The prefs of a deck already stored are not changed by a rejected sync of it.
  assert.deepEqual(applyChanges(db, ana.id, { decks: [deckOf({ frontShows: 'nope' })] }, NOW).rejected, ['d1']);
  assert.equal(buildView(db, ana.id, NOW).decks[0].frontShows, undefined);
});

test('a deck of 200,000 cards builds a view without overflowing the stack', async () => {
  const { db, ana, ben } = await seed();
  const N = 200_000;
  db.exec('BEGIN');
  db.prepare('INSERT INTO decks (id, owner_id, data) VALUES (?, ?, ?)').run('big', ana.id, JSON.stringify({ name: 'Big', created: NOW }));
  const card = db.prepare('INSERT INTO cards (id, deck_id, data) VALUES (?, ?, ?)');
  const progress = db.prepare('INSERT INTO progress (user_id, card_id, data) VALUES (?, ?, ?)');
  for (let i = 0; i < N; i++) {
    card.run(`b${i}`, 'big', `{"front":"f","back":"b","created":${NOW}}`);
    if (i % 2 === 0) progress.run(ben.id, `b${i}`, `{"state":0,"order":${i}}`);
  }
  db.exec('COMMIT');
  give(db, 'big', ben.id);
  assert.equal(buildView(db, ana.id, NOW).cards.length, N + 3);
  const view = buildView(db, ben.id, NOW);
  assert.equal(view.cards.length, N);
  // New arrivals go after the largest order already on the reserve.
  assert.equal(view.cards[1].order, N - 2 + 1);
});

test('a card side over 20,000 characters, or card content over 64 KB, is rejected, never cut short', async () => {
  const { db, ana } = await seed();
  const cards = [
    cardOf('n1', { front: 'x'.repeat(20_001) }),
    cardOf('n2', { back: 'x'.repeat(20_001) }),
    cardOf('n3', { front: 'x'.repeat(20_000), back: 'y'.repeat(20_000), urdu: 'z'.repeat(20_000), urduRoman: 'w'.repeat(6_000) }),
    cardOf('c1', { front: 'x'.repeat(20_001) }),
    cardOf('n4', { front: 'x'.repeat(20_000), back: 'y'.repeat(20_000) }),
    cardOf('n5', { back: 'b'.repeat(910) }),
    cardOf('n6'),
  ];
  assert.deepEqual(applyChanges(db, ana.id, { cards }, NOW).rejected, ['n1', 'n2', 'n3', 'c1']);
  const view = buildView(db, ana.id, NOW);
  assert.equal(view.cards.find((c) => c.id === 'c1').front, 'front c1');
  assert.equal(view.cards.find((c) => c.id === 'n4').front.length, 20_000);
  assert.equal(view.cards.find((c) => c.id === 'n5').back.length, 910);
  assert.equal(view.cards.find((c) => c.id === 'n6').front, 'front n6');
});

test('a deck name over 300 characters, or a shared deck over 512 KB, is rejected', async () => {
  const { db, ana } = await seed();
  const decks = [
    deckOf({ id: 'k1', name: 'n'.repeat(301) }),
    deckOf({ id: 'k2', topics: [{ id: 't1', name: 'x'.repeat(512 * 1024) }] }),
    deckOf({ id: 'd1', name: 'n'.repeat(301) }),
    deckOf({ id: 'k3', name: 'n'.repeat(300), topics: [{ id: 't1', name: 'x'.repeat(11_000) }] }),
  ];
  assert.deepEqual(applyChanges(db, ana.id, { decks }, NOW).rejected, ['k1', 'k2', 'd1']);
  assert.deepEqual(buildView(db, ana.id, NOW).decks.map((d) => d.name), ['Spanish', 'n'.repeat(300)]);
});

test('an owner can hold 50,000 cards; a new card past that is rejected, edits are not', async () => {
  const { db, ana, ben } = await seed();
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO cards (id, deck_id, data) VALUES (?, ?, ?)');
  for (let i = 0; i < 49_996; i++) insert.run(`m${i}`, 'd1', '{"front":"f","back":"b"}');
  db.exec('COMMIT');
  // 49,999 cards now; one more fits, the next does not.
  const { rejected } = applyChanges(db, ana.id, { cards: [cardOf('n1'), cardOf('n2'), cardOf('c1', { front: 'edited' })] }, NOW);
  assert.deepEqual(rejected, ['n2']);
  assert.equal(buildView(db, ana.id, NOW).cards.find((c) => c.id === 'c1').front, 'edited');
  // Deleting a card in the same sync makes room for a new one.
  assert.deepEqual(applyChanges(db, ana.id, { deletedCards: ['c2'], cards: [cardOf('n2')] }, NOW).rejected, []);
  // Another owner has their own allowance.
  assert.deepEqual(applyChanges(db, ben.id, { decks: [deckOf({ id: 'b1' })], cards: [cardOf('x1', { deckId: 'b1' })] }, NOW).rejected, []);
});

test('an owner can hold 1,000 decks; a new deck past that is rejected, edits are not', async () => {
  const { db, ana, ben } = await seed();
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO decks (id, owner_id, data) VALUES (?, ?, ?)');
  for (let i = 0; i < 998; i++) insert.run(`x${i}`, ana.id, '{"name":"x"}');
  db.exec('COMMIT');
  // 999 decks now; one more fits, the next does not.
  const { rejected } = applyChanges(db, ana.id, { decks: [deckOf({ id: 'k1' }), deckOf({ id: 'k2' }), deckOf({ name: 'Renamed' })] }, NOW);
  assert.deepEqual(rejected, ['k2']);
  assert.equal(buildView(db, ana.id, NOW).decks[0].name, 'Renamed');
  // A card for the refused deck has nowhere to go.
  assert.deepEqual(applyChanges(db, ana.id, { cards: [cardOf('n1', { deckId: 'k2' })] }, NOW).rejected, ['n1']);
  // Deleting a deck in the same sync makes room.
  assert.deepEqual(applyChanges(db, ana.id, { deletedDecks: ['x0'], decks: [deckOf({ id: 'k2' })] }, NOW).rejected, []);
  assert.deepEqual(applyChanges(db, ben.id, { decks: [deckOf({ id: 'b1' })] }, NOW).rejected, []);
});

// ---- Review log ---------------------------------------------------------------

const entry = (id, over = {}) => ({
  id, cardId: 'c1', deckId: 'd1', at: NOW, rating: 3, state: 0, elapsed: null, duration: 4000,
  scheduler: 'fsrs', retention: 0.9, intervalBefore: 0, intervalAfter: 0, ...over,
});

test('reviews are stored and read back oldest first', async () => {
  const { db, ana } = await seed();
  assert.deepEqual(applyChanges(db, ana.id, { reviews: [entry('r2', { at: NOW + 5 }), entry('r1', { at: NOW + 1 })] }, NOW), { rejected: [] });
  assert.deepEqual(reviewsOf(db, ana.id).map((e) => e.id), ['r1', 'r2']);
  assert.deepEqual(reviewsOf(db, ana.id)[0], entry('r1', { at: NOW + 1 }));
  assert.equal(buildView(db, ana.id, NOW).reviews, undefined);
});

test('a review sent twice is stored once', async () => {
  const { db, ana } = await seed();
  applyChanges(db, ana.id, { reviews: [entry('r1')] }, NOW);
  assert.deepEqual(applyChanges(db, ana.id, { reviews: [entry('r1')] }, NOW), { rejected: [] });
  assert.equal(reviewsOf(db, ana.id).length, 1);
});

test('reviews for other people\'s cards are rejected', async () => {
  const { db, ana, ben } = await seed();
  assert.deepEqual(applyChanges(db, ben.id, { reviews: [entry('rb')] }, NOW), { rejected: ['rb'] });
  // Ben's own deck: ana may not log answers to its cards.
  applyChanges(db, ben.id, { decks: [deckOf({ id: 'db' })], cards: [cardOf('cb', { deckId: 'db' })] }, NOW);
  assert.deepEqual(
    applyChanges(db, ana.id, { reviews: [entry('rx', { cardId: 'cb' }), entry('ra')] }, NOW),
    { rejected: ['rx'] },
  );
  assert.deepEqual(reviewsOf(db, ana.id).map((e) => e.id), ['ra']);
  assert.equal(reviewsOf(db, ben.id).length, 0);
});

test('a given deck\'s reviews are kept per person', async () => {
  const { db, ana, ben } = await seed();
  give(db, 'd1', ben.id);
  applyChanges(db, ana.id, { reviews: [entry('ra')] }, NOW);
  assert.deepEqual(applyChanges(db, ben.id, { reviews: [entry('rb')] }, NOW), { rejected: [] });
  assert.deepEqual(reviewsOf(db, ana.id).map((e) => e.id), ['ra']);
  assert.deepEqual(reviewsOf(db, ben.id).map((e) => e.id), ['rb']);
});

test('deckId is taken from the card, not the client', async () => {
  const { db, ana } = await seed();
  applyChanges(db, ana.id, { reviews: [entry('r1', { deckId: 'wrong' })] }, NOW);
  assert.equal(reviewsOf(db, ana.id)[0].deckId, 'd1');
});

test('invalid reviews are rejected', async () => {
  const { db, ana } = await seed();
  const bad = [
    entry('b1', { rating: 5 }),
    entry('b2', { state: 4 }),
    entry('b3', { duration: 61_000 }),
    entry('b4', { scheduler: 'x' }),
    entry('b5', { at: 'now' }),
    entry('b6', { elapsed: '1' }),
    entry('b7', { note: 'x'.repeat(2000) }),
  ];
  assert.deepEqual(applyChanges(db, ana.id, { reviews: bad }, NOW), { rejected: bad.map((e) => e.id) });
  assert.equal(reviewsOf(db, ana.id).length, 0);
});

test('deletedReviews removes only your own entries', async () => {
  const { db, ana, ben } = await seed();
  applyChanges(db, ana.id, { reviews: [entry('r1')] }, NOW);
  assert.deepEqual(applyChanges(db, ben.id, { deletedReviews: ['r1'] }, NOW), { rejected: [] });
  assert.equal(reviewsOf(db, ana.id).length, 1);
  assert.deepEqual(applyChanges(db, ana.id, { deletedReviews: ['r1', 'unknown'] }, NOW), { rejected: [] });
  assert.equal(reviewsOf(db, ana.id).length, 0);
});

test('deleting a card deletes its reviews', async () => {
  const { db, ana } = await seed();
  applyChanges(db, ana.id, { reviews: [entry('r1')] }, NOW);
  applyChanges(db, ana.id, { deletedCards: ['c1'] }, NOW);
  assert.equal(reviewsOf(db, ana.id).length, 0);
});

test('a review for a card deleted meanwhile is accepted and dropped', async () => {
  const { db, ana } = await seed();
  // Answered offline, then the card was deleted, here or on another device.
  assert.deepEqual(applyChanges(db, ana.id, { reviews: [entry('r1')], deletedCards: ['c1'] }, NOW), { rejected: [] });
  assert.deepEqual(applyChanges(db, ana.id, { reviews: [entry('r2', { cardId: 'never-existed' })] }, NOW), { rejected: [] });
  assert.equal(reviewsOf(db, ana.id).length, 0);
});

// ---- Study time ---------------------------------------------------------------

test('time is merged from two devices, keeping the larger count', async () => {
  const { db, ana } = await seed();
  applyChanges(db, ana.id, { time: { '2023-01-02': { d1: 30 } } }, NOW);
  applyChanges(db, ana.id, { time: { '2023-01-02': { d1: 20, d2: 5 } } }, NOW);
  assert.deepEqual(buildView(db, ana.id, NOW).time, { '2023-01-02': { d1: 30, d2: 5 } });
});

test('a sync without time keeps the stored time', async () => {
  const { db, ana } = await seed();
  applyChanges(db, ana.id, { time: { '2023-01-02': { d1: 30 } } }, NOW);
  applyChanges(db, ana.id, { daily: { '2023-01-02': 1 } }, NOW);
  assert.deepEqual(buildView(db, ana.id, NOW).time, { '2023-01-02': { d1: 30 } });
});

test('time is cleaned like log', async () => {
  const { db, ana } = await seed();
  applyChanges(db, ana.id, { time: { '2023-01-02': { d1: -1, d2: 1.5, d3: 'x', d4: 7 }, '2999-01-01': { d1: 1 } } }, NOW);
  assert.deepEqual(buildView(db, ana.id, NOW).time, { '2023-01-02': { d4: 7 } });
});

test('time is per user', async () => {
  const { db, ana, ben } = await seed();
  applyChanges(db, ana.id, { time: { '2023-01-02': { d1: 30 } } }, NOW);
  applyChanges(db, ben.id, { daily: { '2023-01-02': 1 } }, NOW);
  assert.deepEqual(buildView(db, ben.id, NOW).time, {});
});

test("a review's active time must be null or 0..3,600,000 ms", async () => {
  const { db, ana } = await seed();
  const bad = [entry('a1', { active: -1 }), entry('a2', { active: 3_600_001 }), entry('a3', { active: 'x' }), entry('a4', { active: 1.5 })];
  assert.deepEqual(applyChanges(db, ana.id, { reviews: bad }, NOW), { rejected: bad.map((e) => e.id) });
  const good = [entry('g1', { active: null }), entry('g2'), entry('g3', { active: 3_600_000 })];
  assert.deepEqual(applyChanges(db, ana.id, { reviews: good }, NOW), { rejected: [] });
  assert.equal(reviewsOf(db, ana.id).length, 3);
});
