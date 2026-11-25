// Accounts, invite codes, sessions and the rate limiter.
import { randomBytes, randomUUID, scrypt, createHash, timingSafeEqual } from 'node:crypto';

const SESSION_MS = 180 * 24 * 60 * 60 * 1000;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;

export class AuthError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Hash a password as `scrypt$<saltHex>$<hashHex>`. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Check a password against a stored hash in constant time. */
export async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const key = await scryptAsync(password, Buffer.from(saltHex, 'hex'));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const publicUser = (row) => ({ id: row.id, username: row.username, name: row.name, role: row.role });

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new AuthError('weak-password', 'Password must be at least 8 characters');
  }
}

/** Validate sign-up fields; returns them cleaned or throws an AuthError. */
function cleanUser({ username, name, password, role = 'user' }) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new AuthError('bad-username', 'Username must be 3-32 letters, digits, dots, dashes or underscores');
  }
  checkPassword(password);
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length < 1 || trimmed.length > 60) throw new AuthError('bad-name', 'Name must be 1-60 characters');
  return { username, name: trimmed, role };
}

/** Synchronous insert shared by createUser and signUp. */
function insertUser(db, clean, pass, now) {
  const id = randomUUID();
  try {
    db.prepare('INSERT INTO users (id, username, name, pass, role, created) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, clean.username, clean.name, pass, clean.role, now);
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) throw new AuthError('username-taken', 'That username is taken');
    throw err;
  }
  return { id, username: clean.username, name: clean.name, role: clean.role };
}

/** Create a user directly (no invite). */
export async function createUser(db, fields, now) {
  const clean = cleanUser(fields);
  return insertUser(db, clean, await hashPassword(fields.password), now);
}

export function createInvite(db, { uses = 1 } = {}, now) {
  const bytes = randomBytes(8);
  let code = '';
  for (const b of bytes) code += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
  db.prepare('INSERT INTO invites (code, uses_left, revoked, created) VALUES (?, ?, 0, ?)').run(code, uses, now);
  return code;
}

export function listInvites(db) {
  return db.prepare('SELECT code, uses_left, revoked, created FROM invites ORDER BY created DESC, rowid DESC').all()
    .map((r) => ({ code: r.code, usesLeft: r.uses_left, revoked: !!r.revoked, created: r.created }));
}

export function revokeInvite(db, code) {
  db.prepare('UPDATE invites SET revoked = 1 WHERE code = ?').run(String(code).trim().toUpperCase());
}

/**
 * Sign up with an invite code. Validation and hashing happen first (async); the
 * invite use and user insert then run as one synchronous transaction, so
 * concurrent calls on the single connection cannot interleave.
 */
export async function signUp(db, { code, username, name, password }, now) {
  const clean = cleanUser({ username, name, password });
  const pass = await hashPassword(password);
  const normalised = String(code ?? '').trim().toUpperCase();
  db.exec('BEGIN IMMEDIATE');
  try {
    const used = db.prepare('UPDATE invites SET uses_left = uses_left - 1 WHERE code = ? AND uses_left > 0 AND revoked = 0')
      .run(normalised);
    if (used.changes !== 1) throw new AuthError('bad-invite', 'That invite code is not valid');
    const user = insertUser(db, clean, pass, now);
    db.exec('COMMIT');
    return user;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

let dummyHash; // verified against for unknown users so timing does not reveal them

/** Check credentials; the same error for an unknown user and a wrong password. */
export async function logIn(db, { username, password }) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? ''));
  if (!row) {
    dummyHash ??= await hashPassword('no-such-user');
    await verifyPassword(String(password ?? ''), dummyHash);
    throw new AuthError('bad-login', 'Wrong username or password');
  }
  if (!(await verifyPassword(String(password ?? ''), row.pass))) {
    throw new AuthError('bad-login', 'Wrong username or password');
  }
  return publicUser(row);
}

const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

/** Start a session; returns the token (only its hash is stored). */
export function createSession(db, userId, now) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, now + SESSION_MS);
  return token;
}

export function userForSession(db, token, now) {
  const hash = hashToken(token);
  const row = db.prepare(
    'SELECT u.id, u.username, u.name, u.role, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
  ).get(hash);
  if (!row) return null;
  if (row.expires <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  return publicUser(row);
}

export function endSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

/** Change a password and sign the user out everywhere. */
export async function setPassword(db, userId, password) {
  checkPassword(password);
  const pass = await hashPassword(password);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(pass, userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Sliding-window limiter: `hit(key, now)` is true while under `max` hits per `windowMs`. */
export function createLimiter({ max, windowMs }) {
  const hits = new Map();
  return {
    hit(key, now) {
      const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
      const allowed = recent.length < max;
      if (allowed) recent.push(now);
      if (recent.length) hits.set(key, recent);
      else hits.delete(key);
      return allowed;
    },
  };
}
