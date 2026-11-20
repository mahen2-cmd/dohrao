import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { CARD_CONTENT, split } from '../server/fields.js';

test('opens an in-memory db with every table', () => {
  const db = openDb(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['users', 'sessions', 'invites', 'decks', 'deck_prefs', 'cards', 'progress', 'assignments', 'user_state']) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
});

test('an old database gets the assignment Urdu columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-db-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE assignments (deck_id TEXT NOT NULL, user_id TEXT NOT NULL, active INTEGER NOT NULL, assigned INTEGER NOT NULL, PRIMARY KEY (deck_id, user_id))');
    old.close();
    for (let i = 0; i < 2; i++) {
      const db = openDb(file); // twice: the migration is idempotent
      const cols = db.prepare('PRAGMA table_info(assignments)').all().map((c) => c.name);
      assert.ok(cols.includes('urdu') && cols.includes('urdu_at'));
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an older database gains the time column', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-db-'));
  const file = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE user_state (user_id TEXT PRIMARY KEY, daily TEXT NOT NULL, log TEXT NOT NULL, settings TEXT NOT NULL, saved_at INTEGER NOT NULL)');
    old.exec("INSERT INTO user_state VALUES ('u1', '{}', '{}', '{}', 0)");
    old.close();
    for (let i = 0; i < 2; i++) {
      const db = openDb(file); // twice: the migration is idempotent
      assert.equal(db.prepare("SELECT time FROM user_state WHERE user_id = 'u1'").get().time, '{}');
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
