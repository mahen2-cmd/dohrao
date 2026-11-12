// One-off: sorts a deck's cards into topics from the new_cards_<topic>.csv files it was built
// from. Only topic fields are written; scheduling and progress are never touched.
// Run it with: node scripts/assign-topics.js --data <dir> --username <admin> --deck "Portuguese A1"
//   --files <dir with new_cards_*.csv> [--dry-run]
// It saves a copy of the database in <dir>/backups first (not on a dry run).

import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { openDb } from '../server/db.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Text as compared: no HTML tags, lower case, single spaces, trimmed. */
const normalise = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
const pairKey = (a, b) => `${normalise(a)}|${normalise(b)}`;

/** Comma-separated text into rows of cells; quoted cells may hold commas, newlines and "" quotes. */
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') cell += text[++i];
      else quoted = false;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Read `new_cards_<key>.csv` files. Returns the rows of each known key, and the keys it skipped. */
export function parseTopicFiles(dir, groups) {
  const known = new Set(groups.flatMap((g) => Object.keys(g.topics)));
  const files = new Map();
  const skipped = [];
  for (const name of readdirSync(dir).sort()) {
    const m = /^new_cards_(.+)\.csv$/.exec(name);
    if (!m || m[1] === 'all') continue;
    if (!known.has(m[1])) { skipped.push(m[1]); continue; }
    files.set(m[1], parseCsv(readFileSync(join(dir, name), 'utf8')).filter((r) => r.length >= 2).map((r) => [r[0], r[1]]));
  }
  return { files, skipped };
}

/** Save a copy of the database before changing it. Refuses to overwrite an earlier copy. */
export function backupBefore(db, dataDir, date = new Date()) {
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `recall-before-topics-${date.toISOString().slice(0, 10)}.db`);
  if (existsSync(path)) throw new Error(`${path} already exists; move it aside first`);
  db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  return path;
}

/**
 * Put the deck's unsorted cards into the topics whose file lists them. A row matches a card as
 * front|back or reversed. A card found in two topics is left unsorted.
 * Returns { matched, ambiguous, unmatched }.
 */
export function assignTopics(db, { ownerUsername, deckName, files, groups, now = Date.now(), dryRun = false }) {
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(ownerUsername);
  if (!user) throw new Error(`No user named ${ownerUsername}`);
  const deckRow = db.prepare('SELECT id, data FROM decks WHERE owner_id = ?').all(user.id)
    .find((d) => JSON.parse(d.data).name === deckName);
  if (!deckRow) throw new Error(`No deck named "${deckName}" belongs to ${ownerUsername}`);
  const deck = JSON.parse(deckRow.data);

  // Groups and topics: add what is missing, keep what is there.
  const deckGroups = [...(deck.groups ?? [])];
  const deckTopics = [...(deck.topics ?? [])];
  let structureChanged = false;
  const topicIdByKey = new Map(deckTopics.filter((t) => t.key).map((t) => [t.key, t.id]));
  for (const { group, topics } of groups) {
    let g = deckGroups.find((x) => x.name === group);
    for (const [key, name] of Object.entries(topics)) {
      if (topicIdByKey.has(key)) continue;
      if (!g) { g = { id: randomUUID(), name: group }; deckGroups.push(g); }
      const topic = { id: randomUUID(), key, name, groupId: g.id, by: 'admin' };
      deckTopics.push(topic);
      topicIdByKey.set(key, topic.id);
      structureChanged = true;
    }
  }

  // Which topics list each normalised pair (both ways round).
  const keysByPair = new Map();
  for (const [key, rows] of files) {
    for (const [a, b] of rows) {
      for (const k of [pairKey(a, b), pairKey(b, a)]) {
        if (!keysByPair.has(k)) keysByPair.set(k, new Set());
        keysByPair.get(k).add(key);
      }
    }
  }

  const counts = { matched: 0, ambiguous: 0, unmatched: 0 };
  const updates = [];
  for (const row of db.prepare('SELECT id, data FROM cards WHERE deck_id = ?').all(deckRow.id)) {
    const card = JSON.parse(row.data);
    if (card.topic) continue;
    const keys = keysByPair.get(pairKey(card.front, card.back));
    if (!keys) counts.unmatched++;
    else if (keys.size > 1) counts.ambiguous++;
    else {
      counts.matched++;
      updates.push({ id: row.id, card: { ...card, topic: topicIdByKey.get([...keys][0]), topicBy: 'file', topicAt: now } });
    }
  }

  if (!dryRun && (structureChanged || updates.length)) {
    const save = (table, id, data) => db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify(data), id);
    db.exec('BEGIN');
    try {
      save('decks', deckRow.id, { ...deck, groups: deckGroups, topics: deckTopics, topicsAt: Math.max(deck.topicsAt ?? 0, now) });
      for (const u of updates) save('cards', u.id, u.card);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return counts;
}

function option(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(args) {
  const dataDir = option(args, '--data');
  const username = option(args, '--username');
  const deckName = option(args, '--deck');
  const filesDir = option(args, '--files');
  const dryRun = args.includes('--dry-run');
  if (!dataDir || !username || !deckName || !filesDir) {
    console.error('Usage: node scripts/assign-topics.js --data <dir> --username <admin> --deck "Portuguese A1" --files <dir> [--dry-run]');
    return 2;
  }
  const dbFile = join(resolve(dataDir), 'recall.db');
  if (!existsSync(dbFile)) { console.error(`No database at ${dbFile}`); return 1; }
  let db;
  try {
    const groups = JSON.parse(readFileSync(join(here, 'portuguese-groups.json'), 'utf8'));
    const { files, skipped } = parseTopicFiles(resolve(filesDir), groups);
    if (skipped.length) console.log(`Skipped files with unknown topics: ${skipped.join(', ')}`);
    db = openDb(dbFile);
    if (!dryRun) console.log(`Backup: ${backupBefore(db, resolve(dataDir))}`);
    const { matched, ambiguous, unmatched } = assignTopics(db, { ownerUsername: username, deckName, files, groups, dryRun });
    console.log(`${dryRun ? 'Dry run. Would sort' : 'Sorted'} ${matched}; ambiguous ${ambiguous}; unmatched ${unmatched}.`);
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  } finally {
    db?.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
