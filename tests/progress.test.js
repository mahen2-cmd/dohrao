import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DAY, State } from '../js/fsrs.js';
import { cardStatus, dayKey, deckProgress, recentStudy, rightShare, streakOf } from '../js/progress.js';

const NOW = new Date(2026, 10, 12, 12).getTime(); // noon, so day keys are unambiguous

const card = (over) => ({ id: 'c', deckId: 'd', front: 'a', back: 'b', state: State.New, reps: 0, lapses: 0, scheduledDays: 0, ...over });

test('a card is on the reserve, waiting, learning, known well or struggling', () => {
  assert.equal(cardStatus(card({ reserved: true, order: 0 })), 'reserve');
  assert.equal(cardStatus(card({})), 'waiting');
  assert.equal(cardStatus(card({ state: State.Learning, reps: 1 })), 'learning');
  assert.equal(cardStatus(card({ state: State.Review, reps: 4, scheduledDays: 9 })), 'learning');
  assert.equal(cardStatus(card({ state: State.Review, reps: 6, scheduledDays: 21 })), 'known');
  // Forgetting a card three times makes it struggling, however long its interval.
  assert.equal(cardStatus(card({ state: State.Review, reps: 9, lapses: 3, scheduledDays: 30 })), 'struggling');
  assert.equal(cardStatus(card({ state: State.Relearning, reps: 5, lapses: 2 })), 'learning');
});

test('deck progress counts each status, and "learned" is every card answered at least once', () => {
  const cards = [
    card({ reserved: true }),
    card({ reserved: true }),
    card({}),
    card({ state: State.Learning, reps: 1 }),
    card({ state: State.Review, reps: 5, scheduledDays: 40 }),
    card({ state: State.Review, reps: 8, lapses: 4, scheduledDays: 2 }),
  ];
  assert.deepEqual(deckProgress(cards), { total: 6, reserve: 2, waiting: 1, learning: 1, known: 1, struggling: 1, learned: 3, pulledIn: 4 });
  assert.deepEqual(deckProgress([]), { total: 0, reserve: 0, waiting: 0, learning: 0, known: 0, struggling: 0, learned: 0, pulledIn: 0 });
});

test('the streak counts back from today, or from yesterday when today has no answers yet', () => {
  const key = (daysAgo) => dayKey(NOW - daysAgo * DAY);
  assert.deepEqual(streakOf({ [key(0)]: 5, [key(1)]: 3, [key(2)]: 1, [key(4)]: 9 }, NOW), { reviewedToday: 5, streak: 3 });
  assert.deepEqual(streakOf({ [key(1)]: 3, [key(2)]: 1 }, NOW), { reviewedToday: 0, streak: 2 });
  assert.deepEqual(streakOf({}, NOW), { reviewedToday: 0, streak: 0 });
});

test('recent study gives a day-by-day strip, days studied, answers and the last day studied', () => {
  const key = (daysAgo) => dayKey(NOW - daysAgo * DAY);
  const daily = { [key(0)]: 4, [key(2)]: 6, [key(20)]: 10, [key(40)]: 1 };
  const r = recentStudy(daily, NOW);
  assert.equal(r.last14.length, 14);
  assert.deepEqual(r.last14.slice(-3).map((d) => d.n), [6, 0, 4]);
  assert.equal(r.daysIn30, 3);
  assert.equal(r.answersIn7, 10);
  assert.equal(r.answersIn30, 20);
  assert.equal(r.lastStudied, key(0));
  assert.equal(recentStudy({}, NOW).lastStudied, null);
});

test('right share is the part of answers that were not Again, for one deck or all of them', () => {
  const key = dayKey(NOW);
  // Twelve counts per deck: Again, Hard, Good, Easy for learning, young and mature cards.
  const log = { [key]: { d1: [1, 0, 3, 0, 1, 1, 2, 0, 0, 0, 0, 0], d2: [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } };
  assert.equal(rightShare(log, 'd1', NOW), 0.75);
  assert.equal(rightShare(log, null, NOW), 6 / 12);
  assert.equal(rightShare({}, 'd1', NOW), null);
  // Answers older than 30 days are left out.
  assert.equal(rightShare({ [dayKey(NOW - 45 * DAY)]: { d1: [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } }, 'd1', NOW), null);
});

test('recent study ignores day keys that are not dates', () => {
  const key = (daysAgo) => dayKey(NOW - daysAgo * DAY);
  const daily = { [key(1)]: 3, 'invalid-date': 42, '9999-99-99': 100 };
  assert.equal(recentStudy(daily, NOW).lastStudied, key(1));
});
