import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { buildView, applyChanges } from '../server/sync.js';
import { newSchedule } from '../js/fsrs.js';
import { ownedDeck, unsortedCards, sortDeck, proposeForDeck, approveProposal } from '../server/topics.js';

const NOW = 1_700_000_000_000;
const LATER = NOW + 5000;

const deckOf = (over = {}) => ({
  id: 'd1', name: 'Spanish', created: NOW, frontLang: 'es', backLang: 'en', saveAudio: false,
  scheduler: 'fsrs', newPerDay: 20, retention: 0.9, ...over,
});
const cardOf = (id, over = {}) => ({
  id, deckId: 'd1', front: `front ${id}`, back: `back ${id}`, created: NOW, updated: NOW, ...newSchedule(NOW), ...over,
});

/** Ana owns d1: c1 placed by hand, c2 placed by a file, c3 bare. */
async function seed(deckOver = {}) {
  const db = openDb(':memory:');
  const ana = await createUser(db, { username: 'ana', name: 'Ana', password: 'password-ana' }, NOW);
  const ben = await createUser(db, { username: 'ben', name: 'Ben', password: 'password-ben' }, NOW);
  const cards = [
    cardOf('c1', { topic: 'tm', topicBy: 'manual', topicAt: NOW }),
    cardOf('c2', { topic: 't1', topicBy: 'file', topicAt: NOW }),
    cardOf('c3'),
  ];
  applyChanges(db, ana.id, { decks: [deckOf(deckOver)], cards }, NOW);
  return { db, ana, ben };
}

const stored = (db, id) => JSON.parse(db.prepare('SELECT data FROM cards WHERE id = ?').get(id).data);
const storedDeck = (db) => JSON.parse(db.prepare('SELECT data FROM decks WHERE id = ?').get('d1').data);

function fake(over = {}) {
  const calls = { place: [], group: [], propose: [] };
  return {
    calls,
    async placeCards(args) {
      calls.place.push(args);
      return over.place ? over.place(args) : { placements: [], newTopics: [] };
    },
    async groupTopics(args) {
      calls.group.push(args);
      return over.group ? over.group(args) : [];
    },
    async proposeTopics(args) {
      calls.propose.push(args);
      return over.propose ? over.propose(args) : { groups: [], topics: [] };
    },
  };
}

test('ownedDeck answers only for the owner', async () => {
  const { db, ana, ben } = await seed();
  assert.equal(ownedDeck(db, ana.id, 'd1').id, 'd1');
  assert.equal(ownedDeck(db, ben.id, 'd1'), null);
  assert.equal(ownedDeck(db, ana.id, 'nope'), null);
});

test('unsortedCards skips topics and manual placements', async () => {
  const { db } = await seed({ topics: [{ id: 't1', name: 'Ser', groupId: null, by: 'file' }] });
  assert.deepEqual(unsortedCards(db, 'd1'), [{ id: 'c3', front: 'front c3', back: 'back c3' }]);
  // a manual placement with no topic (put back to Unsorted by hand) stays out too
  db.prepare('UPDATE cards SET data = ? WHERE id = ?').run(JSON.stringify({ ...stored(db, 'c3'), topicBy: 'manual' }), 'c3');
  assert.deepEqual(unsortedCards(db, 'd1'), []);
});

test('sortDeck places only unsorted, non-manual cards and keeps scheduling', async () => {
  const { db, ana } = await seed({ groups: [{ id: 'g1', name: 'Verbs' }], topics: [{ id: 't1', name: 'Ser', groupId: 'g1', by: 'file' }] });
  const before = buildView(db, ana.id, NOW).cards.find((c) => c.id === 'c3');
  const sorter = fake({
    place: () => ({
      placements: [{ id: 'c3', topic: 'new:1' }],
      newTopics: [{ ref: 'new:1', name: 'Estar', groupId: 'g1' }, { ref: 'new:2', name: 'Unused', groupId: null }],
    }),
  });
  const out = await sortDeck(db, sorter, 'd1', LATER);
  assert.deepEqual(sorter.calls.place[0].cards.map((c) => c.id), ['c3']);
  assert.deepEqual(out, { sorted: 1, created: 1, remaining: 0 });

  const deck = storedDeck(db);
  assert.equal(deck.topics.length, 2);
  const added = deck.topics.find((t) => t.name === 'Estar');
  assert.equal(added.by, 'ai');
  assert.equal(added.groupId, 'g1');
  assert.equal(deck.topicsAt, LATER);

  const c3 = stored(db, 'c3');
  assert.equal(c3.topic, added.id);
  assert.equal(c3.topicBy, 'ai');
  assert.equal(c3.topicAt, LATER);
  assert.equal(stored(db, 'c1').topic, 'tm');
  const after = buildView(db, ana.id, NOW).cards.find((c) => c.id === 'c3');
  for (const k of ['due', 'state', 'reps', 'lapses', 'stability', 'difficulty']) assert.equal(after[k], before[k]);
});

test('a card whose topic is gone is sorted again, unless it was placed by hand', async () => {
  const { db } = await seed({ topics: [{ id: 't1', name: 'Ser', groupId: null, by: 'file' }] });
  db.prepare('UPDATE cards SET data = ? WHERE id = ?').run(JSON.stringify({ ...stored(db, 'c2'), topic: 'gone', topicBy: 'ai' }), 'c2');
  // c1 is manual in 'tm', which this deck does not have: shown as Unsorted, never sent.
  assert.deepEqual(unsortedCards(db, 'd1').map((c) => c.id), ['c2', 'c3']);
  const sorter = fake({ place: (args) => ({ placements: args.cards.map((c) => ({ id: c.id, topic: 't1' })), newTopics: [] }) });
  const out = await sortDeck(db, sorter, 'd1', LATER);
  assert.deepEqual(sorter.calls.place[0].cards.map((c) => c.id), ['c2', 'c3']);
  assert.deepEqual(out, { sorted: 2, created: 0, remaining: 0 });
  assert.equal(stored(db, 'c2').topic, 't1');
  assert.equal(stored(db, 'c1').topic, 'tm');
  assert.equal(stored(db, 'c1').topicBy, 'manual');
});

test('sortDeck groups loose topics first, only when the deck has groups', async () => {
  const { db } = await seed({ groups: [{ id: 'g1', name: 'Verbs' }], topics: [{ id: 't1', name: 'Ser', groupId: null, by: 'file' }] });
  const sorter = fake({ group: () => [{ id: 't1', groupId: 'g1' }] });
  await sortDeck(db, sorter, 'd1', LATER);
  assert.equal(sorter.calls.group.length, 1);
  assert.equal(storedDeck(db).topics[0].groupId, 'g1');

  const none = await seed({ topics: [{ id: 't1', name: 'Ser', groupId: null, by: 'file' }] });
  const s2 = fake();
  await sortDeck(none.db, s2, 'd1', LATER);
  assert.equal(s2.calls.group.length, 0);
});

test('sortDeck stops when the deck is deleted while it runs', async () => {
  const { db } = await seed({ topics: [{ id: 't1', name: 'Ser', groupId: null, by: 'file' }] });
  db.prepare('UPDATE cards SET data = ? WHERE id = ?').run(JSON.stringify({ ...stored(db, 'c2'), topic: undefined, topicBy: undefined }), 'c2');
  const sorter = fake({
    place: () => {
      db.prepare('DELETE FROM decks WHERE id = ?').run('d1');
      return { placements: [], newTopics: [] };
    },
  });
  await sortDeck(db, sorter, 'd1', LATER, { batch: 1 });
  assert.equal(sorter.calls.place.length, 1);
});

test('sortDeck sends cards in batches', async () => {
  const { db, ana } = await seed({ topics: [{ id: 't1', name: 'Ser', groupId: null, by: 'file' }] });
  applyChanges(db, ana.id, { cards: [cardOf('c4'), cardOf('c5')] }, NOW);
  const sorter = fake({ place: ({ cards }) => ({ placements: cards.map((c) => ({ id: c.id, topic: 't1' })), newTopics: [] }) });
  const out = await sortDeck(db, sorter, 'd1', LATER, { batch: 2 });
  assert.deepEqual(sorter.calls.place.map((c) => c.cards.length), [2, 1]);
  assert.equal(out.sorted, 3);
});

test('a card placed by hand during a sort is left alone', async () => {
  const { db } = await seed({ topics: [{ id: 't1', name: 'Ser', groupId: null, by: 'file' }] });
  const sorter = fake({
    place: () => {
      db.prepare('UPDATE cards SET data = ? WHERE id = ?')
        .run(JSON.stringify({ ...stored(db, 'c3'), topic: 'tm', topicBy: 'manual', topicAt: LATER - 1 }), 'c3');
      return { placements: [{ id: 'c3', topic: 't1' }], newTopics: [] };
    },
  });
  const out = await sortDeck(db, sorter, 'd1', LATER);
  assert.equal(out.sorted, 0);
  assert.equal(stored(db, 'c3').topic, 'tm');
  assert.equal(stored(db, 'c3').topicBy, 'manual');
});

test('a recipient view shows the sorted topics', async () => {
  const { db, ben } = await seed();
  db.prepare('INSERT INTO assignments (deck_id, user_id, active, assigned) VALUES (?, ?, 1, ?)').run('d1', ben.id, NOW);
  const sorter = fake({
    place: () => ({ placements: [{ id: 'c3', topic: 'new:1' }], newTopics: [{ ref: 'new:1', name: 'Estar', groupId: null }] }),
  });
  await sortDeck(db, sorter, 'd1', LATER);
  const view = buildView(db, ben.id, LATER);
  const topic = view.decks[0].topics.find((t) => t.name === 'Estar');
  assert.equal(view.cards.find((c) => c.id === 'c3').topic, topic.id);
});

test('proposeForDeck sends at most 300 cards spread through the deck and stores the proposal', async () => {
  const { db, ana } = await seed();
  const many = Array.from({ length: 400 }, (_, i) => cardOf(`m${i}`));
  applyChanges(db, ana.id, { cards: many }, NOW);
  const sorter = fake({ propose: () => ({ groups: [{ id: 'g1', name: 'A' }], topics: [{ id: 't1', name: 'B', groupId: 'g1' }] }) });
  const proposal = await proposeForDeck(db, sorter, 'd1', LATER);
  const sent = sorter.calls.propose[0].cards;
  assert.equal(sent.length, 300);
  assert.ok(sent.some((c) => c.id === 'm399' || c.id === 'm398'));
  assert.equal(proposal.at, LATER);
  assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM topic_proposals WHERE deck_id = ?').get('d1').data), proposal);
});

test('approveProposal writes fresh topics and deletes the proposal', async () => {
  const { db } = await seed();
  db.prepare('INSERT INTO topic_proposals (deck_id, data) VALUES (?, ?)').run('d1', '{}');
  approveProposal(db, 'd1', {
    groups: [{ id: 'g1', name: 'Verbs' }],
    topics: [{ id: 't1', name: 'Ser', groupId: 'g1' }, { id: 't2', name: 'Other', groupId: null }],
  }, LATER);
  const deck = storedDeck(db);
  assert.equal(deck.groups.length, 1);
  assert.notEqual(deck.groups[0].id, 'g1');
  assert.equal(deck.topics.length, 2);
  assert.ok(deck.topics.every((t) => t.by === 'admin' && t.id !== 't1' && t.id !== 't2'));
  assert.equal(deck.topics[0].groupId, deck.groups[0].id);
  assert.equal(deck.topics[1].groupId, null);
  assert.equal(deck.topicsAt, LATER);
  assert.equal(db.prepare('SELECT 1 FROM topic_proposals').get(), undefined);
  // the file topic is gone, so its card is loose again; the manual one stays
  assert.equal(stored(db, 'c2').topic, undefined);
  assert.equal(stored(db, 'c1').topic, 'tm');
});

test('approveProposal remembers the old ids so a stale device cannot bring them back', async () => {
  const { db, ana } = await seed({ groups: [{ id: 'g0', name: 'Old' }], topics: [{ id: 't1', name: 'Ser', groupId: 'g0', by: 'file' }], topicsAt: NOW });
  approveProposal(db, 'd1', { groups: [], topics: [{ id: 'x', name: 'New', groupId: null }] }, LATER);
  const deck = storedDeck(db);
  assert.deepEqual(deck.deletedGroupIds, ['g0']);
  assert.deepEqual(deck.deletedTopicIds, ['t1']);
  // A device that still has the old list (and a later clock) syncs.
  applyChanges(db, ana.id, { decks: [deckOf({ groups: [{ id: 'g0', name: 'Old' }], topics: [{ id: 't1', name: 'Ser', groupId: 'g0', by: 'file' }], topicsAt: LATER + 100 })] }, LATER);
  const after = storedDeck(db);
  assert.deepEqual(after.groups, []);
  assert.deepEqual(after.topics.map((t) => t.name), ['New']);
});

test('approveProposal refuses bad names and unknown groups', async () => {
  const { db } = await seed();
  const bad = (body) => assert.throws(() => approveProposal(db, 'd1', body, LATER), /bad-request/);
  bad({ groups: [], topics: [{ id: 't', name: '  ', groupId: null }] });
  bad({ groups: [{ id: 'g', name: 'x'.repeat(61) }], topics: [] });
  bad({ groups: [], topics: [{ id: 't', name: 'A', groupId: 'zzz' }] });
  bad({ groups: 'x', topics: [] });
});

test('a deck change made while topics are being grouped survives', async () => {
  const { db } = await seed({ groups: [{ id: 'g1', name: 'Verbs' }], topics: [{ id: 't1', name: 'Ser', groupId: null, by: 'file' }] });
  const sorter = fake({
    group: () => {
      const deck = storedDeck(db);
      deck.name = 'Renamed';
      deck.topics.push({ id: 't9', name: 'New', groupId: null, by: 'admin' });
      db.prepare('UPDATE decks SET data = ? WHERE id = ?').run(JSON.stringify(deck), 'd1');
      return [{ id: 't1', groupId: 'g1' }, { id: 'gone', groupId: 'g1' }, { id: 't9', groupId: 'nope' }];
    },
  });
  await sortDeck(db, sorter, 'd1', LATER);
  const deck = storedDeck(db);
  assert.equal(deck.name, 'Renamed');
  assert.deepEqual(deck.topics.map((t) => [t.id, t.groupId]), [['t1', 'g1'], ['t9', null]]);
});

test('topicsAt never goes backwards during a job', async () => {
  const { db } = await seed({ topics: [{ id: 't1', name: 'Ser', groupId: null, by: 'file' }], topicsAt: LATER + 10_000 });
  const sorter = fake({
    place: () => ({ placements: [{ id: 'c3', topic: 'new:1' }], newTopics: [{ ref: 'new:1', name: 'Estar', groupId: null }] }),
  });
  await sortDeck(db, sorter, 'd1', LATER);
  assert.ok(storedDeck(db).topicsAt > LATER + 10_000);
});
