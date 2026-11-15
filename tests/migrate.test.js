import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../server/db.js';
import { buildView } from '../server/sync.js';
import { newSchedule } from '../js/fsrs.js';
import { DECK_DEFAULTS } from '../js/store.js';
import { migrateJson } from '../scripts/migrate-json.js';

const NOW = 1_700_000_000_000;

const fixture = () => ({
  version: 1,
  savedAt: NOW + 9,
  daily: { '2023-11-01': 12 },
  log: { '2023-11-01': { new: 3, review: 9 } },
  settings: { dayStart: 4 },
  decks: [
    { ...DECK_DEFAULTS, id: 'd1', name: 'Spanish', created: NOW, ankiId: 77, scheduler: 'fsrs' },
    { ...DECK_DEFAULTS, id: 'd2', name: 'Maths', created: NOW + 1 },
  ],
  cards: [
    { ...newSchedule(NOW), id: 'c1', deckId: 'd1', front: 'hola', back: 'hello', created: NOW, updated: NOW },
    { ...newSchedule(NOW), id: 'c2', deckId: 'd1', front: 'adios', back: 'bye', created: NOW + 1, ankiId: 555 },
    { ...newSchedule(NOW), id: 'c3', deckId: 'd1', front: 'gato', back: 'cat', created: NOW + 2, reserved: true, order: 0 },
    { ...newSchedule(NOW), id: 'c4', deckId: 'd2', front: '1+1', back: '2', created: NOW + 3, reversed: true },
    { ...newSchedule(NOW), id: 'c5', deckId: 'd2', front: '2+2', back: '4', created: NOW + 4, reps: 3 },
  ],
});

function setup(data = fixture()) {
  const dataDir = mkdtempSync(join(tmpdir(), 'recall-mig-'));
  writeFileSync(join(dataDir, 'recall.json'), JSON.stringify(data));
  return dataDir;
}
const opts = (dataDir) => ({ dataDir, username: 'owner', name: 'Owner', password: 'password-1' });

test('migrates a JSON file into an admin account unchanged', async () => {
  const data = fixture();
  const dataDir = setup(data);
  assert.deepEqual(await migrateJson(opts(dataDir), NOW), { decks: 2, cards: 5 });
  const db = openDb(join(dataDir, 'recall.db'));
  const user = db.prepare('SELECT id, role FROM users').get();
  assert.equal(user.role, 'admin');
  const view = buildView(db, user.id, NOW);
  assert.deepEqual(view.decks, data.decks);
  assert.deepEqual(view.cards, data.cards);
  assert.deepEqual(view.daily, data.daily);
  assert.deepEqual(view.log, data.log);
  assert.deepEqual(view.settings, data.settings);
  assert.equal(view.savedAt, data.savedAt);
  db.close();
  rmSync(dataDir, { recursive: true });
});

test('refuses to run twice', async () => {
  const dataDir = setup();
  await migrateJson(opts(dataDir), NOW);
  await assert.rejects(migrateJson({ ...opts(dataDir), username: 'second' }, NOW), /already has users/);
  const db = openDb(join(dataDir, 'recall.db'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  db.close();
  rmSync(dataDir, { recursive: true });
});

test('a card the database refuses stops the migration and leaves no database behind', async () => {
  const data = fixture();
  data.cards.push({ ...newSchedule(NOW), id: 'c9', deckId: 'missing', front: 'x', back: 'y', created: NOW });
  const dataDir = setup(data);
  await assert.rejects(migrateJson(opts(dataDir), NOW), /c9/);
  assert.equal(existsSync(join(dataDir, 'recall.db')), false);
  rmSync(dataDir, { recursive: true });
});
