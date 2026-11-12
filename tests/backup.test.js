import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../server/db.js';
import { backupDb } from '../server/backup.js';

const DAY = 24 * 60 * 60 * 1000;
const NOON = new Date(2026, 10, 11, 12).getTime(); // 2026-11-11, local time

test('one backup per day, oldest removed beyond keep', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'recall-backup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'recall.db'));
  t.after(() => db.close());
  db.prepare("INSERT INTO invites (code, uses_left, created) VALUES ('KEEPME', 1, 0)").run();
  const backups = join(dir, 'backups');

  const first = backupDb(db, backups, NOON, 3);
  assert.equal(first, join(backups, 'recall-2026-11-11.db'));
  assert.equal(backupDb(db, backups, NOON + 60 * 60 * 1000, 3), null);

  const copy = openDb(first);
  assert.equal(copy.prepare('SELECT code FROM invites').get().code, 'KEEPME');
  copy.close();

  for (let d = 1; d <= 4; d++) backupDb(db, backups, NOON + d * DAY, 3);
  const names = (await readdir(backups)).filter((f) => f.endsWith('.db')).sort();
  assert.deepEqual(names, ['recall-2026-11-13.db', 'recall-2026-11-14.db', 'recall-2026-11-15.db']);
});
