// SQLite store: opens the database and creates the schema if missing.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pass TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  uses_left INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deck_prefs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  PRIMARY KEY (user_id, deck_id)
);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS progress (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  PRIMARY KEY (user_id, card_id)
);
CREATE TABLE IF NOT EXISTS assignments (
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active INTEGER NOT NULL,
  assigned INTEGER NOT NULL,
  PRIMARY KEY (deck_id, user_id)
);
CREATE TABLE IF NOT EXISTS user_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily TEXT NOT NULL,
  log TEXT NOT NULL,
  settings TEXT NOT NULL,
  saved_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS topic_proposals (
  deck_id TEXT PRIMARY KEY REFERENCES decks(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_deck ON cards(deck_id);
CREATE INDEX IF NOT EXISTS reviews_user_at ON reviews(user_id, at);
CREATE INDEX IF NOT EXISTS reviews_card ON reviews(card_id);
CREATE INDEX IF NOT EXISTS progress_card ON progress(card_id);
`;

/** The admin's per-person Urdu switch and when it was set; older databases lack the columns. */
function addAssignmentUrduColumns(db) {
  const have = db.prepare('PRAGMA table_info(assignments)').all().map((c) => c.name);
  if (!have.includes('urdu')) db.exec('ALTER TABLE assignments ADD COLUMN urdu INTEGER NOT NULL DEFAULT 0');
  if (!have.includes('urdu_at')) db.exec('ALTER TABLE assignments ADD COLUMN urdu_at INTEGER');
  // What the admin set the person's front to: 'en', 'ur' or 'both'. NULL from before it could
  // be chosen, when `urdu` alone said on (Urdu) or off (English).
  if (!have.includes('front')) db.exec('ALTER TABLE assignments ADD COLUMN front TEXT');
}

/** Open (or create) the database at `file`; use ':memory:' in tests. */
export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  addAssignmentUrduColumns(db);
  return db;
}
