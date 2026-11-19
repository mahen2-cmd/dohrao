import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_W7, nextInterval7, nextMemory7, retrievability7, seedMemory7 } from '../js/fsrs.js';

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
