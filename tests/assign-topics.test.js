import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { assignTopics, parseTopicFiles, backupBefore } from '../scripts/assign-topics.js';

const NOW = 1_800_000_000_000;
const groups = [
  { group: 'Verbs', topics: { verb_ser: 'Ser', verb_ir: 'Ir' } },
  { group: 'Work', topics: { professions: 'Professions' } },
];
const files = new Map([
  ['verb_ser', [['I am (ser)', 'eu sou'], ['to be', 'ser']]],
  ['professions', [['<b>Teacher</b>', 'professor  '], ['to be', 'ser']]],
]);

async function setup() {
  const db = openDb(':memory:');
  const user = await createUser(db, { username: 'admin', name: 'Admin', password: 'password-1', role: 'admin' }, NOW);
  db.prepare('INSERT INTO decks (id, owner_id, data) VALUES (?, ?, ?)').run('d1', user.id, JSON.stringify({ id: 'd1', name: 'Portuguese A1' }));
  const sched = { due: 5, ease: 2.5, state: 2, reps: 4, lapses: 1, scheduledDays: 3 };
  const cards = [
    { id: 'c1', deckId: 'd1', front: 'Eu sou', back: 'I am (ser)', ...sched },          // reversed, case differs
    { id: 'c2', deckId: 'd1', front: 'Teacher', back: 'professor', ...sched },          // tags/spaces
    { id: 'c3', deckId: 'd1', front: 'unknown', back: 'desconhecido', ...sched },       // unmatched
    { id: 'c4', deckId: 'd1', front: 'I am (ser)', back: 'eu sou', topic: 'x', topicBy: 'manual', ...sched }, // already sorted
    { id: 'c5', deckId: 'd1', front: 'to be', back: 'ser', ...sched },                  // in two topics: ambiguous
  ];
  for (const c of cards) db.prepare('INSERT INTO cards (id, deck_id, data) VALUES (?, ?, ?)').run(c.id, 'd1', JSON.stringify(c));
  db.prepare('INSERT INTO progress (user_id, card_id, data) VALUES (?, ?, ?)').run(user.id, 'c1', JSON.stringify({ reps: 4 }));
  return { db, cards };
}
const card = (db, id) => JSON.parse(db.prepare('SELECT data FROM cards WHERE id = ?').get(id).data);
const run = (db, extra = {}) => assignTopics(db, { ownerUsername: 'admin', deckName: 'Portuguese A1', files, groups, now: NOW, ...extra });

test('sorts matches, leaves unmatched, sorted and ambiguous cards alone, keeps scheduling', async () => {
  const { db, cards } = await setup();
  const progress = db.prepare('SELECT data FROM progress').all();
  assert.deepEqual(run(db), { matched: 2, ambiguous: 1, unmatched: 1 });
  const deck = JSON.parse(db.prepare('SELECT data FROM decks WHERE id = ?').get('d1').data);
  assert.equal(deck.topicsAt, NOW);
  assert.deepEqual(deck.groups.map((g) => g.name), ['Verbs', 'Work']);
  assert.equal(deck.topics.length, 3);
  const ser = deck.topics.find((t) => t.key === 'verb_ser');
  assert.deepEqual([ser.name, ser.by, ser.groupId], ['Ser', 'admin', deck.groups[0].id]);
  const c1 = card(db, 'c1');
  assert.deepEqual([c1.topic, c1.topicBy, c1.topicAt], [ser.id, 'file', NOW]);
  assert.equal(card(db, 'c2').topic, deck.topics.find((t) => t.key === 'professions').id);
  for (const id of ['c3', 'c5']) assert.equal(card(db, id).topic, undefined);
  assert.deepEqual(card(db, 'c4'), cards[3]);
  for (const id of ['c1', 'c2']) {
    const { topic, topicBy, topicAt, ...rest } = card(db, id);
    assert.deepEqual(rest, cards.find((c) => c.id === id));
  }
  assert.deepEqual(db.prepare('SELECT data FROM progress').all(), progress);
  db.close();
});

test('a second run reuses topics and ids, and finds nothing new', async () => {
  const { db } = await setup();
  run(db);
  const before = JSON.parse(db.prepare('SELECT data FROM decks WHERE id = ?').get('d1').data);
  assert.deepEqual(run(db, { now: NOW + 1 }), { matched: 0, ambiguous: 1, unmatched: 1 });
  const after = JSON.parse(db.prepare('SELECT data FROM decks WHERE id = ?').get('d1').data);
  assert.deepEqual(after.topics, before.topics);
  assert.deepEqual(after.groups, before.groups);
  db.close();
});

test('dry run reports the counts and writes nothing', async () => {
  const { db } = await setup();
  assert.deepEqual(run(db, { dryRun: true }), { matched: 2, ambiguous: 1, unmatched: 1 });
  assert.equal(card(db, 'c1').topic, undefined);
  assert.equal(JSON.parse(db.prepare('SELECT data FROM decks WHERE id = ?').get('d1').data).topics, undefined);
  db.close();
});

test('only the named owner and deck are touched', async () => {
  const { db } = await setup();
  assert.throws(() => run(db, { deckName: 'Nope' }), /No deck named/);
  assert.throws(() => run(db, { ownerUsername: 'ghost' }), /No user/);
  db.close();
});

test('reads new_cards_<key>.csv files, skips all and unknown keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-topics-'));
  writeFileSync(join(dir, 'new_cards_verb_ser.csv'), 'a,b\n"x, y","say ""hi"""\n');
  writeFileSync(join(dir, 'new_cards_all.csv'), 'z,z\n');
  writeFileSync(join(dir, 'new_cards_mystery.csv'), 'z,z\n');
  const { files: got, skipped } = parseTopicFiles(dir, groups);
  assert.deepEqual([...got.keys()], ['verb_ser']);
  assert.deepEqual(got.get('verb_ser'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.deepEqual(skipped, ['mystery']);
  rmSync(dir, { recursive: true });
});

test('backup copies the database to a dated file and will not overwrite it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-bak-'));
  const db = openDb(join(dir, 'recall.db'));
  const path = backupBefore(db, dir, new Date('2026-11-12T10:00:00Z'));
  assert.equal(path, join(dir, 'backups', 'recall-before-topics-2026-11-12.db'));
  assert.ok(existsSync(path));
  assert.throws(() => backupBefore(db, dir, new Date('2026-11-12T10:00:00Z')), /already exists/);
  db.close();
  rmSync(dir, { recursive: true });
});
