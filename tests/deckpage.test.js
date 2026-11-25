import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampAmount, ownTicks, pruneTicks, pullAllLabel, pullPreview } from '../js/deckpage.js';

test('the amount stays within what the queue holds', () => {
  assert.equal(clampAmount(10, 3), 3);
  assert.equal(clampAmount(0, 3), 1);
  assert.equal(clampAmount(2.6, 9), 3);
  assert.equal(clampAmount(NaN, 40), 10);
  assert.equal(clampAmount(5, 0), 0);
});

test('the preview numbers every card and marks the next n', () => {
  const q = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const { place, next } = pullPreview(q, 2);
  assert.deepEqual([...place], [['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
  assert.deepEqual([...next], ['a', 'b']);
  assert.deepEqual([...pullPreview(q, 99).next], ['a', 'b', 'c', 'd']);
  assert.equal(pullPreview([], 10).next.size, 0);
});

test('a search keeps real places: shown rows tint only if among the next n', () => {
  const q = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const { place, next } = pullPreview(q, 2);
  const shown = [q[1], q[3]]; // a search matched b and d
  assert.deepEqual(shown.map((c) => [place.get(c.id), next.has(c.id)]), [[2, true], [4, false]]);
});

test('Pull all says how many, and from which topic', () => {
  assert.equal(pullAllLabel(1465), 'Pull all 1,465');
  assert.equal(pullAllLabel(212, 'Verbs'), 'Pull all 212 from Verbs');
});

test('each column acts only on its own ticked cards', () => {
  const cards = [{ id: 'r', reserved: true }, { id: 's', reserved: false }, { id: 'gone', reserved: false }];
  const ticked = new Set(['r', 's', 'x']);
  const shown = cards.slice(0, 2);
  assert.deepEqual(ownTicks(ticked, shown, 'reserve'), ['r']);
  assert.deepEqual(ownTicks(ticked, shown, 'cards'), ['s']);
});

test('a list clears its own ticks that are no longer shown, and keeps the other list\'s', () => {
  const all = { r1: { id: 'r1', reserved: true }, r2: { id: 'r2', reserved: true }, s1: { id: 's1', reserved: false } };
  const ticked = new Set(['r1', 'r2', 's1', 'deleted']);
  pruneTicks(ticked, [all.r1], 'reserve', (id) => all[id]);
  assert.deepEqual([...ticked].sort(), ['r1', 's1']);
  const everything = new Set(['r1', 's1']);
  pruneTicks(everything, [all.s1], 'all', (id) => all[id]);
  assert.deepEqual([...everything], ['s1']);
});
