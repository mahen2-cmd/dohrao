import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Rating } from '../js/fsrs.js';
import { classifySwipe, inTab, tabFilters } from '../js/phone.js';

const NO = { groups: [], due: 'any', added: 'any', lapses: 'any', topics: [], sort: 'newest' };

test('the Reserve tab lists the reserve in pull-in order, whatever the filters', () => {
  const f = { ...NO, groups: ['due'], sort: 'newest' };
  assert.deepEqual(tabFilters(f, 'reserve'), { ...NO, groups: ['reserve'], sort: 'reserve' });
  assert.deepEqual(f, { ...NO, groups: ['due'], sort: 'newest' }); // not mutated
});

test('the Cards tab drops the reserve chip and keeps the other filters', () => {
  assert.deepEqual(tabFilters({ ...NO, groups: ['due', 'reserve'], sort: 'due' }, 'cards').groups, ['due']);
  assert.equal(tabFilters({ ...NO, sort: 'due' }, 'cards').sort, 'due');
  assert.equal(inTab({ reserved: true }, 'cards'), false);
  assert.equal(inTab({ reserved: false }, 'cards'), true);
  assert.equal(inTab({ reserved: true }, 'reserve'), true);
  assert.equal(inTab({ reserved: false }, 'reserve'), false);
});

test('a swipe past the threshold rates; short of it, nothing', () => {
  const box = { width: 300, height: 500, verticalAllowed: true };
  assert.equal(classifySwipe({ ...box, dx: 95, dy: 10 }), Rating.Good);
  assert.equal(classifySwipe({ ...box, dx: -95, dy: 10 }), Rating.Again);
  assert.equal(classifySwipe({ ...box, dx: 5, dy: -115 }), Rating.Easy);
  assert.equal(classifySwipe({ ...box, dx: 5, dy: 115 }), Rating.Hard);
  assert.equal(classifySwipe({ ...box, dx: 80, dy: 0 }), null);
});

test('the axis that moved more decides, and vertical can be switched off', () => {
  const box = { width: 300, height: 500 };
  assert.equal(classifySwipe({ ...box, verticalAllowed: true, dx: 100, dy: 120 }), Rating.Hard);
  assert.equal(classifySwipe({ ...box, verticalAllowed: true, dx: 130, dy: 120 }), Rating.Good);
  assert.equal(classifySwipe({ ...box, verticalAllowed: false, dx: 5, dy: 200 }), null);
  assert.equal(classifySwipe({ ...box, verticalAllowed: false, dx: 100, dy: 120 }), Rating.Good);
});
