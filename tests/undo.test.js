import test from 'node:test';
import assert from 'node:assert/strict';

import { createUndo } from '../js/undo.js';

test('undo hands back answers newest first, skipping any that cannot be restored', () => {
  const undo = createUndo();
  assert.equal(undo.size, 0);
  undo.record({ id: 'a' });
  undo.record({ id: 'gone' });
  undo.record({ id: 'b' });
  const restorable = (copy) => copy.id !== 'gone';
  assert.equal(undo.undo(restorable).id, 'b');
  assert.equal(undo.undo(restorable).id, 'a');
  assert.equal(undo.undo(restorable), null);
  assert.equal(undo.size, 0);
});

test('an undone card is not counted on its next answer, and is counted after that', () => {
  const undo = createUndo();
  assert.equal(undo.countAnswer('a'), true);
  undo.record({ id: 'a' });
  undo.undo(() => true);
  assert.equal(undo.countAnswer('a'), false);
  // The card comes back later in the session as a real new review.
  assert.equal(undo.countAnswer('a'), true);
});

test('undoing the same card twice still leaves its next answer uncounted', () => {
  const undo = createUndo();
  undo.record({ id: 'a' });
  undo.undo(() => true);
  undo.record({ id: 'a' }); // answered again, not counted
  assert.equal(undo.countAnswer('a'), false);
  undo.undo(() => true);
  assert.equal(undo.countAnswer('a'), false);
});
