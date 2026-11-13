// One-off: puts every deck, for every person, on FSRS at 90% desired retention.
// Each owner's own decks and every deck given to someone (taken back or not) get the person's
// deck settings set to scheduler 'fsrs' and retention 0.9; all their other settings stay.
// Cards and progress are not touched: FSRS takes over from each card's next review.
// Run it with: node scripts/switch-to-fsrs.js --data <dir> [--dry-run]
// Stop Recall and back up recall.db first.

import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { openDb } from '../server/db.js';

const TARGET = { scheduler: 'fsrs', retention: 0.9 };

const parse = (text) => (text ? JSON.parse(text) : {});
const onTarget = (o) => o.scheduler === TARGET.scheduler && o.retention === TARGET.retention;

/**
 * Switch every (person, deck) pair to FSRS at 90%. Returns how many pairs changed and how many
 * already were there. With `dryRun`, nothing is written and the counts are what a run would do.
 */
export function switchToFsrs(db, { dryRun = false } = {}) {
  const pairs = [
    ...db.prepare('SELECT owner_id AS userId, id AS deckId FROM decks').all(),
    ...db.prepare('SELECT user_id AS userId, deck_id AS deckId FROM assignments').all(),
  ];
  const getPrefs = db.prepare('SELECT data FROM deck_prefs WHERE user_id = ? AND deck_id = ?');
  const putPrefs = db.prepare(`INSERT INTO deck_prefs (user_id, deck_id, data) VALUES (?, ?, ?)
    ON CONFLICT (user_id, deck_id) DO UPDATE SET data = excluded.data`);
  const putDeck = db.prepare('UPDATE decks SET data = ? WHERE id = ?');

  let changed = 0;
  let already = 0;
  db.exec('BEGIN');
  try {
    for (const { userId, deckId } of pairs) {
      const prefs = parse(getPrefs.get(userId, deckId)?.data);
      if (onTarget(prefs)) {
        already++;
        continue;
      }
      putPrefs.run(userId, deckId, JSON.stringify({ ...prefs, ...TARGET }));
      changed++;
    }
    // Decks moved from the old JSON file can carry these settings in their shared data,
    // which would show through for anyone without settings of their own.
    for (const { id, data } of db.prepare('SELECT id, data FROM decks').all()) {
      const d = parse(data);
      if (('scheduler' in d || 'retention' in d) && !onTarget(d)) putDeck.run(JSON.stringify({ ...d, ...TARGET }), id);
    }
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { changed, already };
}

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(args) {
  const dir = option(args, '--data');
  if (!dir) {
    console.error('Usage: node scripts/switch-to-fsrs.js --data <dir> [--dry-run]');
    return 2;
  }
  const dryRun = args.includes('--dry-run');
  const db = openDb(join(resolve(dir), 'recall.db'));
  try {
    const { changed, already } = switchToFsrs(db, { dryRun });
    const total = changed + already;
    console.log(`${dryRun ? 'Would switch' : 'Switched'} ${changed} of ${total} decks to FSRS at 90% (${already} already were).`);
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
