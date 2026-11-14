// Fills a deck's Urdu at once, instead of waiting for the server to do it in the background.
// Run it with: node scripts/translate-urdu.js --data <dir> --deck "Portuguese A1"
// The deck must have "Translate the front into Urdu" switched on. Cards already done are skipped.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { openDb } from '../server/db.js';
import { createTranslator } from '../server/translate.js';
import { createUrduQueue } from '../server/urdu-queue.js';
import { needsUrdu } from '../js/urdu.js';

/** The deck row with this name, or null. */
export function findDeckByName(db, deckName) {
  return db.prepare('SELECT id, data FROM decks ORDER BY rowid').all()
    .find((d) => JSON.parse(d.data).name === deckName) ?? null;
}

/** Translate the named deck's cards that need Urdu. Returns { translated, failed, alreadyDone }. */
export async function translateDeck(db, { deckName, translator, pauseMs, log }) {
  const row = findDeckByName(db, deckName);
  if (!row) throw new Error(`No deck named "${deckName}"`);
  const deck = JSON.parse(row.data);
  if (!deck.urdu) throw new Error('Switch on Translate the front into Urdu first');
  const alreadyDone = db.prepare('SELECT data FROM cards WHERE deck_id = ?').all(row.id)
    .map((c) => JSON.parse(c.data))
    .filter((card) => card.urdu && !needsUrdu(card, deck)).length;
  const queue = createUrduQueue({ db, translator, pauseMs, log });
  queue.scanDeck(row.id);
  // The queue's pauses don't hold the process open, so this does until the work is done.
  const hold = setInterval(() => {}, 60_000);
  try {
    return { ...(await queue.idle()), alreadyDone };
  } finally {
    clearInterval(hold);
  }
}

function option(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args) {
  const dataDir = option(args, '--data');
  const deckName = option(args, '--deck');
  if (!dataDir || !deckName) {
    console.error('Usage: node scripts/translate-urdu.js --data <dir> --deck "Portuguese A1"');
    return 2;
  }
  const dbFile = join(resolve(dataDir), 'recall.db');
  if (!existsSync(dbFile)) { console.error(`No database at ${dbFile}`); return 1; }
  let db;
  try {
    db = openDb(dbFile);
    const { translated, failed, alreadyDone } = await translateDeck(db, { deckName, translator: createTranslator() });
    console.log(`Translated ${translated}, failed ${failed}, already done ${alreadyDone}.`);
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  } finally {
    db?.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
