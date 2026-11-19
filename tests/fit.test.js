import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { applyChanges } from '../server/sync.js';
import { newSchedule, DAY } from '../js/fsrs.js';
import { FIT_MIN_ANSWERS, reviewCsv, usableReviews } from '../server/fit.js';
import { fitWeights, heldOutSplit } from '../server/fit-model.js';

const NOW = Date.UTC(2026, 0, 1, 9);

const deckOf = (id) => ({ id, name: id, created: NOW });
const cardOf = (id, deckId) => ({ id, deckId, front: id, back: id, created: NOW, updated: NOW, ...newSchedule(NOW) });

async function seed() {
  const db = openDb(':memory:');
  const ana = await createUser(db, { username: 'ana', name: 'Ana', password: 'password-ana' }, NOW);
  const ben = await createUser(db, { username: 'ben', name: 'Ben', password: 'password-ben' }, NOW);
  applyChanges(db, ana.id, { decks: [deckOf('d1'), deckOf('d2')] }, NOW);
  return { db, ana: ana.id, ben: ben.id };
}

/**
 * Log `answersEach` answers for each of `count` new cards in `deckId` (cards made here), as a
 * person would give them: first New, then reviews at intervals growing ×2.5, about 15% Again.
 * With `firstState` other than 0 the card's first answer is missing from the log.
 */
function simulate(db, userId, deckId, count, answersEach, { prefix = deckId, firstState = 0, owner = userId } = {}) {
  const cards = Array.from({ length: count }, (_, i) => cardOf(`${prefix}-c${i}`, deckId));
  applyChanges(db, owner, { cards }, NOW);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const reviews = [];
  cards.forEach((card, c) => {
    let at = NOW + c * 60_000;
    let interval = 1;
    for (let k = 0; k < answersEach; k++) {
      const rating = rnd() < 0.15 ? 1 : 3;
      reviews.push({
        id: `${userId}-${card.id}-${k}`, cardId: card.id, deckId, at, rating,
        state: k === 0 ? firstState : 2, elapsed: k === 0 ? null : interval * DAY, duration: 3000,
        scheduler: 'fsrs', retention: 0.9, intervalBefore: 0, intervalAfter: 0,
      });
      interval = rating === 1 ? 1 : interval * 2.5;
      at += Math.round(interval * DAY);
    }
  });
  assert.deepEqual(applyChanges(db, userId, { reviews }, NOW), { rejected: [] });
  return cards;
}

test('only usable answers are counted', async () => {
  const { db, ana } = await seed();
  simulate(db, ana, 'd1', 2, 4);
  simulate(db, ana, 'd1', 3, 4, { prefix: 'old', firstState: 2 });
  assert.equal(usableReviews(db, ana, 'd1').length, 8);
});

test('cards without their first answer are left out', async () => {
  const { db, ana } = await seed();
  simulate(db, ana, 'd1', 1, 3);
  simulate(db, ana, 'd1', 1, 3, { prefix: 'old', firstState: 2 });
  const rows = usableReviews(db, ana, 'd1');
  assert.deepEqual([...new Set(rows.map((r) => r.cardId))], ['d1-c0']);
  assert.deepEqual(rows.map((r) => r.state), [0, 2, 2]);
  assert.ok(rows.every((r, i) => i === 0 || r.at > rows[i - 1].at));
});

test('answers count for the deck a card is in now', async () => {
  const { db, ana } = await seed();
  const [card] = simulate(db, ana, 'd1', 1, 3);
  applyChanges(db, ana, { cards: [{ ...card, deckId: 'd2' }] }, NOW);
  assert.equal(usableReviews(db, ana, 'd1').length, 0);
  assert.equal(usableReviews(db, ana, 'd2').length, 3);
});

test('another person\'s answers are never used', async () => {
  const { db, ana, ben } = await seed();
  db.prepare('INSERT INTO assignments (deck_id, user_id, active, assigned) VALUES (?, ?, 1, ?)').run('d1', ben, NOW);
  simulate(db, ben, 'd1', 2, 3, { owner: ana });
  assert.equal(usableReviews(db, ana, 'd1').length, 0);
  assert.equal(usableReviews(db, ben, 'd1').length, 6);
});

test('the CSV has the optimizer\'s columns', async () => {
  const { db, ana } = await seed();
  simulate(db, ana, 'd1', 2, 2);
  const lines = new TextDecoder().decode(reviewCsv(usableReviews(db, ana, 'd1'))).split('\n');
  assert.equal(lines[0], 'card_id,review_time,review_rating,review_state,review_duration');
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.slice(1).map((l) => l.split(',')[0]), ['1', '1', '2', '2']);
  assert.equal(lines[1], `1,${NOW},${lines[1].split(',')[2]},0,3000`);
});

test('fitting refuses below 1,000 answers', async () => {
  assert.equal(FIT_MIN_ANSWERS, 1000);
  const { db, ana } = await seed();
  simulate(db, ana, 'd1', 333, 3);
  const reviews = usableReviews(db, ana, 'd1');
  assert.equal(reviews.length, 999);
  await assert.rejects(fitWeights({ reviews, timezone: 'Europe/Lisbon' }), /not-enough-answers/);
});

test('a fit on enough answers beats the defaults', async () => {
  const { db, ana } = await seed();
  simulate(db, ana, 'd1', 250, 6);
  const reviews = usableReviews(db, ana, 'd1');
  const { fsrs6, fsrs7 } = await fitWeights({ reviews, timezone: 'Europe/Lisbon' });
  for (const [result, length] of [[fsrs6, 21], [fsrs7, 34]]) {
    assert.equal(result.kept, true);
    assert.equal(result.params.length, length);
    assert.ok(result.params.every(Number.isFinite));
    assert.ok(result.improvement > 0, `${result.improvement}`);
  }
});

test('a fit is not kept when the current weights are already better', async () => {
  const { db, ana } = await seed();
  simulate(db, ana, 'd1', 250, 6);
  const reviews = usableReviews(db, ana, 'd1');
  const first = await fitWeights({ reviews, timezone: 'Europe/Lisbon' });
  const again = await fitWeights({ reviews, timezone: 'Europe/Lisbon', current6: first.fsrs6.params, current7: first.fsrs7.params });
  for (const result of [again.fsrs6, again.fsrs7]) {
    assert.equal(typeof result.kept, 'boolean');
    if (result.kept) assert.ok(result.improvement > 0);
  }
  assert.ok([again.fsrs6, again.fsrs7].some((r) => !r.kept || r.improvement <= 1));
});

test('the server can load without loading the optimizer', async () => {
  const { spawnSync } = await import('node:child_process');
  // The optimizer is WASI, which Node announces when it loads; only fit workers should load it.
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./server.js'); await import('./server/fit.js');"], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /WASI/);
});

/**
 * Answers whose forgetting changes halfway: a tenth forgotten at first, then nearly half. Weights
 * fitted to the first half are wrong for the second, as a person's would be after a change.
 */
function changingAnswers(cards, each) {
  const reviews = [];
  for (let c = 0; c < cards; c++) {
    let at = NOW + c * 60_000;
    let days = 1;
    for (let k = 0; k < each; k++) {
      const late = c >= cards / 2;
      const rating = (c * 7 + k * 13) % 100 < (late ? 45 : 10) ? 1 : 3;
      reviews.push({ cardId: `c${c}`, at: at + (late ? 500 * DAY : 0), rating, state: k ? 2 : 0, duration: 3000 });
      days = rating === 1 ? 1 : days * 2.5;
      at += Math.round(days * DAY);
    }
  }
  return reviews;
}

test('the fit and the current weights are judged on the same latest answers', () => {
  const csv = reviewCsv(changingAnswers(300, 6));
  for (const model of ['FSRS-6', 'FSRS-7']) {
    const { train, test, all } = heldOutSplit(csv, 'Europe/Lisbon', model);
    assert.equal(train.length + test.length, all.length);
    assert.ok(test.length >= all.length * 0.1 && test.length <= all.length * 0.35, `${test.length} of ${all.length}`);
  }
});

test('a refit is kept when the current weights no longer fit recent answers', async () => {
  const all = changingAnswers(600, 6);
  const early = all.filter((r) => r.at < NOW + 400 * DAY);
  const first = await fitWeights({ reviews: early, timezone: 'Europe/Lisbon' });
  const current6 = first.fsrs6.kept ? first.fsrs6.params : undefined;
  const current7 = first.fsrs7.kept ? first.fsrs7.params : undefined;
  const again = await fitWeights({ reviews: all, timezone: 'Europe/Lisbon', current6, current7 });
  for (const result of [again.fsrs6, again.fsrs7]) {
    assert.equal(result.kept, true);
    assert.ok(result.improvement >= 1, `${result.improvement}`);
  }
});

test('a fit is never kept with an improvement under 1%', async () => {
  const reviews = changingAnswers(300, 6);
  const first = await fitWeights({ reviews, timezone: 'Europe/Lisbon' });
  const again = await fitWeights({ reviews, timezone: 'Europe/Lisbon', current6: first.fsrs6.params, current7: first.fsrs7.params });
  for (const result of [first.fsrs6, first.fsrs7, again.fsrs6, again.fsrs7]) {
    if (result.kept) assert.ok(result.improvement >= 1, `${result.improvement}`);
  }
});
