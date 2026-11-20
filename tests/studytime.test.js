import test from 'node:test';
import assert from 'node:assert/strict';

import { createStudyClock, formatStudyTime, idleLimit, wordCount } from '../js/studytime.js';

test('idle limit grows with words and is capped', () => {
  assert.equal(idleLimit(0), 30_000);
  assert.equal(idleLimit(40), 40_000);
  assert.equal(idleLimit(10_000), 180_000);
});

test('wordCount counts words and ignores tags', () => {
  assert.equal(wordCount('<b>um</b> dois  três'), 3);
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount(null), 0);
  assert.equal(wordCount(undefined), 0);
});

test('steady input counts all time', () => {
  const clock = createStudyClock();
  clock.start(0, 0);
  clock.input(10_000);
  clock.input(20_000);
  assert.equal(clock.take(25_000), 25_000);
});

test('idle stops at the last input plus the limit', () => {
  const clock = createStudyClock();
  clock.start(0, 0);
  clock.input(5_000);
  assert.equal(clock.take(100_000), 35_000);
});

test('input after idle starts counting again', () => {
  const clock = createStudyClock();
  clock.start(0, 0);
  clock.input(100_000);
  assert.equal(clock.take(110_000), 40_000);
});

test('pause and resume credit only time in view', () => {
  const clock = createStudyClock();
  clock.start(0, 0);
  clock.pause(10_000);
  clock.input(3_600_000);
  assert.equal(clock.take(3_605_000), 15_000);
});

test('pause while idle credits nothing extra', () => {
  const clock = createStudyClock();
  clock.start(0, 0);
  clock.pause(60_000);
  assert.equal(clock.take(60_000), 30_000);
});

test('more words on screen allow a longer pause', () => {
  const clock = createStudyClock();
  clock.start(0, 0);
  clock.setWords(400);
  assert.equal(clock.take(200_000), 130_000);
});

test('take resets the clock', () => {
  const clock = createStudyClock();
  assert.equal(clock.take(5_000), 0);
  clock.start(0, 0);
  assert.equal(clock.take(10_000), 10_000);
  assert.equal(clock.take(20_000), 0);
});

test('formatStudyTime', () => {
  assert.equal(formatStudyTime(0), '0 min');
  assert.equal(formatStudyTime(45), '45 s');
  assert.equal(formatStudyTime(60), '1 min');
  assert.equal(formatStudyTime(1099), '18 min');
  assert.equal(formatStudyTime(7500), '2 h 5 min');
  assert.equal(formatStudyTime(7200), '2 h');
});
