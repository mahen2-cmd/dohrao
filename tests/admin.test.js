import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { buildView, applyChanges } from '../server/sync.js';
import { listUsers, ownedDecks, assignDeck, unassignDeck, setUrduSwitch, peopleProgress, personProgress } from '../server/admin.js';
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
  assert.equal(d.urdu, false);
  assert.deepEqual(d.recipients, [{ userId: ben.id, name: 'Ben', active: true, urdu: false, front: null }, { userId: cal.id, name: 'Cal', active: false, urdu: false, front: null }]);
  assert.deepEqual(listUsers(db).map((u) => u.name), ['Ana', 'Ben', 'Cal']);
  assert.deepEqual(Object.keys(listUsers(db)[0]).sort(), ['created', 'id', 'name', 'role', 'username']);
});

test("progress shows each person's decks, statuses and study days, and only cards they have started", async () => {
  const { db, ana, ben } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  const mine = cardsOf(db, ben);
  const s1 = mine.find((c) => c.id === 's1');
  const s2 = mine.find((c) => c.id === 's2');
  applyChanges(db, ben.id, {
    cards: [
      { ...s1, reserved: false, order: undefined, state: State.Review, reps: 6, scheduledDays: 30 },
      { ...s2, reserved: false, order: undefined },
    ],
    daily: { '2023-11-14': 12 },
  }, NOW);

  const people = peopleProgress(db, NOW);
  assert.deepEqual(people.map((p) => p.user.name), ['Ana', 'Ben', 'Cal']);
  const benRow = people.find((p) => p.user.id === ben.id);
  assert.deepEqual(benRow.daily, { '2023-11-14': 12 });
  assert.equal(benRow.cards, undefined);
  assert.equal(benRow.decks.length, 1);
  assert.equal(benRow.decks[0].name, 'Spanish');
  assert.equal(benRow.decks[0].assigned, true);
  assert.equal(benRow.decks[0].from, 'Ana');
  assert.equal(benRow.decks[0].total, 4);
  assert.equal(benRow.decks[0].reserve, 2);
  assert.equal(benRow.decks[0].known, 1);
  assert.equal(benRow.decks[0].waiting, 1);
  assert.equal(benRow.decks[0].learned, 1);
  assert.equal(people.find((p) => p.user.id === ana.id).decks[0].assigned, false);

  const detail = personProgress(db, ben.id, NOW);
  assert.equal(detail.user.username, 'ben');
  assert.deepEqual(detail.cards.map((c) => [c.id, c.status, c.deckId]), [['s1', 'known', 'd1']]);
  assert.equal(detail.cards[0].front, 'front s1');
  assert.equal(detail.cards[0].pass, undefined);
  assert.equal(personProgress(db, 'no-such-user', NOW), null);
});

test("the owner's hidden choice is not copied to a new recipient", async () => {
  const { db, ana, ben } = await seed();
  applyChanges(db, ana.id, { decks: [{ ...deck, hidden: true }] }, NOW);
  assert.equal(buildView(db, ana.id, NOW).decks[0].hidden, true);
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  const given = buildView(db, ben.id, NOW).decks[0];
  assert.equal('hidden' in given, false);
  assert.equal(given.newPerDay, 15); // other prefs still copied
});

test("the owner's folder is not copied to a new recipient", async () => {
  const { db, ana, ben } = await seed();
  applyChanges(db, ana.id, { decks: [{ ...deck, folder: 'f1' }] }, NOW);
  assert.equal(buildView(db, ana.id, NOW).decks[0].folder, 'f1');
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  const given = buildView(db, ben.id, NOW).decks[0];
  assert.equal('folder' in given, false);
  assert.equal(given.newPerDay, 15); // other prefs still copied
});

test("a returning recipient's own hidden choice is kept", async () => {
  const { db, ana, ben } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  applyChanges(db, ben.id, { decks: [{ ...buildView(db, ben.id, NOW).decks[0], hidden: true }] }, NOW);
  unassignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] });
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  assert.equal(buildView(db, ben.id, NOW).decks[0].hidden, true);
});

test("a new recipient does not get the owner's Urdu choice", async () => {
  const { db, ana, ben } = await seed();
  applyChanges(db, ana.id, { decks: [{ ...deck, frontShows: 'ur', frontShowsAt: 1, urduScript: 'roman' }] }, NOW);
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  const given = buildView(db, ben.id, NOW).decks[0];
  for (const key of ['frontShows', 'frontShowsAt', 'urduScript']) assert.equal(key in given, false);
});

test("switching Urdu on shows in the recipient's view and survives their sync", async () => {
  const { db, ana, ben } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  assert.equal(buildView(db, ben.id, NOW).decks[0].urduSwitch, undefined);
  setUrduSwitch(db, { ownerId: ana.id, deckId: 'd1', userId: ben.id, on: true }, NOW + 10);
  const seen = buildView(db, ben.id, NOW).decks[0];
  assert.equal(seen.urduSwitch, 'ur');
  assert.equal(seen.urduSwitchAt, NOW + 10);
  applyChanges(db, ben.id, { decks: [{ ...seen, frontShows: 'en' }] }, NOW + 5);
  assert.equal(buildView(db, ben.id, NOW).decks[0].urduSwitch, 'ur');
  const prefs = db.prepare('SELECT data FROM deck_prefs WHERE user_id = ? AND deck_id = ?').get(ben.id, 'd1');
  assert.ok(!('urduSwitch' in JSON.parse(prefs.data)) && !('urduSwitchAt' in JSON.parse(prefs.data)));
});

test("ownedDecks lists each recipient's Urdu switch and the deck's own flag", async () => {
  const { db, ana, ben, cal } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id, cal.id] }, NOW);
  setUrduSwitch(db, { ownerId: ana.id, deckId: 'd1', userId: cal.id, on: true }, NOW);
  assert.deepEqual(ownedDecks(db, ana.id)[0].recipients.map((r) => [r.name, r.urdu, r.front]), [['Ben', false, null], ['Cal', true, 'ur']]);
  assert.equal(ownedDecks(db, ana.id)[0].urdu, false);
  applyChanges(db, ana.id, { decks: [{ ...deck, urdu: true }] }, NOW);
  assert.equal(ownedDecks(db, ana.id)[0].urdu, true);
});

test('setUrduSwitch refuses a deck not given to that person, or not yours', async () => {
  const { db, ana, ben, cal } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  assert.throws(() => setUrduSwitch(db, { ownerId: ana.id, deckId: 'd1', userId: cal.id, on: true }, NOW), { message: 'not-given' });
  assert.throws(() => setUrduSwitch(db, { ownerId: ben.id, deckId: 'd1', userId: ben.id, on: true }, NOW), { message: 'not-owner' });
});

test('the admin can set a person\'s front to English, Urdu or Both', async () => {
  const { db, ana, ben } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  setUrduSwitch(db, { ownerId: ana.id, deckId: 'd1', userId: ben.id, front: 'both' }, NOW + 10);
  assert.equal(buildView(db, ben.id, NOW).decks[0].urduSwitch, 'both');
  assert.deepEqual(ownedDecks(db, ana.id)[0].recipients.map((r) => [r.urdu, r.front]), [[true, 'both']]);
  setUrduSwitch(db, { ownerId: ana.id, deckId: 'd1', userId: ben.id, front: 'en' }, NOW + 20);
  assert.equal(buildView(db, ben.id, NOW).decks[0].urduSwitch, 'en');
  assert.deepEqual(ownedDecks(db, ana.id)[0].recipients.map((r) => [r.urdu, r.front]), [[false, 'en']]);
  assert.throws(() => setUrduSwitch(db, { ownerId: ana.id, deckId: 'd1', userId: ben.id, front: 'fr' }, NOW), { message: 'bad-front' });
});

test('a switch set before fronts could be chosen reads as Urdu', async () => {
  const { db, ana, ben } = await seed();
  assignDeck(db, { ownerId: ana.id, deckId: 'd1', userIds: [ben.id] }, NOW);
  db.prepare('UPDATE assignments SET urdu = 1, urdu_at = ?, front = NULL WHERE user_id = ?').run(NOW, ben.id);
  assert.equal(buildView(db, ben.id, NOW).decks[0].urduSwitch, 'ur');
  assert.equal(ownedDecks(db, ana.id)[0].recipients[0].front, 'ur');
});
