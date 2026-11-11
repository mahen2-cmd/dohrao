import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/db.js';
import {
  createUser, createInvite, listInvites, revokeInvite, signUp, logIn,
  createSession, userForSession, endSession, setPassword, createLimiter,
  hashPassword, verifyPassword,
} from '../server/auth.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const person = (over = {}) => ({ username: 'ann', name: 'Ann', password: 'correct horse', ...over });

test('password hashes verify only the right password', async () => {
  const stored = await hashPassword('secret-pass');
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await verifyPassword('secret-pass', stored), true);
  assert.equal(await verifyPassword('other-pass', stored), false);
  assert.equal(await verifyPassword('secret-pass', 'garbage'), false);
});

test('sign up with a valid invite creates a user and uses the code up', async () => {
  const db = openDb(':memory:');
  const code = createInvite(db, {}, NOW);
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  const user = await signUp(db, { code, ...person() }, NOW);
  assert.equal(user.username, 'ann');
  assert.equal(user.role, 'user');
  assert.equal(listInvites(db)[0].usesLeft, 0);
  await assert.rejects(signUp(db, { code, ...person({ username: 'bob' }) }, NOW), { code: 'bad-invite' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
});

test('invite codes ignore spaces and case', async () => {
  const db = openDb(':memory:');
  const code = createInvite(db, {}, NOW);
  const user = await signUp(db, { code: '  ' + code.toLowerCase() + ' ', ...person() }, NOW);
  assert.equal(user.username, 'ann');
});

test('revoked invite is refused', async () => {
  const db = openDb(':memory:');
  const code = createInvite(db, { uses: 5 }, NOW);
  revokeInvite(db, code);
  await assert.rejects(signUp(db, { code, ...person() }, NOW), { code: 'bad-invite' });
  assert.equal(listInvites(db)[0].revoked, true);
});

test('a failed sign-up does not use up the invite', async () => {
  const db = openDb(':memory:');
  const code = createInvite(db, {}, NOW);
  await createUser(db, person(), NOW);
  await assert.rejects(signUp(db, { code, ...person() }, NOW), { code: 'username-taken' });
  await assert.rejects(signUp(db, { code, ...person({ password: 'short' }) }, NOW), { code: 'weak-password' });
  assert.equal(listInvites(db)[0].usesLeft, 1);
  await signUp(db, { code, ...person({ username: 'bob' }) }, NOW);
});

test('two simultaneous sign-ups with a single-use code: exactly one succeeds', async () => {
  const db = openDb(':memory:');
  const code = createInvite(db, {}, NOW);
  const results = await Promise.allSettled([
    signUp(db, { code, ...person({ username: 'ann' }) }, NOW),
    signUp(db, { code, ...person({ username: 'bob' }) }, NOW),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = results.find((r) => r.status === 'rejected');
  assert.equal(lost.reason.code, 'bad-invite');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
});

test('usernames are unique regardless of case', async () => {
  const db = openDb(':memory:');
  await createUser(db, person({ username: 'Mum' }), NOW);
  await assert.rejects(createUser(db, person({ username: 'mum' }), NOW), { code: 'username-taken' });
});

test('input is validated', async () => {
  const db = openDb(':memory:');
  await assert.rejects(createUser(db, person({ username: 'a b' }), NOW), { code: 'bad-username' });
  await assert.rejects(createUser(db, person({ username: 'ab' }), NOW), { code: 'bad-username' });
  await assert.rejects(createUser(db, person({ password: '1234567' }), NOW), { code: 'weak-password' });
  const user = await createUser(db, person({ name: '  Ann  ', role: 'admin' }), NOW);
  assert.equal(user.name, 'Ann');
  assert.equal(user.role, 'admin');
});

test('log in checks the password', async () => {
  const db = openDb(':memory:');
  await createUser(db, person(), NOW);
  const user = await logIn(db, { username: 'ANN', password: 'correct horse' });
  assert.equal(user.name, 'Ann');
  assert.equal(user.pass, undefined);
  await assert.rejects(logIn(db, { username: 'ann', password: 'wrong' }), { code: 'bad-login' });
  await assert.rejects(logIn(db, { username: 'nobody', password: 'correct horse' }), { code: 'bad-login' });
});

test('sessions expire', async () => {
  const db = openDb(':memory:');
  const u = await createUser(db, person(), NOW);
  const t = createSession(db, u.id, NOW);
  assert.equal(userForSession(db, t, NOW + 179 * DAY).id, u.id);
  assert.equal(userForSession(db, t, NOW + 181 * DAY), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(userForSession(db, 'nonsense', NOW), null);
});

test('endSession removes the session, and only a hash is stored', async () => {
  const db = openDb(':memory:');
  const u = await createUser(db, person(), NOW);
  const t = createSession(db, u.id, NOW);
  assert.equal(db.prepare('SELECT token_hash FROM sessions').get().token_hash === t, false);
  endSession(db, t);
  assert.equal(userForSession(db, t, NOW), null);
});

test('setPassword ends existing sessions', async () => {
  const db = openDb(':memory:');
  const u = await createUser(db, person(), NOW);
  const t = createSession(db, u.id, NOW);
  await assert.rejects(setPassword(db, u.id, 'short'), { code: 'weak-password' });
  assert.ok(userForSession(db, t, NOW));
  await setPassword(db, u.id, 'brand new pass');
  assert.equal(userForSession(db, t, NOW), null);
  await assert.rejects(logIn(db, { username: 'ann', password: 'correct horse' }), { code: 'bad-login' });
  await logIn(db, { username: 'ann', password: 'brand new pass' });
});

test('limiter blocks after max hits within the window and frees up after it', () => {
  const limiter = createLimiter({ max: 3, windowMs: 1000 });
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.hit('ip', 0)), [true, true, true, false]);
  assert.equal(limiter.hit('other', 0), true);
  assert.equal(limiter.hit('ip', 1001), true);
});
