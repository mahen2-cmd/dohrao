import test from 'node:test';
import assert from 'node:assert/strict';

import { DAY, MINUTE, Rating, State } from '../js/fsrs.js';
import * as store from '../js/store.js';
import { DECK_SHARED } from '../server/fields.js';

const T0 = new Date(2026, 0, 1, 9, 0, 0).getTime();

function setup(deckOptions = {}) {
  store.reset();
  return store.createDeck({ name: 'Test', ...deckOptions });
}

test('add, edit and delete a card', () => {
  const deck = setup();
  const card = store.addCard(deck.id, 'front', 'back', T0);
  assert.equal(store.cardsIn(deck.id).length, 1);
  assert.equal(card.state, State.New);

  store.updateCard(card.id, { front: 'changed' });
  assert.equal(store.card(card.id).front, 'changed');
  assert.equal(store.card(card.id).state, State.New);

  store.deleteCard(card.id);
  assert.equal(store.cardsIn(deck.id).length, 0);
});

test('deleting a deck removes only its cards', () => {
  const a = setup();
  const b = store.createDeck({ name: 'Other' });
  store.addCard(a.id, 'a', 'a', T0);
  store.addCard(b.id, 'b', 'b', T0);
  store.deleteDeck(a.id);
  assert.equal(store.decks().length, 1);
  assert.equal(store.cardsIn(a.id).length, 0);
  assert.equal(store.cardsIn(b.id).length, 1);
});

test('new cards per day limit is enforced', () => {
  const deck = setup({ newPerDay: 2 });
  for (let i = 0; i < 5; i++) store.addCard(deck.id, `q${i}`, `a${i}`, T0 + i);
  assert.equal(store.counts(deck.id, T0).new, 2);

  store.answerCard(store.nextCard(deck.id, T0).id, Rating.Easy, T0);
  assert.equal(store.counts(deck.id, T0).new, 1);
  store.answerCard(store.nextCard(deck.id, T0).id, Rating.Easy, T0);
  assert.equal(store.counts(deck.id, T0).total, 0);
  assert.equal(store.nextCard(deck.id, T0), undefined);

  // The allowance resets the next day.
  assert.equal(store.counts(deck.id, T0 + DAY).new, 2);
});

test('tomorrow counts the new cards left after today, up to the daily limit', () => {
  const deck = setup({ newPerDay: 2 });
  for (let i = 0; i < 3; i++) store.addCard(deck.id, `q${i}`, `a${i}`, T0 + i);
  store.addCard(deck.id, 'kept', 'back', T0, { reserved: true });
  assert.equal(store.counts(deck.id, T0).tomorrow.new, 1);

  store.addCard(deck.id, 'q3', 'a3', T0 + 3);
  store.addCard(deck.id, 'q4', 'a4', T0 + 4);
  assert.equal(store.counts(deck.id, T0).tomorrow.new, 2);

  // Studying today's new cards does not change tomorrow's.
  store.answerCard(store.nextCard(deck.id, T0).id, Rating.Easy, T0);
  assert.equal(store.counts(deck.id, T0).tomorrow.new, 2);

  store.deleteCards(store.cardsIn(deck.id).filter((c) => c.state === State.New && !c.reserved).map((c) => c.id));
  assert.equal(store.counts(deck.id, T0).tomorrow.new, 0);
});

test('tomorrow counts the learning and review cards scheduled for that day', () => {
  const deck = setup({ newPerDay: 0 });
  const [learning, dueTomorrow, dueLater, dueToday] = ['l', 't', 'x', 'd'].map((f) => store.addCard(deck.id, f, f, T0));
  const tomorrow = T0 + DAY;
  store.updateCard(learning.id, { state: State.Relearning, due: tomorrow });
  store.updateCard(dueTomorrow.id, { state: State.Review, due: tomorrow });
  store.updateCard(dueLater.id, { state: State.Review, due: T0 + 2 * DAY });
  store.updateCard(dueToday.id, { state: State.Review, due: T0 });

  assert.deepEqual(store.counts(deck.id, T0).tomorrow, { new: 0, learning: 1, review: 1, total: 2 });
});

test('upcoming lists each day: overdue cards today, then the reviews and new cards to come', () => {
  const deck = setup({ newPerDay: 2 });
  for (let i = 0; i < 5; i++) store.addCard(deck.id, `n${i}`, `n${i}`, T0 + i);
  store.addCard(deck.id, 'kept', 'kept', T0, { reserved: true });
  const [overdue, inThree, tooFar] = ['o', 't', 'f'].map((f) => store.addCard(deck.id, f, f, T0));
  store.updateCard(overdue.id, { state: State.Review, due: T0 - 5 * DAY });
  store.updateCard(inThree.id, { state: State.Review, due: T0 + 3 * DAY });
  store.updateCard(tooFar.id, { state: State.Review, due: T0 + 9 * DAY });

  const days = store.upcoming(deck.id, 7, T0);
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((d) => d.new), [2, 2, 1, 0, 0, 0, 0]);
  assert.deepEqual(days.map((d) => d.review), [1, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(days.map((d) => d.total), [3, 2, 1, 1, 0, 0, 0]);
  assert.equal(days[1].start - days[0].start, DAY);
  assert.deepEqual(store.upcoming(deck.id, 7, T0)[1], { start: days[1].start, ...store.counts(deck.id, T0).tomorrow });
});

test('upcoming for all decks adds up each deck, with its own daily limit', () => {
  const a = setup({ newPerDay: 1 });
  const b = store.createDeck({ name: 'Other', newPerDay: 3 });
  for (let i = 0; i < 3; i++) store.addCard(a.id, `a${i}`, 'a', T0 + i);
  for (let i = 0; i < 4; i++) store.addCard(b.id, `b${i}`, 'b', T0 + i);
  assert.deepEqual(store.upcoming(undefined, 4, T0).map((d) => d.new), [4, 2, 1, 0]);
});

test('queue order: due learning, then reviews, then new, then waiting learning', () => {
  const deck = setup();
  const learning = store.addCard(deck.id, 'learning', '-', T0);
  const review = store.addCard(deck.id, 'review', '-', T0 + 1);
  const fresh = store.addCard(deck.id, 'fresh', '-', T0 + 2);

  store.answerCard(review.id, Rating.Easy, T0);
  const reviewDay = store.card(review.id).due;
  store.answerCard(learning.id, Rating.Again, reviewDay);

  // Learning card is not due for another minute, so the review comes first.
  assert.equal(store.nextCard(deck.id, reviewDay).id, review.id);
  assert.equal(store.nextCard(deck.id, reviewDay + 2 * MINUTE).id, learning.id);

  store.answerCard(review.id, Rating.Good, reviewDay);
  assert.equal(store.nextCard(deck.id, reviewDay).id, fresh.id);

  store.answerCard(fresh.id, Rating.Easy, reviewDay);
  assert.equal(store.nextCard(deck.id, reviewDay).id, learning.id);
});

test('review cards become due on their day, not before', () => {
  const deck = setup();
  const card = store.addCard(deck.id, 'q', 'a', T0);
  store.answerCard(card.id, Rating.Easy, T0);
  const days = store.card(card.id).scheduledDays;
  assert.equal(store.counts(deck.id, T0 + (days - 1) * DAY).review, 0);
  // Earlier in the day than the original review still counts as due.
  assert.equal(store.counts(deck.id, T0 + days * DAY - 3 * 60 * MINUTE).review, 1);
});

test('stats track reviews today and the streak', () => {
  const deck = setup();
  const a = store.addCard(deck.id, 'a', 'a', T0);
  const b = store.addCard(deck.id, 'b', 'b', T0);
  assert.deepEqual(store.stats(T0), { reviewedToday: 0, streak: 0 });
  store.answerCard(a.id, Rating.Good, T0);
  store.answerCard(b.id, Rating.Good, T0 + DAY);
  assert.deepEqual(store.stats(T0 + DAY), { reviewedToday: 1, streak: 2 });
  assert.deepEqual(store.stats(T0 + 2 * DAY), { reviewedToday: 0, streak: 2 });
  assert.deepEqual(store.stats(T0 + 3 * DAY), { reviewedToday: 0, streak: 0 });
});

test('recent days list the reviews on each day, ending today', () => {
  const deck = setup();
  const a = store.addCard(deck.id, 'a', 'a', T0);
  const b = store.addCard(deck.id, 'b', 'b', T0);
  store.answerCard(a.id, Rating.Good, T0);
  store.answerCard(b.id, Rating.Good, T0 + 2 * DAY);
  const days = store.recentDays(4, T0 + 2 * DAY);
  assert.deepEqual(days.map((day) => day.n), [0, 1, 0, 1]);
  assert.equal(store.dayKey(days[3].date), store.dayKey(T0 + 2 * DAY));
});

test('statistics count cards, the forecast and answers by kind', () => {
  const deck = setup();
  const other = store.createDeck({ name: 'Other' });
  const a = store.addCard(deck.id, 'a', 'a', T0);
  const b = store.addCard(deck.id, 'b', 'b', T0 + 1);
  store.addCard(deck.id, 'c', 'c', T0 + 2);
  const d = store.addCard(other.id, 'd', 'd', T0 + 3);

  store.answerCard(a.id, Rating.Easy, T0); // graduates, due in 4 days
  store.answerCard(b.id, Rating.Again, T0); // stays in learning
  store.answerCard(d.id, Rating.Easy, T0);

  const s = store.statistics(deck.id, 30, T0);
  assert.deepEqual(s.cards, { new: 1, learning: 1, young: 1, mature: 0 });
  assert.equal(s.forecast[0], 1);
  assert.equal(s.forecast[store.card(a.id).scheduledDays], 1);
  assert.equal(s.forecast.reduce((sum, n) => sum + n, 0), 2);
  assert.deepEqual(s.answers, [[1, 0, 0, 1], [0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.equal(s.reviewedToday, 2);
  assert.equal(s.loggedFrom, store.dayKey(T0));
  assert.equal(s.partial, false);
  assert.equal(store.statistics(null, 30, T0).reviewedToday, 3);

  // On its due day the card is answered as a young review; overdue cards count as due today.
  const due = store.card(a.id).due;
  assert.equal(store.statistics(deck.id, 30, due + 3 * DAY).forecast[0], 2);
  store.answerCard(a.id, Rating.Hard, due);
  assert.deepEqual(store.statistics(deck.id, 30, due).answers[1], [0, 1, 0, 0]);
  // The first day's answers have fallen out of a two-day window.
  assert.deepEqual(store.statistics(deck.id, 2, due).answers[0], [0, 0, 0, 0]);
});

test('statistics say when earlier reviews have no breakdown', () => {
  const deck = setup();
  const card = store.addCard(deck.id, 'q', 'a', T0);
  store.answerCard(card.id, Rating.Good, T0);
  const old = JSON.parse(store.exportData());
  delete old.log;
  store.importData(JSON.stringify(old));
  const s = store.statistics(null, 30, T0);
  assert.equal(s.reviewedToday, 1);
  assert.equal(s.loggedFrom, null);
  assert.equal(s.partial, true);
});

test('reserve cards stay out of study until they are pulled', () => {
  const deck = setup();
  store.addCard(deck.id, 'now', '-', T0);
  store.addCards(deck.id, [['r1', '-'], ['r2', '-'], ['r3', '-']], T0 + 1, { reserved: true });
  store.addCard(deck.id, 'r4', '-', T0 + 10, { reserved: true });

  assert.deepEqual(store.reserveIn(deck.id).map((c) => c.front), ['r1', 'r2', 'r3', 'r4']);
  let c = store.counts(deck.id, T0);
  assert.deepEqual([c.new, c.cards, c.reserve], [1, 5, 4]);
  assert.equal(store.statistics(deck.id, 30, T0).cards.new, 1);

  assert.equal(store.pullFromReserve(deck.id, 2), 2);
  c = store.counts(deck.id, T0);
  assert.deepEqual([c.new, c.reserve], [3, 2]);
  assert.deepEqual(store.reserveIn(deck.id).map((c) => c.front), ['r3', 'r4']);

  // Asking for more than there is pulls what is left.
  assert.equal(store.pullFromReserve(deck.id, 10), 2);
  assert.equal(store.pullFromReserve(deck.id), 0);
  assert.equal(store.counts(deck.id, T0).new, 5);

  // The reserve survives a backup.
  store.updateCard(store.cardsIn(deck.id)[0].id, { reserved: true });
  store.importData(store.exportData());
  assert.equal(store.counts(deck.id, T0).reserve, 1);
});

test('chosen cards can be pulled from the reserve, in reserve order', () => {
  const deck = setup();
  store.addCards(deck.id, [['a', '-'], ['b', '-'], ['c', '-'], ['d', '-']], T0, { reserved: true });
  const studying = store.addCard(deck.id, 'studying', '-', T0 + 10);
  const id = Object.fromEntries(store.cardsIn(deck.id).map((c) => [c.front, c.id]));

  // Only reserve cards count; the rest are skipped. Pulled in reserve order, not the order given.
  assert.equal(store.pullCards([id.d, id.b, studying.id, 'no-such-card'], T0 + 100), 2);
  assert.deepEqual(store.reserveIn(deck.id).map((c) => c.front), ['a', 'c']);
  assert.ok(store.card(id.b).pulled < store.card(id.d).pulled);
  assert.equal(store.counts(deck.id, T0 + 100).new, 3);

  // They come up after the new card already waiting.
  const order = [];
  for (let card; (card = store.nextCard(deck.id, T0 + 200)); ) {
    order.push(card.front);
    store.deleteCard(card.id);
  }
  assert.deepEqual(order, ['studying', 'b', 'd']);
  assert.equal(store.pullCards([]), 0);
});

test('the reserve can be rearranged, and is pulled and studied in that order', () => {
  const deck = setup();
  store.addCards(deck.id, [['a', '-'], ['b', '-'], ['c', '-'], ['d', '-'], ['e', '-']], T0, { reserved: true });
  const id = Object.fromEntries(store.cardsIn(deck.id).map((c) => [c.front, c.id]));
  const order = () => store.reserveIn(deck.id).map((c) => c.front).join('');

  // Cards moved together keep their own order.
  assert.equal(store.moveInReserve(deck.id, [id.d, id.b], { before: id.a }), 2);
  assert.equal(order(), 'bdace');
  store.moveInReserve(deck.id, [id.b], { after: id.c });
  assert.equal(order(), 'dacbe');
  store.moveInReserve(deck.id, [id.d, id.c]);
  assert.equal(order(), 'abedc');
  assert.equal(store.moveInReserve(deck.id, ['no-such-card'], { before: id.a }), 0);

  // Cards added later wait at the end, and the order survives a backup.
  store.addCard(deck.id, 'f', '-', T0 + 100, { reserved: true });
  store.importData(store.exportData());
  assert.equal(order(), 'abedcf');
  assert.deepEqual(store.findCards(deck.id, { sort: 'reserve' }, T0).map((c) => c.front).join(''), 'abedcf');

  // Pulled cards come up after the new cards already waiting, in the order they had.
  store.moveInReserve(deck.id, [id.e], { before: id.a });
  store.addCard(deck.id, 'new', '-', T0 + 200);
  assert.equal(store.pullFromReserve(deck.id, 2, T0 + 300), 2);
  assert.equal(order(), 'bdcf');
  const studied = [];
  for (let card; (card = store.nextCard(deck.id, T0 + 400)); ) {
    studied.push(card.front);
    store.deleteCard(card.id);
  }
  assert.deepEqual(studied, ['new', 'e', 'a']);

  // A card taken off the reserve and put back goes to the end.
  store.updateCard(id.b, { reserved: undefined });
  store.updateCard(id.b, { reserved: true });
  assert.equal(order(), 'dcfb');
});

test('the whole reserve can be reversed, and reversed back', () => {
  const deck = setup();
  store.addCards(deck.id, [['a', '-'], ['b', '-'], ['c', '-'], ['d', '-']], T0, { reserved: true });
  store.addCards(deck.id, [['studying', '-']], T0);
  const id = Object.fromEntries(store.cardsIn(deck.id).map((c) => [c.front, c.id]));
  const order = () => store.reserveIn(deck.id).map((c) => c.front).join('');

  // A hand-arranged sequence flips as it stands, and cards not on reserve are left alone.
  store.moveInReserve(deck.id, [id.d], { before: id.b });
  assert.equal(order(), 'adbc');
  assert.equal(store.reverseReserve(deck.id), 4);
  assert.equal(order(), 'cbda');
  assert.equal(store.card(id.studying).reserved, undefined);
  assert.equal(store.card(id.studying).order, undefined);

  // Cards added afterwards still join the end.
  store.addCards(deck.id, [['e', '-']], T0 + 500, { reserved: true });
  assert.equal(order(), 'cbdae');

  store.reverseReserve(deck.id);
  assert.equal(order(), 'eadbc');

  // It is what gets pulled in first.
  store.pullFromReserve(deck.id, 1, T0 + 600);
  assert.equal(order(), 'adbc');
});

test('new, learning and due cards can go back on the reserve, starting over', () => {
  const deck = setup();
  store.addCards(deck.id, [['r1', '-'], ['r2', '-']], T0, { reserved: true });
  const fresh = store.addCard(deck.id, 'fresh', '-', T0 + 1);
  const learning = store.addCard(deck.id, 'learning', '-', T0 + 2);
  const due = store.addCard(deck.id, 'due', '-', T0 + 3);
  store.answerCard(learning.id, Rating.Good, T0 + 10);
  store.answerCard(due.id, Rating.Easy, T0 + 10);
  assert.notEqual(store.card(learning.id).state, State.New);
  assert.equal(store.card(due.id).state, State.Review);
  store.moveInReserve(deck.id, [store.reserveIn(deck.id)[1].id], { before: store.reserveIn(deck.id)[0].id });

  const [r1] = store.reserveIn(deck.id).slice(-1);
  assert.equal(store.returnToReserve([due.id, fresh.id, learning.id, r1.id, 'no-such-card'], T0 + DAY), 3);
  // They join the end of the reserve in the order given, as new cards.
  assert.deepEqual(store.reserveIn(deck.id).map((c) => c.front), ['r2', 'r1', 'due', 'fresh', 'learning']);
  for (const id of [due.id, learning.id]) {
    const c = store.card(id);
    assert.deepEqual([c.state, c.reps, c.lapses, c.lastReview], [State.New, 0, 0, null]);
  }
  assert.equal(store.nextCard(deck.id, T0 + DAY), undefined);
  assert.equal(store.counts(deck.id, T0 + DAY).reserve, 5);
});

test('reversed copies of cards go on the reserve, once', () => {
  const deck = setup();
  const hello = store.addCard(deck.id, 'hello', 'olá', T0);
  const thanks = store.addCard(deck.id, 'thanks', 'obrigado', T0 + 1, { reserved: true });
  const same = store.addCard(deck.id, 'taxi', 'Taxi ', T0 + 2);

  const added = store.addReversed([thanks.id, hello.id, same.id, 'no-such-card'], T0 + 10);
  assert.deepEqual(added.map((c) => [c.front, c.back, c.reserved, c.reversed, c.state]), [
    ['obrigado', 'thanks', true, true, State.New],
    ['olá', 'hello', true, true, State.New],
  ]);
  // They join the end of the reserve in the order given, and the originals are untouched.
  assert.deepEqual(store.reserveIn(deck.id).map((c) => c.front), ['thanks', 'obrigado', 'olá']);
  assert.equal(store.card(hello.id).reserved, undefined);

  // Neither a card nor its copy gets a second one.
  assert.deepEqual(store.addReversed([hello.id, added[1].id, thanks.id]), []);
  // Reversing a copy whose original is gone gives an ordinary card back.
  store.deleteCard(hello.id);
  const [again] = store.addReversed([added[1].id]);
  assert.deepEqual([again.front, again.back, again.reversed], ['hello', 'olá', undefined]);
});

test('findCards filters by group, text, dates and lapses, and sorts', () => {
  const deck = setup();
  const fresh = store.addCard(deck.id, 'Banana', 'yellow', T0);
  const learning = store.addCard(deck.id, 'apple', 'red', T0 + 1);
  const review = store.addCard(deck.id, 'Cherry', 'red too', T0 + 2);
  const held = store.addCard(deck.id, 'date', 'brown', T0 + 3, { reserved: true });
  store.answerCard(learning.id, Rating.Again, T0);
  store.answerCard(review.id, Rating.Easy, T0);
  const dueDay = store.card(review.id).due;
  const ids = (filters, now = T0) => store.findCards(deck.id, filters, now).map((c) => c.id);

  assert.deepEqual(ids(), [held.id, review.id, learning.id, fresh.id]);
  assert.deepEqual(ids({ groups: ['new'] }), [fresh.id]);
  assert.deepEqual(ids({ groups: ['reserve', 'learning'] }), [held.id, learning.id]);
  assert.deepEqual(ids({ groups: ['later'] }), [review.id]);
  assert.deepEqual(ids({ groups: ['due'] }), []);
  assert.deepEqual(ids({ groups: ['due'] }, dueDay), [review.id]);
  assert.equal(store.cardGroup(store.card(review.id), dueDay), 'due');

  assert.deepEqual(ids({ text: ' RED ' }), [review.id, learning.id]);
  assert.deepEqual(ids({ text: 'red', groups: ['learning'] }), [learning.id]);

  // Only cards with a review coming have a due date.
  assert.deepEqual(ids({ due: 'today' }), [learning.id]);
  assert.deepEqual(ids({ due: 'week' }), [review.id, learning.id]);
  assert.deepEqual(ids({ due: 'overdue' }, dueDay), []);
  assert.deepEqual(ids({ due: 'overdue' }, dueDay + DAY), [review.id]);

  assert.deepEqual(ids({ added: 'today' }, T0 + DAY), []);
  assert.equal(ids({ added: 'week' }, T0 + DAY).length, 4);

  store.answerCard(review.id, Rating.Again, dueDay);
  assert.deepEqual(ids({ lapses: 'some' }, dueDay), [review.id]);
  assert.deepEqual(ids({ lapses: 'many' }, dueDay), []);

  assert.deepEqual(ids({ sort: 'oldest' }), [fresh.id, learning.id, review.id, held.id]);
  assert.deepEqual(ids({ sort: 'front' }), [learning.id, fresh.id, review.id, held.id]);
  assert.deepEqual(ids({ sort: 'due' }, dueDay).slice(2), [held.id, fresh.id]);
  assert.equal(ids({ sort: 'lapses' }, dueDay)[0], review.id);
});

test('deleteCards removes only the cards named', () => {
  const deck = setup();
  const [a, b, c] = ['a', 'b', 'c'].map((text, i) => store.addCard(deck.id, text, text, T0 + i));
  assert.equal(store.deleteCards([a.id, c.id, 'no-such-card']), 2);
  assert.deepEqual(store.cardsIn(deck.id).map((card) => card.id), [b.id]);
  assert.equal(store.deleteCards([]), 0);
});

test('export and import round-trip', () => {
  const deck = setup();
  store.addCard(deck.id, 'q', 'a', T0);
  const backup = store.exportData();
  store.reset();
  assert.equal(store.decks().length, 0);
  store.importData(backup);
  assert.equal(store.decks()[0].name, 'Test');
  assert.equal(store.cardsIn(deck.id)[0].front, 'q');
  assert.throws(() => store.importData('{"nope":true}'));
});

test('addCards adds many cards in file order as new cards', () => {
  const deck = setup();
  const added = store.addCards(deck.id, [['um', 'one'], ['dois', 'two'], ['três', 'three']], T0);
  assert.equal(added, 3);
  assert.equal(store.counts(deck.id, T0).new, 3);
  assert.equal(store.nextCard(deck.id, T0).front, 'um');
  assert.deepEqual(store.cardsIn(deck.id).map((c) => c.back), ['one', 'two', 'three']);
});

// ---- Saving only what changed ---------------------------------------------

/** A copy of the current state, as it would be saved. */
const current = () => JSON.parse(store.exportData());

test('diffState finds changed, new and deleted cards and decks only', () => {
  const deck = setup();
  const [a, b, c] = ['a', 'b', 'c'].map((text, i) => store.addCard(deck.id, text, text, T0 + i));
  const snapshot = store.snapshotOf(current());

  store.answerCard(a.id, Rating.Good, T0);
  const answered = store.diffState(snapshot, current());
  assert.deepEqual(answered.cards.map((card) => card.id), [a.id]);
  assert.equal(answered.cards[0].reps, 1);
  assert.equal(answered.decks, undefined);
  assert.equal(answered.deletedCards, undefined);
  assert.equal(answered.deletedDecks, undefined);
  assert.equal(answered.settings, undefined);
  assert.equal(typeof answered.savedAt, 'number');

  store.deleteCard(b.id);
  const other = store.createDeck({ name: 'Other' });
  store.updateDeck(deck.id, { newPerDay: 5 });
  const changes = store.diffState(snapshot, current());
  assert.deepEqual(changes.deletedCards, [b.id]);
  assert.deepEqual(changes.decks.map((d) => d.id).sort(), [deck.id, other.id].sort());
  assert.ok(!changes.cards.some((card) => card.id === c.id));

  store.deleteDeck(deck.id);
  assert.deepEqual(store.diffState(snapshot, current()).deletedDecks, [deck.id]);
});

test('diffState is null when nothing changed', () => {
  const deck = setup();
  store.addCard(deck.id, 'q', 'a', T0);
  assert.equal(store.diffState(store.snapshotOf(current()), current()), null);
});

test('daily and log are sent only when they change', () => {
  const deck = setup();
  const card = store.addCard(deck.id, 'q', 'a', T0);
  const snapshot = store.snapshotOf(current());

  store.updateCard(card.id, { front: 'changed' });
  const edited = store.diffState(snapshot, current());
  assert.equal(edited.daily, undefined);
  assert.equal(edited.log, undefined);

  store.answerCard(card.id, Rating.Good, T0);
  const answered = store.diffState(snapshot, current());
  assert.deepEqual(answered.daily, { [store.dayKey(T0)]: 1 });
  assert.ok(answered.log[store.dayKey(T0)][deck.id]);

  store.setSetting('theme', 'dark');
  assert.deepEqual(store.diffState(snapshot, current()).settings, { theme: 'dark' });
});

test("a given deck's content cannot be edited, but it can be studied and its reserve used", () => {
  store.importData(JSON.stringify({
    decks: [{ id: 'given', name: 'Words', assigned: true, from: 'Ana', newPerDay: 20 }],
    cards: ['one', 'two', 'three'].map((front, i) => ({ id: `g${i}`, deckId: 'given', front, back: '-', created: T0 + i, reserved: true, order: i })),
  }));
  const own = store.createDeck({ name: 'Mine' });
  assert.equal(store.editable('given'), false);
  assert.equal(store.editable(own.id), true);

  const readOnly = { message: 'read-only deck' };
  assert.throws(() => store.addCard('given', 'q', 'a', T0), readOnly);
  assert.throws(() => store.addCards('given', [['q', 'a']], T0), readOnly);
  assert.throws(() => store.updateCard('g0', { front: 'changed' }), readOnly);
  assert.throws(() => store.updateCard('g0', { deckId: own.id }), readOnly);
  assert.throws(() => store.deleteCard('g0'), readOnly);
  assert.throws(() => store.deleteCards(['g0']), readOnly);
  assert.throws(() => store.addReversed(['g0'], T0), readOnly);
  assert.throws(() => store.deleteDeck('given'), readOnly);
  for (const key of DECK_SHARED) assert.throws(() => store.updateDeck('given', { [key]: 'x' }), readOnly);
  assert.equal(store.card('g0').front, 'one');
  assert.equal(store.cardsIn('given').length, 3);
  assert.equal(store.decks().length, 2);

  // Moving one of your own cards into a given deck is refused too.
  const mine = store.addCard(own.id, 'q', 'a', T0);
  assert.throws(() => store.updateCard(mine.id, { deckId: 'given' }), readOnly);

  // Personal settings, the reserve and study all still work.
  store.updateDeck('given', { newPerDay: 5, speak: 'front' });
  assert.equal(store.deck('given').newPerDay, 5);
  store.reverseReserve('given');
  assert.deepEqual(store.reserveIn('given').map((c) => c.id), ['g2', 'g1', 'g0']);
  store.moveInReserve('given', ['g0'], { before: 'g2' });
  assert.equal(store.pullFromReserve('given', 1, T0), 1);
  assert.equal(store.pullCards(['g2'], T0 + 1), 1);
  assert.equal(store.returnToReserve(['g2'], T0 + 2), 1);
  store.answerCard(store.nextCard('given', T0 + 3).id, Rating.Good, T0 + 3);
  assert.equal(store.card('g0').reps, 1);
});

test('importing a topic file creates the topic once and joins its prefix group', () => {
  const deck = setup();
  const verbs = store.createGroup(deck.id, 'Verbs', T0);
  store.addCards(deck.id, [['to be', 'ser']], T0, { topicKey: 'verb_ser' });
  store.moveTopic(deck.id, store.deck(deck.id).topics[0].id, verbs.id, T0);
  store.addCards(deck.id, [['to go', 'ir']], T0, { topicKey: 'verb_ir' });
  store.addCards(deck.id, [['I am', 'sou']], T0, { topicKey: 'verb_ser' });
  const topics = store.deck(deck.id).topics;
  assert.equal(topics.length, 2);
  assert.ok(topics.every((t) => t.groupId === verbs.id));
  assert.ok(store.cardsIn(deck.id).every((c) => c.topicBy === 'file' && c.topicAt === T0));
  assert.equal(topics[0].name, 'Ser');
  assert.equal(topics[0].by, 'file');
});

test('groups and topics can be created, renamed, moved and deleted', () => {
  const deck = setup();
  const g = store.createGroup(deck.id, 'Food', T0);
  store.renameGroup(deck.id, g.id, 'Eating', T0 + 1);
  assert.equal(store.deck(deck.id).groups[0].name, 'Eating');
  const t = store.createTopic(deck.id, 'Cafe', g.id, T0 + 2);
  assert.equal(t.by, 'admin');
  store.renameTopic(deck.id, t.id, 'Cafe ordering', T0 + 3);
  store.moveTopic(deck.id, t.id, null, T0 + 4);
  assert.equal(store.deck(deck.id).topics[0].name, 'Cafe ordering');
  assert.equal(store.deck(deck.id).topics[0].groupId, null);
  store.moveTopic(deck.id, t.id, g.id, T0 + 5);
  store.deleteGroup(deck.id, g.id, T0 + 6);
  assert.equal(store.deck(deck.id).groups.length, 0);
  assert.equal(store.deck(deck.id).topics.length, 1);
  assert.equal(store.deck(deck.id).topics[0].groupId, null);
  assert.equal(store.deck(deck.id).topicsAt, T0 + 6);
});

test('deleting a topic makes its cards sortable again', () => {
  const deck = setup();
  store.addCards(deck.id, [['a', 'b'], ['c', 'd']], T0, { topicKey: 'verb_ser' });
  assert.equal(store.unsortedCount(deck.id), 0);
  store.deleteTopic(deck.id, store.deck(deck.id).topics[0].id, T0 + 5);
  assert.equal(store.deck(deck.id).topics.length, 0);
  assert.equal(store.unsortedCount(deck.id), 2);
  for (const c of store.cardsIn(deck.id)) {
    assert.ok(!('topic' in c) && !('topicBy' in c));
    assert.equal(c.topicAt, T0 + 5);
  }
});

test('deleting a topic or group remembers its id so a sync does not bring it back', () => {
  const deck = setup();
  const g = store.createGroup(deck.id, 'Verbs', T0);
  const t = store.createTopic(deck.id, 'Ser', g.id, T0);
  store.deleteTopic(deck.id, t.id, T0 + 1);
  store.deleteGroup(deck.id, g.id, T0 + 2);
  assert.deepEqual(store.deck(deck.id).deletedTopicIds, [t.id]);
  assert.deepEqual(store.deck(deck.id).deletedGroupIds, [g.id]);
  for (let i = 0; i < 510; i++) store.deleteTopic(deck.id, store.createTopic(deck.id, `x${i}`, null, T0).id, T0 + 3);
  const ids = store.deck(deck.id).deletedTopicIds;
  assert.equal(ids.length, 500);
  assert.ok(!ids.includes(t.id));   // the oldest are forgotten first
});

test('moving cards by hand marks them manual and they are not counted as unsorted', () => {
  const deck = setup();
  store.addCards(deck.id, [['a', 'b'], ['c', 'd']], T0);
  assert.equal(store.unsortedCount(deck.id), 2);
  const ids = store.cardsIn(deck.id).map((c) => c.id);
  assert.equal(store.setCardsTopic(ids, null, T0 + 1), 2);
  assert.equal(store.unsortedCount(deck.id), 0);
  assert.ok(store.cardsIn(deck.id).every((c) => c.topicBy === 'manual' && !('topic' in c)));
  const t = store.createTopic(deck.id, 'X', null, T0);
  store.setCardsTopic(ids, t.id, T0 + 2);
  assert.ok(store.cardsIn(deck.id).every((c) => c.topic === t.id && c.topicAt === T0 + 2));
});

test('clearing a moved card\'s topic leaves it sortable and stamps the time', () => {
  const deck = setup();
  store.addCards(deck.id, [['a', 'b']], T0, { topicKey: 'verb_ser' });
  const c = store.cardsIn(deck.id)[0];
  const other = store.createDeck({ name: 'Other' });
  store.updateCard(c.id, { deckId: other.id });
  store.clearCardTopic(c.id, T0 + 7);
  const moved = store.card(c.id);
  assert.ok(!('topic' in moved) && !('topicBy' in moved));
  assert.equal(moved.topicAt, T0 + 7);
  assert.equal(store.unsortedCount(other.id), 1);
});

test('topic edits on a given deck are refused', () => {
  store.importData(JSON.stringify({
    decks: [{ id: 'given', name: 'Words', assigned: true, from: 'Ana', newPerDay: 20, groups: [{ id: 'g1', name: 'G' }], topics: [{ id: 't1', key: 'a_b', name: 'B', groupId: null, by: 'file' }] }],
    cards: [{ id: 'g0', deckId: 'given', front: 'q', back: 'a', created: T0 }],
  }));
  const readOnly = { message: 'read-only deck' };
  assert.throws(() => store.createGroup('given', 'X', T0), readOnly);
  assert.throws(() => store.renameGroup('given', 'g1', 'X', T0), readOnly);
  assert.throws(() => store.deleteGroup('given', 'g1', T0), readOnly);
  assert.throws(() => store.ensureTopic('given', 'new_key', T0), readOnly);
  assert.throws(() => store.createTopic('given', 'X', null, T0), readOnly);
  assert.throws(() => store.renameTopic('given', 't1', 'X', T0), readOnly);
  assert.throws(() => store.moveTopic('given', 't1', null, T0), readOnly);
  assert.throws(() => store.deleteTopic('given', 't1', T0), readOnly);
  assert.throws(() => store.setCardsTopic(['g0'], 't1', T0), readOnly);
  assert.throws(() => store.addCards('given', [['q', 'a']], T0, { topicKey: 'a_b' }), readOnly);
});

test('topic edits never touch scheduling fields', () => {
  const deck = setup();
  store.addCards(deck.id, [['a', 'b']], T0, { topicKey: 'verb_ser' });
  const c = store.cardsIn(deck.id)[0];
  const sched = () => JSON.stringify(['due', 'state', 'ease', 'stability', 'difficulty', 'reps', 'lapses', 'scheduledDays'].map((k) => store.card(c.id)[k]));
  const before = sched();
  const t = store.createTopic(deck.id, 'Other', null, T0);
  store.setCardsTopic([c.id], t.id, T0 + 1);
  store.moveTopic(deck.id, t.id, null, T0 + 2);
  store.deleteTopic(deck.id, t.id, T0 + 3);
  assert.equal(sched(), before);
});

// ---- study, count and pull by topic ----

const topicId = (deckId, key) => store.deck(deckId).topics.find((t) => t.key === key).id;

test('a topic session shows only that topic and shares the daily new allowance', () => {
  const deck = setup({ newPerDay: 3 });
  store.addCards(deck.id, [['a', '1'], ['b', '2'], ['c', '3']], T0, { topicKey: 'verb_ser' });
  store.addCards(deck.id, [['d', '4'], ['e', '5']], T0, { topicKey: 'animals' });
  const ser = ['t:' + topicId(deck.id, 'verb_ser')];
  assert.equal(store.counts(deck.id, T0, ser).new, 3);
  for (let i = 0; i < 2; i++) store.answerCard(store.nextCard(deck.id, T0, ser).id, Rating.Good, T0);
  assert.equal(store.counts(deck.id, T0).new, 1);
  assert.equal(store.counts(deck.id, T0, ser).newLeft, 1);
});

test('the allowance is filled from the filtered topic even when other topics have older new cards', () => {
  const deck = setup({ newPerDay: 2 });
  store.addCards(deck.id, [['x1', ''], ['x2', ''], ['x3', '']], T0, { topicKey: 'animals' });
  store.addCards(deck.id, [['s1', ''], ['s2', ''], ['s3', '']], T0 + 10, { topicKey: 'verb_ser' });
  const ser = ['t:' + topicId(deck.id, 'verb_ser')];
  assert.equal(store.counts(deck.id, T0 + 20, ser).new, 2);
  const seen = [];
  for (let i = 0; i < 2; i++) {
    const c = store.nextCard(deck.id, T0 + 20, ser);
    seen.push(c.front);
    store.answerCard(c.id, Rating.Good, T0 + 20);
  }
  assert.deepEqual(seen, ['s1', 's2']);
  // The allowance is the deck's: it is used up for every topic now.
  assert.equal(store.counts(deck.id, T0 + 20).new, 0);
});

test('filtered counts are zero while deck counts are not', () => {
  const deck = setup();
  store.addCards(deck.id, [['a', '1']], T0, { topicKey: 'verb_ser' });
  store.addCards(deck.id, [['d', '4']], T0, { topicKey: 'animals' });
  const [ser, animals] = ['verb_ser', 'animals'].map((k) => ['t:' + topicId(deck.id, k)]);
  const card = store.nextCard(deck.id, T0, animals);
  store.answerCard(card.id, Rating.Easy, T0);
  const later = T0 + 40 * DAY;
  assert.equal(store.counts(deck.id, later, animals).review, 1);
  assert.equal(store.counts(deck.id, later, ser).review, 0);
  assert.equal(store.counts(deck.id, later, ser).new, 1);
  assert.equal(store.counts(deck.id, later, ser).cards, 2);
  assert.equal(store.counts(deck.id, later).total, 2);
  assert.equal(store.nextCard(deck.id, later, ser).front, 'a');
  assert.equal(store.counts(deck.id, T0, []).total, store.counts(deck.id, T0).total);
  // A group with no topics holds no cards, so it gives zero.
  const empty = store.createGroup(deck.id, 'Empty', T0);
  assert.equal(store.counts(deck.id, later, ['g:' + empty.id]).total, 0);
});

test('pulling by topic takes that topic in reserve order', () => {
  const deck = setup();
  store.addCards(deck.id, [['a1', ''], ['a2', ''], ['a3', '']], T0, { reserved: true, topicKey: 'x' });
  store.addCards(deck.id, [['b1', ''], ['b2', '']], T0, { reserved: true });
  const x = ['t:' + topicId(deck.id, 'x')];
  assert.equal(store.pullFromReserve(deck.id, 2, T0, x), 2);
  const pulled = store.cardsIn(deck.id).filter((c) => !c.reserved).map((c) => c.front).sort();
  assert.deepEqual(pulled, ['a1', 'a2']);
  assert.equal(store.counts(deck.id, T0).reserve, 3);
  assert.equal(store.pullFromReserve(deck.id, 1, T0, ['unsorted']), 1);
  assert.ok(!store.cardsIn(deck.id).find((c) => c.front === 'b1').reserved);
});

test('answering in a topic session schedules exactly as in a mixed one', () => {
  const run = (filtered) => {
    const deck = setup();
    store.addCards(deck.id, [['a', '1']], T0, { topicKey: 'verb_ser' });
    store.addCards(deck.id, [['b', '2']], T0, { topicKey: 'animals' });
    const f = filtered ? ['t:' + topicId(deck.id, 'verb_ser')] : undefined;
    const c = store.nextCard(deck.id, T0, f);
    store.answerCard(c.id, Rating.Good, T0);
    const { due, state, scheduledDays, stability, difficulty, reps, lapses } = store.card(c.id);
    return { front: c.front, due, state, scheduledDays, stability, difficulty, reps, lapses };
  };
  const mixed = run(false);
  const topic = run(true);
  assert.equal(mixed.front, topic.front);
  assert.deepEqual(topic, mixed);
});

test('findCards filters by topic and unsorted', () => {
  const deck = setup();
  store.addCards(deck.id, [['a', '1']], T0, { topicKey: 'verb_ser' });
  store.addCards(deck.id, [['b', '2']], T0, { topicKey: 'animals' });
  store.addCard(deck.id, 'loose', '3', T0);
  const ser = 't:' + topicId(deck.id, 'verb_ser');
  assert.deepEqual(store.findCards(deck.id, { topics: [ser] }, T0).map((c) => c.front), ['a']);
  assert.deepEqual(store.findCards(deck.id, { topics: ['unsorted'] }, T0).map((c) => c.front), ['loose']);
  assert.equal(store.findCards(deck.id, { topics: [ser, 'unsorted'] }, T0).length, 2);
  assert.equal(store.findCards(deck.id, {}, T0).length, 3);
});

test('a card whose topic is gone is unsorted everywhere', () => {
  store.importData(JSON.stringify({
    decks: [{ id: 'd', name: 'Words', newPerDay: 20, topics: [{ id: 't1', name: 'Ser', groupId: null, by: 'admin' }] }],
    cards: [
      { id: 'a', deckId: 'd', front: 'a', back: '1', created: T0, topic: 'gone', topicBy: 'ai', topicAt: T0 },
      { id: 'b', deckId: 'd', front: 'b', back: '2', created: T0 + 1, topic: 'gone', topicBy: 'manual', topicAt: T0 },
      { id: 'c', deckId: 'd', front: 'c', back: '3', created: T0 + 2, topic: 't1', topicBy: 'ai', topicAt: T0 },
    ],
  }));
  assert.deepEqual(store.findCards('d', { topics: ['unsorted'], sort: 'oldest' }, T0).map((c) => c.id), ['a', 'b']);
  assert.equal(store.counts('d', T0, ['unsorted']).new, 2);
  assert.equal(store.nextCard('d', T0, ['t:t1']).id, 'c');
  // Only the one nobody placed by hand waits for the sorter.
  assert.equal(store.unsortedCount('d'), 1);
  assert.deepEqual(store.topicCounts('d', T0).get(''), { due: 0, fresh: 2, reserve: 0 });
  assert.equal(store.topicCounts('d', T0).has('gone'), false);
});

test('topicCounts reports due, fresh and reserve per topic', () => {
  const deck = setup();
  store.addCards(deck.id, [['a', '1'], ['b', '2']], T0, { topicKey: 'verb_ser' });
  store.addCards(deck.id, [['r', '3']], T0, { topicKey: 'verb_ser', reserved: true });
  store.addCard(deck.id, 'loose', '3', T0);
  const m = store.topicCounts(deck.id, T0);
  assert.deepEqual(m.get(topicId(deck.id, 'verb_ser')), { due: 0, fresh: 2, reserve: 1 });
  assert.deepEqual(m.get(''), { due: 0, fresh: 1, reserve: 0 });
});

test('new decks default to FSRS at 90%', () => {
  assert.equal(store.DECK_DEFAULTS.scheduler, 'fsrs');
  assert.equal(store.DECK_DEFAULTS.retention, 0.9);
  const deck = store.createDeck({ name: 'Fresh' });
  assert.equal(deck.scheduler, 'fsrs');
  assert.equal(deck.retention, 0.9);
});

test('hiding and showing a deck', () => {
  const deck = setup();
  assert.equal(store.isHidden(deck), false);
  store.setHidden(deck.id, true);
  assert.equal(store.deck(deck.id).hidden, true);
  assert.equal(store.isHidden(store.deck(deck.id)), true);
  store.setHidden(deck.id, false);
  assert.equal('hidden' in store.deck(deck.id), false);
  assert.equal(store.isHidden(store.deck(deck.id)), false);
});

test('hidden is a personal deck field', () => {
  assert.equal(DECK_SHARED.includes('hidden'), false);
});

test('Urdu fields of a given deck cannot be edited', () => {
  store.importData(JSON.stringify({
    decks: [{ id: 'given', name: 'Words', assigned: true, from: 'Ana', newPerDay: 20 }],
    cards: [{ id: 'g0', deckId: 'given', front: 'one', back: '-', created: T0 }],
  }));
  assert.throws(() => store.updateCard('g0', { urdu: 'x' }), { message: 'read-only deck' });
});

test('folders can be created, renamed and deleted, and deleting moves decks back', () => {
  const a = setup();
  const b = store.createDeck({ name: 'Other' });
  const c = store.createDeck({ name: 'Third' });
  assert.deepEqual(store.folders(), []);
  const f = store.createFolder('  Textbooks  ');
  assert.equal(f.name, 'Textbooks');
  assert.deepEqual(store.folders(), [{ id: f.id, name: 'Textbooks' }]);
  store.renameFolder(f.id, ' Books ');
  assert.equal(store.folders()[0].name, 'Books');
  store.renameFolder('no-such-folder', 'Ignored');
  assert.equal(store.folders().length, 1);
  store.setDeckFolder(a.id, f.id);
  store.setDeckFolder(b.id, f.id);
  assert.equal(store.folderOf(store.deck(a.id)), f.id);
  assert.equal(store.folderOf(store.deck(c.id)), null);
  assert.equal(store.deleteFolder(f.id), 2);
  assert.equal(store.folderOf(store.deck(a.id)), null);
  assert.equal(store.folderOf(store.deck(b.id)), null);
  assert.equal('folder' in store.deck(a.id), false);
  assert.deepEqual(store.folders(), []);
  // Deleting a folder never deletes or hides a deck.
  assert.equal(store.decks().length, 3);
  assert.equal(store.decks().some(store.isHidden), false);
});

test('a folder name cannot be empty', () => {
  setup();
  assert.throws(() => store.createFolder('   '), { message: 'empty-name' });
  assert.deepEqual(store.folders(), []);
  const f = store.createFolder('Kept');
  assert.throws(() => store.renameFolder(f.id, ''), { message: 'empty-name' });
  assert.equal(store.folders()[0].name, 'Kept');
});

test('two folders may share a name', () => {
  setup();
  const one = store.createFolder('Same');
  const two = store.createFolder('Same');
  assert.notEqual(one.id, two.id);
  assert.deepEqual(store.folders().map((f) => f.name), ['Same', 'Same']);
});

test('a deck whose folder is gone counts as loose', () => {
  const deck = setup();
  store.updateDeck(deck.id, { folder: 'deleted-elsewhere' });
  assert.equal(store.folderOf(store.deck(deck.id)), null);
  assert.equal(store.folderOf(undefined), null);
  const groups = store.homeGroups(store.decks());
  assert.deepEqual(groups.loose.map((d) => d.id), [deck.id]);
  assert.deepEqual(groups.folders, []);
});

test('homeGroups puts hidden decks only under hidden, keeps folder order and empty folders', () => {
  const a = setup();
  const b = store.createDeck({ name: 'B' });
  const c = store.createDeck({ name: 'C' });
  const d = store.createDeck({ name: 'D' });
  const first = store.createFolder('First');
  const empty = store.createFolder('Empty');
  const last = store.createFolder('Last');
  store.setDeckFolder(b.id, last.id);
  store.setDeckFolder(c.id, first.id);
  store.setDeckFolder(d.id, first.id);
  store.setHidden(d.id, true);
  const groups = store.homeGroups(store.decks());
  assert.deepEqual(groups.folders.map((g) => [g.folder.id, g.decks.map((x) => x.id)]), [
    [first.id, [c.id]], [empty.id, []], [last.id, [b.id]],
  ]);
  assert.deepEqual(groups.loose.map((x) => x.id), [a.id]);
  assert.deepEqual(groups.hidden.map((x) => x.id), [d.id]);
  // Showing it again puts it back in its folder.
  store.setHidden(d.id, false);
  assert.deepEqual(store.homeGroups(store.decks()).folders[0].decks.map((x) => x.id), [c.id, d.id]);
});

test('reorderDecks orders decks within a folder and within the loose list', () => {
  const a = setup();
  const b = store.createDeck({ name: 'B' });
  const c = store.createDeck({ name: 'C' });
  const d = store.createDeck({ name: 'D' });
  const f = store.createFolder('F');
  store.setDeckFolder(c.id, f.id);
  store.setDeckFolder(d.id, f.id);
  store.reorderDecks([d.id, b.id, 'no-such-deck', c.id, a.id]);
  assert.equal(store.deck(d.id).homeOrder, 0);
  assert.equal(store.deck(c.id).homeOrder, 3);
  const groups = store.homeGroups(store.decks());
  assert.deepEqual(groups.folders[0].decks.map((x) => x.id), [d.id, c.id]);
  assert.deepEqual(groups.loose.map((x) => x.id), [b.id, a.id]);
});

test('decks without homeOrder sort after ordered ones, keeping their order', () => {
  const a = setup();
  const b = store.createDeck({ name: 'B' });
  const c = store.createDeck({ name: 'C' });
  const d = store.createDeck({ name: 'D' });
  store.reorderDecks([c.id]);
  assert.deepEqual(store.homeGroups(store.decks()).loose.map((x) => x.id), [c.id, a.id, b.id, d.id]);
});

test("reorderDecks never changes a deck's folder", () => {
  const a = setup();
  const b = store.createDeck({ name: 'B' });
  const f = store.createFolder('F');
  store.setDeckFolder(a.id, f.id);
  store.reorderDecks([b.id, a.id]);
  assert.equal(store.folderOf(store.deck(a.id)), f.id);
  assert.equal(store.folderOf(store.deck(b.id)), null);
});

test('homeOrder is a personal deck field', () => {
  assert.equal(DECK_SHARED.includes('homeOrder'), false);
  store.importData(JSON.stringify({
    decks: [{ id: 'given', name: 'Words', assigned: true, from: 'Ana', newPerDay: 20 }],
    cards: [],
  }));
  store.reorderDecks(['given']);
  assert.equal(store.deck('given').homeOrder, 0);
  store.updateDeck('given', { homeOrder: 4 });
  assert.equal(store.deck('given').homeOrder, 4);
});

test('folder is a personal deck field', () => {
  assert.equal(DECK_SHARED.includes('folder'), false);
  store.importData(JSON.stringify({
    decks: [{ id: 'given', name: 'Words', assigned: true, from: 'Ana', newPerDay: 20 }],
    cards: [],
  }));
  const f = store.createFolder('Given ones');
  store.setDeckFolder('given', f.id);
  assert.equal(store.deck('given').folder, f.id);
  store.setDeckFolder('given', null);
  assert.equal('folder' in store.deck('given'), false);
  store.updateDeck('given', { folder: f.id });
  assert.equal(store.folderOf(store.deck('given')), f.id);
});

test('a malformed folder list counts as no folders, and the home page still groups', () => {
  const deck = setup();
  store.setSetting('folders', 'x');
  assert.deepEqual(store.folders(), []);
  store.updateDeck(deck.id, { folder: 'f1' });
  assert.deepEqual(store.homeGroups(store.decks()).loose.map((d) => d.id), [deck.id]);
  store.setSetting('folders', [null, { id: 1 }, { id: 'f1', name: 'Kept' }, { id: 'f2' }]);
  assert.deepEqual(store.folders(), [{ id: 'f1', name: 'Kept' }]);
  const groups = store.homeGroups(store.decks());
  assert.deepEqual(groups.folders.map((g) => [g.folder.id, g.decks.map((d) => d.id)]), [['f1', [deck.id]]]);
  store.setSetting('folders', [null, { id: 1 }]);
  assert.deepEqual(store.homeGroups(store.decks()).folders, []);
  // A new folder can still be made over a bad list.
  assert.equal(store.createFolder('Fresh').name, 'Fresh');
});

test('at most 50 folders, with names cut to 80 characters', () => {
  setup();
  for (let i = 0; i < 50; i++) store.createFolder(`F${i}`);
  assert.throws(() => store.createFolder('One too many'), { message: 'too-many-folders' });
  assert.equal(store.folders().length, 50);
  store.reset();
  const f = store.createFolder(`  ${'n'.repeat(120)}  `);
  assert.equal(f.name, 'n'.repeat(80));
  store.renameFolder(f.id, 'r'.repeat(81));
  assert.equal(store.folders()[0].name, 'r'.repeat(80));
});

test('a deck filed into another folder goes to the end of it', () => {
  const a = setup();
  const b = store.createDeck({ name: 'B' });
  const c = store.createDeck({ name: 'C' });
  const f = store.createFolder('F');
  store.setDeckFolder(b.id, f.id);
  store.setDeckFolder(c.id, f.id);
  store.reorderDecks([a.id, b.id, c.id]);
  store.setDeckFolder(a.id, f.id);
  assert.equal(store.deck(a.id).homeOrder, undefined);
  assert.deepEqual(store.homeGroups(store.decks()).folders[0].decks.map((x) => x.id), [b.id, c.id, a.id]);
});

test("setDeckFolder to the same folder keeps the deck's place", () => {
  const a = setup();
  const b = store.createDeck({ name: 'B' });
  const f = store.createFolder('F');
  store.setDeckFolder(a.id, f.id);
  store.setDeckFolder(b.id, f.id);
  store.reorderDecks([b.id, a.id]);
  store.setDeckFolder(b.id, f.id);
  assert.equal(store.deck(b.id).homeOrder, 0);
  assert.deepEqual(store.homeGroups(store.decks()).folders[0].decks.map((x) => x.id), [b.id, a.id]);
});

test('deleting a folder puts its decks at the end of the loose list', () => {
  const a = setup();
  const b = store.createDeck({ name: 'B' });
  const c = store.createDeck({ name: 'C' });
  const f = store.createFolder('F');
  store.setDeckFolder(c.id, f.id);
  store.reorderDecks([c.id, a.id, b.id]);
  store.deleteFolder(f.id);
  assert.equal(store.deck(c.id).homeOrder, undefined);
  assert.deepEqual(store.homeGroups(store.decks()).loose.map((x) => x.id), [a.id, b.id, c.id]);
});
