import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY,
  DEFAULT_W7,
  MINUTE,
  State,
  newSchedule,
  nextInterval7,
  nextMemory7,
  preview,
  retrievability7,
  schedule,
  seedMemory7,
} from '../js/fsrs.js';

// fsrs-rs works in f32, so compare its numbers with a relative tolerance.
const close = (a, b, eps = 1e-4) =>
  assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} !~ ${b}`);

test('fsrs7: there are 34 default weights', () => {
  assert.equal(DEFAULT_W7.length, 34);
});

test('fsrs7: first answers match fsrs-rs', () => {
  // From the fsrs-rs v7.0.0 doc test for next_states (inference.rs).
  const expected = {
    1: { s: 0.1104, d: 6.1686, sf: 0.08832, interval: 3.8275626e-5 },
    2: { s: 2.2395, d: 5.261278, sf: 1.7916001, interval: 0.5974598 },
    3: { s: 3.9221, d: 3.5307243, sf: 3.13768, interval: 4.7777247 },
    4: { s: 11.7841, d: 1.0, sf: 9.427279, interval: 53.869392 },
  };
  for (const g of [1, 2, 3, 4]) {
    const m = nextMemory7(null, g, 0);
    close(m.stability, expected[g].s);
    close(m.difficulty, expected[g].d);
    close(m.stabilityFast, expected[g].sf);
    close(nextInterval7(m, 0.9), expected[g].interval, 1e-3);
  }
});

const MEMORY = { stability: 10, stabilityFast: 8, difficulty: 5 };

test('fsrs7: recall falls over time and stays inside (0, 1)', () => {
  const rs = [0, 0.01, 1, 10, 100].map((t) => retrievability7(t, MEMORY));
  assert.ok(rs[0] < 1);
  for (let i = 1; i < rs.length; i++) assert.ok(rs[i] < rs[i - 1], `${rs[i]} not below ${rs[i - 1]}`);
  for (const r of rs) assert.ok(r > 0);
});

test('fsrs7: interval gives the desired retention', () => {
  let last = Infinity;
  for (const r of [0.8, 0.9, 0.95]) {
    const t = nextInterval7(MEMORY, r);
    close(retrievability7(t, MEMORY), r, 1e-3);
    assert.ok(t < last);
    last = t;
  }
});

test('fsrs7: same-day Good raises stability, and a later Good raises it more', () => {
  const m = nextMemory7(null, 3, 0);
  const sameDay = nextMemory7(m, 3, 10 / 1440);
  const later = nextMemory7(m, 3, 4);
  assert.ok(sameDay.stability > m.stability);
  assert.ok(later.stability > sameDay.stability);
});

test('fsrs7: Again lowers stability and caps fast stability', () => {
  const m = { stability: 20, stabilityFast: 15, difficulty: 5 };
  const next = nextMemory7(m, 1, 20);
  assert.ok(next.stability < 20);
  assert.ok(next.stabilityFast <= 0.8 * next.stability + 1e-12);
});

test('fsrs7: difficulty stays within 1..10', () => {
  let m = nextMemory7(null, 3, 0);
  for (const g of [...Array(50).fill(1), ...Array(50).fill(4)]) {
    m = nextMemory7(m, g, 1);
    assert.ok(m.difficulty >= 1 && m.difficulty <= 10, `${m.difficulty}`);
  }
});

test('fsrs7: seeding hits 90% at the old stability', () => {
  for (const s6 of [1, 30, 100]) {
    const m = seedMemory7(s6, 6);
    assert.equal(m.difficulty, 6);
    close(m.stabilityFast / m.stability, 0.8);
    close(retrievability7(s6, m), 0.9, 1e-3);
  }
});

// ---- Scheduling with FSRS-7 --------------------------------------------------

const T0 = new Date(2026, 0, 1, 9, 0, 0).getTime();
const FIELDS7 = ['stability7', 'stabilityFast7', 'difficulty7'];

/** Review a fresh card with the given ratings, each exactly when it is due. */
function run(ratings, options, { drop7 = false } = {}) {
  let card = newSchedule(T0);
  let now = T0;
  for (const r of ratings) {
    if (drop7) for (const k of FIELDS7) delete card[k];
    card = schedule(card, r, now, options);
    now = card.due;
  }
  return card;
}

test('newSchedule includes the FSRS-7 fields', () => {
  const card = newSchedule(T0);
  for (const k of FIELDS7) assert.equal(card[k], 0, k);
});

test('fsrs7: learning steps are unchanged', () => {
  const offsets = (scheduler) => {
    const p = preview(newSchedule(T0), T0, { scheduler });
    return [1, 2, 3].map((g) => [p[g].state, p[g].due - T0, p[g].left]);
  };
  assert.deepEqual(offsets('fsrs7'), offsets('fsrs'));
  assert.deepEqual(offsets('fsrs7').map(([, ms]) => ms / MINUTE), [1, 5.5, 10]);
});

test('fsrs7: graduating and review intervals are whole days, ordered hard < good < easy', () => {
  const card = run([3, 3, 3], { scheduler: 'fsrs7' });
  assert.equal(card.state, State.Review);
  const p = preview(card, card.due, { scheduler: 'fsrs7' });
  const days = [2, 3, 4].map((g) => p[g].scheduledDays);
  for (const d of days) assert.ok(Number.isInteger(d) && d >= 1, `${d}`);
  assert.ok(days[0] < days[1] && days[1] < days[2], `${days}`);
});

test('fsrs7: same-day answers update FSRS-7 memory', () => {
  const first = schedule(newSchedule(T0), 3, T0, { scheduler: 'fsrs7' });
  const second = schedule(first, 3, first.due, { scheduler: 'fsrs7' });
  assert.ok(second.stability7 > 0);
  assert.notEqual(second.stability7, first.stability7);
  // An answer a minute later and one ten minutes later are told apart.
  const sooner = schedule(first, 3, T0 + MINUTE, { scheduler: 'fsrs7' });
  assert.notEqual(sooner.stability7, second.stability7);
});

test('fsrs7: higher retention gives shorter intervals', () => {
  const card = run([3, 3, 3, 3, 3], { scheduler: 'fsrs7' });
  assert.ok(card.scheduledDays >= 10, `${card.scheduledDays}`);
  const good = (retention) => preview(card, card.due, { scheduler: 'fsrs7', retention })[3].scheduledDays;
  assert.ok(good(0.95) < good(0.85));
});

const oldReview = (over) => ({
  ...newSchedule(T0),
  state: State.Review,
  stability: 30,
  difficulty: 6,
  scheduledDays: 30,
  lastReview: T0,
  reps: 5,
  due: T0 + 30 * DAY,
  ...over,
});

test('fsrs7: an old card is seeded from its FSRS-6 memory', () => {
  const card = oldReview();
  for (const k of FIELDS7) delete card[k];
  const good = preview(card, T0 + 30 * DAY, { scheduler: 'fsrs7' })[3];
  assert.ok(Number.isFinite(good.stability7) && good.stability7 > 0);
  assert.ok(good.scheduledDays > 30, `${good.scheduledDays}`);
});

test('fsrs7: a card with no FSRS-6 memory starts fresh', () => {
  const card = oldReview({ stability: 0, difficulty: 0 });
  for (const k of FIELDS7) delete card[k];
  const p = preview(card, T0 + 30 * DAY, { scheduler: 'fsrs7' });
  for (const g of [1, 2, 3, 4]) {
    assert.ok(Number.isFinite(p[g].stability7) && p[g].stability7 > 0, `${g}: ${p[g].stability7}`);
    assert.ok(Number.isFinite(p[g].scheduledDays), `${g}: ${p[g].scheduledDays}`);
  }
});

test('all three memories are kept in every mode', () => {
  for (const scheduler of ['sm2', 'fsrs', 'fsrs7']) {
    const card = run([3, 3, 3], { scheduler });
    assert.ok(card.stability > 0, scheduler);
    assert.ok(card.stability7 > 0, scheduler);
    assert.ok(card.difficulty7 >= 1 && card.difficulty7 <= 10, scheduler);
    assert.ok(card.ease > 0, scheduler);
  }
});

test('fsrs and sm2 schedules are unchanged by FSRS-7', () => {
  const pick = (c) => [c.due, c.scheduledDays, c.stability, c.difficulty, c.ease];
  for (const scheduler of ['fsrs', 'sm2']) {
    const ratings = [3, 3, 3, 2, 1, 3];
    assert.deepEqual(pick(run(ratings, { scheduler })), pick(run(ratings, { scheduler }, { drop7: true })), scheduler);
  }
});

test('fsrs7: intervals come from FSRS-7, not FSRS-6', () => {
  // FSRS-7's Easy on a new card is 53.87 days (fsrs-rs); FSRS-6's is 8.
  assert.equal(preview(newSchedule(T0), T0, { scheduler: 'fsrs7' })[4].scheduledDays, 54);
  assert.equal(preview(newSchedule(T0), T0, { scheduler: 'fsrs' })[4].scheduledDays, 8);
});

test('fsrs7: a fixed Easy interval is never shorter than Good', () => {
  // New decks fix Easy at 4 days, but FSRS-7's first Good is about 5 days.
  const p = preview(newSchedule(T0), T0, { scheduler: 'fsrs7', easyInterval: 4 });
  const first = schedule(newSchedule(T0), 3, T0, { scheduler: 'fsrs7', easyInterval: 4 });
  const q = preview(first, first.due, { scheduler: 'fsrs7', easyInterval: 4 });
  assert.ok(q[4].scheduledDays > q[3].scheduledDays, `easy ${q[4].scheduledDays} good ${q[3].scheduledDays}`);
  assert.equal(p[4].scheduledDays >= 4, true);
});

test('fsrs7: given weights are used', () => {
  const w7 = [...DEFAULT_W7];
  w7[3] = 20; // initial stability for Easy
  const plain = preview(newSchedule(T0), T0, { scheduler: 'fsrs7' })[4];
  const fitted = preview(newSchedule(T0), T0, { scheduler: 'fsrs7', w7 })[4];
  assert.ok(fitted.scheduledDays > plain.scheduledDays, `${fitted.scheduledDays} vs ${plain.scheduledDays}`);
  assert.equal(fitted.stability7, 20);
});
