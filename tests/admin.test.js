import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { buildView, applyChanges } from '../server/sync.js';
import { listUsers, ownedDecks, assignDeck, unassignDeck } from '../server/admin.js';
import { newSchedule, State } from '../js/fsrs.js';

const NOW = 1_700_000_000_000;
const deck = { id: 'd1', name: 'Spanish', created: NOW, frontLang: 'es', backLang: 'en', saveAudio: false, scheduler: 'fsrs', newPerDay: 15 };
const card = (id, over = {}) => ({
  id, deckId: 'd1', front: `front ${id}`, back: `back ${id}`, created: NOW, updated: NOW, ...newSchedule(NOW), ...over,
});

/** Ana owns d1: studied s2 (created 2), s1 (created 1); reserve r1 (order 1), r0 (order 0). */
async function seed() {
  const db = openDb(':memory:');
  const ana = await createUser(db, { username: 'ana', name: 'Ana', password: 'password-ana' }, NOW);
  const ben = await createUser(db, { username: 'ben', name: 'Ben', password: 'password-ben' }, NOW);
  const cal = await createUser(db, { username: 'cal', name: 'Cal', password: 'password-cal' }, NOW);
  const cards = [
    card('s2', { created: NOW + 2 }), card('s1', { created: NOW + 1 }),
    card('r1', { created: NOW + 3, reserved: true, order: 1 }),
    card('r0', { created: NOW + 4, reserved: true, order: 0 }),
  ];
  applyChanges(db, ana.id, { decks: [deck], cards }, NOW);
  return { db, ana, ben, cal };
}

const cardsOf = (db, user) => buildView(db, user.id, NOW).cards;
const ordered = (list) => [...list].sort((a, b) => a.order - b.order);

test("a given deck arrives entirely on the recipient's reserve in the owner's order", async () => {
  const { db, ana, ben } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  const cards = ordered(cardsOf(db, ben));
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map((c) => c.order), [0, 1, 2, 3]);
  assert.deepEqual(cards.map((c) => c.id), ['s1', 's2', 'r0', 'r1']);
  assert.ok(cards.every((c) => c.reserved === true && c.state === State.New));
  assert.equal(buildView(db, ben.id, NOW).decks[0].newPerDay, 15);
});

test("the owner's later edit reaches the recipient and keeps their progress", async () => {
  const { db, ana, ben } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  const mine = cardsOf(db, ben).find((c) => c.id === 's1');
  applyChanges(db, ben.id, { cards: [{ ...mine, reserved: false, due: NOW + 999, reps: 3 }] }, NOW);
  const theirs = cardsOf(db, ana).find((c) => c.id === 's1');
  applyChanges(db, ana.id, { cards: [{ ...theirs, front: 'new front' }] }, NOW);
  const after = cardsOf(db, ben).find((c) => c.id === 's1');
  assert.equal(after.front, 'new front');
  assert.equal(after.due, NOW + 999);
  assert.equal(after.reps, 3);
});

test('a card the owner adds later lands at the end of the recipient\'s reserve', async () => {
  const { db, ana, ben } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  applyChanges(db, ana.id, { cards: [card('late', { created: NOW + 50 })] }, NOW);
  const cards = ordered(cardsOf(db, ben));
  assert.equal(cards.length, 5);
  assert.equal(cards[4].id, 'late');
  assert.equal(cards[4].reserved, true);
});

test('a card the owner deletes disappears for recipients', async () => {
  const { db, ana, ben } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  applyChanges(db, ana.id, { deletedCards: ['s1'] }, NOW);
  assert.ok(!cardsOf(db, ben).some((c) => c.id === 's1'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM progress WHERE card_id = 's1'").get().n, 0);
});

test('taking a deck back hides it and giving it again restores progress', async () => {
  const { db, ana, ben } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  const mine = cardsOf(db, ben).find((c) => c.id === 's2');
  applyChanges(db, ben.id, { cards: [{ ...mine, reserved: false, reps: 7 }] }, NOW);
  unassignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] });
  assert.deepEqual(buildView(db, ben.id, NOW).decks, []);
  assert.deepEqual(cardsOf(db, ben), []);
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW + 1);
  const back = cardsOf(db, ben).find((c) => c.id === 's2');
  assert.equal(back.reps, 7);
  assert.equal(back.reserved, false);
  assert.equal(cardsOf(db, ben).length, 4);
});

test('deleting a given deck removes it for everyone', async () => {
  const { db, ana, ben } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  assert.deepEqual(applyChanges(db, ana.id, { deletedDecks: ['d1'] }, NOW), { rejected: [] });
  assert.deepEqual(buildView(db, ben.id, NOW).decks, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n, 0);
});

test('only the owner can give a deck', async () => {
  const { db, ben, cal } = await seed();
  assert.throws(() => assignDeck(db, { ownerId: ben.id, deckId: 'd1', userIds: [cal.id] }, NOW), { message: 'not-owner' });
  assert.throws(() => assignDeck(db, { ownerId: ben.id, deckId: 'nope', userIds: [cal.id] }, NOW), { message: 'not-owner' });
});

test('giving a deck to its owner does nothing', async () => {
  const { db, ana } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ana.id] }, NOW);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n, 0);
  assert.equal(cardsOf(db, ana).find((c) => c.id === 's1').reserved, undefined);
});

test('ownedDecks counts cards and lists recipients; listUsers is ordered by name', async () => {
  const { db, ana, ben, cal } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id, cal.id] }, NOW);
  unassignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [cal.id] });
  const [d] = ownedDecks(db, ana.id);
  assert.equal(d.id, 'd1');
  assert.equal(d.name, 'Spanish');
  assert.equal(d.cards, 4);
  assert.deepEqual(d.recipients, [{ userId: ben.id, name: 'Ben', active: true }, { userId: cal.id, name: 'Cal', active: false }]);
  assert.deepEqual(listUsers(db).map((u) => u.name), ['Ana', 'Ben', 'Cal']);
  assert.deepEqual(Object.keys(listUsers(db)[0]).sort(), ['created', 'id', 'name', 'role', 'username']);
});
