import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { buildView } from '../server/sync.js';
import { switchToFsrs } from '../scripts/switch-to-fsrs.js';

const NOW = 1_700_000_000_000;

/**
 * Owner Ana with two decks: d1 has her prefs on SM-2 and is given to Ben (who saved his own
 * SM-2 prefs) and to Cal (no prefs row, assignment taken back); d2 keeps scheduler in its data
 * from the old JSON migration and has no prefs row at all.
 */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'recall-fsrs-'));
  const file = join(dir, 'recall.db');
  const db = openDb(file);
  const ana = await createUser(db, { username: 'ana', name: 'Ana', password: 'password-ana', role: 'admin' }, NOW);
  const ben = await createUser(db, { username: 'ben', name: 'Ben', password: 'password-ben' }, NOW);
  const cal = await createUser(db, { username: 'cal', name: 'Cal', password: 'password-cal' }, NOW);
  const deck = db.prepare('INSERT INTO decks (id, owner_id, data) VALUES (?, ?, ?)');
  deck.run('d1', ana.id, JSON.stringify({ name: 'Kalman', created: NOW }));
  deck.run('d2', ana.id, JSON.stringify({ name: 'Old', created: NOW, scheduler: 'sm2', retention: 0.85 }));
  const assign = db.prepare('INSERT INTO assignments (deck_id, user_id, active, assigned) VALUES (?, ?, ?, ?)');
  assign.run('d1', ben.id, 1, NOW);
  assign.run('d1', cal.id, 0, NOW);
  const prefs = db.prepare('INSERT INTO deck_prefs (user_id, deck_id, data) VALUES (?, ?, ?)');
  prefs.run(ana.id, 'd1', JSON.stringify({ scheduler: 'sm2', retention: 0.9, newPerDay: 7 }));
  prefs.run(ben.id, 'd1', JSON.stringify({ scheduler: 'sm2', retention: 0.8, fsrsParams: [1, 2, 3], speak: 'back' }));
  return { dir, file, db, ana, ben, cal };
}

const deckIn = (db, userId, deckId) => buildView(db, userId, NOW).decks.find((d) => d.id === deckId);
const prefsOf = (db, userId, deckId) =>
  JSON.parse(db.prepare('SELECT data FROM deck_prefs WHERE user_id = ? AND deck_id = ?').get(userId, deckId)?.data ?? 'null');

test('switches own decks and given decks', async () => {
  const { dir, db, ana, ben } = await setup();
  try {
    switchToFsrs(db);
    for (const [user, deckId] of [[ana, 'd1'], [ana, 'd2'], [ben, 'd1']]) {
      const d = deckIn(db, user.id, deckId);
      assert.equal(d.scheduler, 'fsrs', `${user.username} ${deckId}`);
      assert.equal(d.retention, 0.9, `${user.username} ${deckId}`);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('switches a recipient with no prefs row, even when the deck was taken back', async () => {
  const { dir, db, cal } = await setup();
  try {
    switchToFsrs(db);
    assert.deepEqual(prefsOf(db, cal.id, 'd1'), { scheduler: 'fsrs', retention: 0.9 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rewrites scheduler kept in deck data', async () => {
  const { dir, db } = await setup();
  try {
    switchToFsrs(db);
    const data = JSON.parse(db.prepare("SELECT data FROM decks WHERE id = 'd2'").get().data);
    assert.equal(data.scheduler, 'fsrs');
    assert.equal(data.retention, 0.9);
    assert.equal(data.name, 'Old');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps other prefs', async () => {
  const { dir, db, ana, ben } = await setup();
  try {
    switchToFsrs(db);
    assert.deepEqual(prefsOf(db, ana.id, 'd1'), { scheduler: 'fsrs', retention: 0.9, newPerDay: 7 });
    assert.deepEqual(prefsOf(db, ben.id, 'd1'), { scheduler: 'fsrs', retention: 0.9, fsrsParams: [1, 2, 3], speak: 'back' });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('counts each person and deck once, and is idempotent', async () => {
  const { dir, db } = await setup();
  try {
    // Ana's two decks, Ben's and Cal's copies of d1.
    assert.deepEqual(switchToFsrs(db), { changed: 4, already: 0 });
    assert.deepEqual(switchToFsrs(db), { changed: 0, already: 4 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dry run reports the same counts and writes nothing', async () => {
  const { dir, file, db } = await setup();
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = readFileSync(file);
    const dump = () => JSON.stringify([
      db.prepare('SELECT * FROM decks ORDER BY id').all(),
      db.prepare('SELECT * FROM deck_prefs ORDER BY user_id, deck_id').all(),
    ]);
    const rows = dump();
    assert.deepEqual(switchToFsrs(db, { dryRun: true }), { changed: 4, already: 0 });
    assert.equal(dump(), rows);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.ok(readFileSync(file).equals(before));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
