// One-off: moves the owner's data/recall.json into the SQLite database under a new admin
// account, keeping every deck, card, count and setting as it was. Media and audio stay on disk.
// Run it with: node scripts/migrate-json.js --data <dir> --username <u> --name "<n>"
// The password comes from RECALL_ADMIN_PASSWORD, or is asked for without echo.

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';

import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { applyChanges, buildView } from '../server/sync.js';

const preview = (ids) => ids.slice(0, 5).join(', ') + (ids.length > 5 ? `, and ${ids.length - 5} more` : '');

/** Ids whose objects differ between what went in and what the view returns. */
function differing(input, output) {
  const byId = new Map(output.map((o) => [o.id, o]));
  return input.filter((o) => !isDeepStrictEqual(o, byId.get(o.id))).map((o) => o.id);
}

/** Check the new account sees exactly what was in the file; throws naming what differs. */
function verify(db, userId, data, now) {
  const view = buildView(db, userId, now);
  const problems = [];
  if (view.decks.length !== data.decks.length) problems.push(`deck count ${view.decks.length} (expected ${data.decks.length})`);
  if (view.cards.length !== data.cards.length) problems.push(`card count ${view.cards.length} (expected ${data.cards.length})`);
  const badDecks = differing(data.decks, view.decks);
  const badCards = differing(data.cards, view.cards);
  if (badDecks.length) problems.push(`decks that differ: ${preview(badDecks)}`);
  if (badCards.length) problems.push(`cards that differ: ${preview(badCards)}`);
  for (const key of ['daily', 'log', 'settings']) {
    if (!isDeepStrictEqual(data[key] ?? {}, view[key])) problems.push(`${key} differs`);
  }
  if (problems.length) throw new Error(`Verification failed: ${problems.join('; ')}`);
}

/** Move `<dataDir>/recall.json` into `<dataDir>/recall.db` for a new admin. Returns the counts. */
export async function migrateJson({ dataDir, username, name, password }, now = Date.now()) {
  const jsonFile = join(dataDir, 'recall.json');
  const dbFile = join(dataDir, 'recall.db');
  const data = JSON.parse(readFileSync(jsonFile, 'utf8'));
  if (!Array.isArray(data.decks) || !Array.isArray(data.cards)) throw new Error(`${jsonFile} has no decks and cards`);

  const existed = existsSync(dbFile);
  const db = openDb(dbFile);
  let userId;
  try {
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) throw new Error(`${dbFile} already has users; nothing was changed`);
    userId = (await createUser(db, { username, name, password, role: 'admin' }, now)).id;
    const { rejected } = applyChanges(db, userId, {
      decks: data.decks,
      cards: data.cards,
      daily: data.daily ?? {},
      log: data.log ?? {},
      settings: data.settings ?? {},
      savedAt: data.savedAt ?? 0,
    }, now);
    if (rejected.length) throw new Error(`The database refused ${rejected.length} item(s): ${preview(rejected)}`);
    verify(db, userId, data, now);
  } catch (err) {
    // Leave nothing half-written: drop the new database, or just the new user if one was already there.
    if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.close();
    if (!existed) for (const ext of ['', '-wal', '-shm']) rmSync(dbFile + ext, { force: true });
    throw err;
  }
  db.close();
  return { decks: data.decks.length, cards: data.cards.length };
}

/** Ask for a password without showing what is typed. */
function askPassword(prompt) {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); done(answer); });
  });
}

function option(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args) {
  const dir = option(args, '--data');
  const username = option(args, '--username');
  const name = option(args, '--name');
  if (!dir || !username || !name) {
    console.error('Usage: node scripts/migrate-json.js --data <dir> --username <u> --name "<n>"');
    return 2;
  }
  let password = process.env.RECALL_ADMIN_PASSWORD;
  if (!password) {
    if (!process.stdin.isTTY) {
      console.error('Set RECALL_ADMIN_PASSWORD, or run this in a terminal to be asked for the password.');
      return 2;
    }
    password = await askPassword('Password for the new admin: ');
  }
  try {
    const { decks, cards } = await migrateJson({ dataDir: resolve(dir), username, name, password });
    console.log(`${decks} decks, ${cards} cards`);
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
