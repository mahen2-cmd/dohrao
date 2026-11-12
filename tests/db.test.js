import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/db.js';
import { CARD_CONTENT, split } from '../server/fields.js';

test('opens an in-memory db with every table', () => {
  const db = openDb(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['users', 'sessions', 'invites', 'decks', 'deck_prefs', 'cards', 'progress', 'assignments', 'user_state']) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
});

test('deleting a deck cascades to its cards and progress', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users VALUES ('u1', 'ann', 'Ann', 'x', 'user', 1)").run();
  db.prepare("INSERT INTO decks VALUES ('d1', 'u1', '{}')").run();
  db.prepare("INSERT INTO cards VALUES ('c1', 'd1', '{}')").run();
  db.prepare("INSERT INTO progress VALUES ('u1', 'c1', '{}')").run();
  db.prepare("DELETE FROM decks WHERE id = 'd1'").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cards').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress').get().n, 0);
});

test('split separates content from progress', () => {
  const [content, progress] = split({ id: 'c1', deckId: 'd1', front: 'a', back: 'b', created: 1, due: 5, reserved: true }, CARD_CONTENT);
  assert.deepEqual(content, { front: 'a', back: 'b', created: 1 });
  assert.deepEqual(progress, { due: 5, reserved: true });
});
