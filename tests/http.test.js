import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecallServer } from '../server.js';
import { openDb } from '../server/db.js';
import { createUser, createInvite } from '../server/auth.js';

const NOW = Date.now();
const fakeTts = { speak: async () => ({ body: Buffer.from('x'), type: 'audio/mpeg' }), engine: async () => 'Fake' };

/** A server on a free port with a temp data folder, an admin and an invite. */
async function start(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'recall-http-'));
  const db = openDb(join(dataDir, 'recall.db'));
  const admin = await createUser(db, { username: 'admin', name: 'Admin', password: 'admin-password', role: 'admin' }, NOW);
  const invite = createInvite(db, { uses: 5 }, NOW);
  const server = createRecallServer({ dataDir, tts: fakeTts });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { port: server.address().port, db, admin, invite };
}

/** One request; resolves `{ status, headers, json, text, cookie }`. */
function call(port, method, path, { body, cookie, headers = {} } = {}) {
  const data = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, method, path: `/${path}`,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        const set = res.headers['set-cookie']?.[0];
        resolve({ status: res.statusCode, headers: res.headers, json, text, setCookie: set, cookie: set?.split(';')[0] });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const signUp = (port, invite, username = 'ben') =>
  call(port, 'POST', 'api/signup', { body: { code: invite, username, name: 'Ben', password: 'ben-password' } });
const logIn = (port, username, password) => call(port, 'POST', 'api/login', { body: { username, password } });

const deck = { id: 'd1', name: 'Spanish', created: NOW, frontLang: 'es', backLang: 'en', saveAudio: false };
const card = { id: 'c1', deckId: 'd1', front: 'hola', back: 'hello', created: NOW, updated: NOW };

test('the API needs a session', async (t) => {
  const { port } = await start(t);
  assert.equal((await call(port, 'GET', 'api/state')).status, 401);
  assert.equal((await call(port, 'GET', 'api/tts?text=hi&lang=en-US')).status, 401);
  assert.equal((await call(port, 'POST', 'api/sync', { body: { decks: [deck] } })).status, 401);
  assert.equal((await call(port, 'GET', 'api/me')).status, 401);
  assert.equal((await call(port, 'GET', 'api/state', { cookie: 'recall_session=forged' })).status, 401);
  // The app itself loads without one, so the login screen can show.
  assert.equal((await call(port, 'GET', '')).status, 200);
});

test('sign up, then state and sync work with the cookie', async (t) => {
  const { port, invite } = await start(t);
  const res = await signUp(port, invite);
  assert.equal(res.status, 201);
  assert.equal(res.json.user.username, 'ben');
  assert.match(res.setCookie, /^recall_session=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=15552000$/);

  const me = await call(port, 'GET', 'api/me', { cookie: res.cookie });
  assert.deepEqual(me.json.user, res.json.user);

  const sync = await call(port, 'POST', 'api/sync', { cookie: res.cookie, body: { decks: [deck], cards: [card], savedAt: NOW } });
  assert.equal(sync.status, 200);
  assert.deepEqual(sync.json, { rejected: [] });

  const state = await call(port, 'GET', 'api/state', { cookie: res.cookie });
  assert.equal(state.status, 200);
  assert.equal(state.headers['x-tts-engine'], 'Fake');
  assert.equal(state.headers['x-data-file'], undefined);
  assert.deepEqual(state.json.decks.map((d) => d.name), ['Spanish']);
  assert.deepEqual(state.json.cards.map((c) => c.front), ['hola']);
  assert.equal(state.json.savedAt, NOW);

  // Malformed changes are refused before they reach the store.
  for (const body of [{ decks: 'x' }, { cards: [1] }, { deletedCards: [{}] }, { log: [] }, { savedAt: 'now' }, [], 'nope']) {
    const bad = await call(port, 'POST', 'api/sync', { cookie: res.cookie, body });
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.deepEqual(bad.json, { error: 'bad-request' });
  }

  // The same invite and username cannot be reused; bad codes are refused.
  assert.equal((await signUp(port, invite)).status, 409);
  assert.deepEqual((await signUp(port, 'NOPE', 'cal')).json, { error: 'bad-invite' });
  assert.equal((await logIn(port, 'ben', 'wrong-password')).status, 401);
  const login = await logIn(port, 'ben', 'ben-password');
  assert.equal(login.status, 200);
  assert.equal(login.json.user.username, 'ben');
});

test('logout ends the session', async (t) => {
  const { port, invite } = await start(t);
  const { cookie } = await signUp(port, invite);
  const out = await call(port, 'POST', 'api/logout', { cookie });
  assert.equal(out.status, 204);
  assert.match(out.setCookie, /^recall_session=; .*Max-Age=0/);
  assert.equal((await call(port, 'GET', 'api/state', { cookie })).status, 401);
});

test('admin endpoints refuse ordinary users', async (t) => {
  const { port, invite } = await start(t);
  const { cookie } = await signUp(port, invite);
  for (const [method, path] of [
    ['GET', 'api/admin/users'], ['GET', 'api/admin/invites'], ['POST', 'api/admin/invites'],
    ['DELETE', 'api/admin/invites/ABC'], ['GET', 'api/admin/decks'], ['POST', 'api/admin/decks/d1/assign'],
    ['POST', 'api/admin/decks/d1/unassign'], ['POST', 'api/admin/users/x/password'],
  ]) {
    const res = await call(port, method, path, { cookie, body: {} });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  assert.equal((await call(port, 'GET', 'api/admin/users')).status, 401);
});

test('admin gives a deck and the recipient sees it', async (t) => {
  const { port, invite } = await start(t);
  const admin = (await logIn(port, 'admin', 'admin-password')).cookie;
  const ben = await signUp(port, invite);
  await call(port, 'POST', 'api/sync', { cookie: admin, body: { decks: [deck], cards: [card] } });

  const users = await call(port, 'GET', 'api/admin/users', { cookie: admin });
  assert.deepEqual(users.json.map((u) => u.username).sort(), ['admin', 'ben']);
  const decks = await call(port, 'GET', 'api/admin/decks', { cookie: admin });
  assert.deepEqual(decks.json.map((d) => [d.id, d.cards]), [['d1', 1]]);

  const give = await call(port, 'POST', 'api/admin/decks/d1/assign', { cookie: admin, body: { userIds: [ben.json.user.id] } });
  assert.equal(give.status, 204);
  const seen = await call(port, 'GET', 'api/state', { cookie: ben.cookie });
  assert.deepEqual(seen.json.decks.map((d) => [d.id, d.assigned, d.from]), [['d1', true, 'Admin']]);
  assert.equal(seen.json.cards[0].reserved, true);

  assert.equal((await call(port, 'POST', 'api/admin/decks/nope/assign', { cookie: admin, body: { userIds: [] } })).status, 404);
  assert.equal((await call(port, 'POST', 'api/admin/decks/d1/assign', { cookie: admin, body: { userIds: 'x' } })).status, 400);

  const take = await call(port, 'POST', 'api/admin/decks/d1/unassign', { cookie: admin, body: { userIds: [ben.json.user.id] } });
  assert.equal(take.status, 204);
  assert.deepEqual((await call(port, 'GET', 'api/state', { cookie: ben.cookie })).json.decks, []);

  // Invites: create, list, revoke; uses must be 1-20.
  const made = await call(port, 'POST', 'api/admin/invites', { cookie: admin, body: { uses: 3 } });
  assert.equal(made.status, 201);
  assert.match(made.json.code, /^[A-Z2-9]{8}$/);
  for (const uses of [0, 21, 1.5, '2']) {
    assert.equal((await call(port, 'POST', 'api/admin/invites', { cookie: admin, body: { uses } })).status, 400);
  }
  const listed = await call(port, 'GET', 'api/admin/invites', { cookie: admin });
  assert.equal(listed.json.find((i) => i.code === made.json.code).usesLeft, 3);
  assert.equal((await call(port, 'DELETE', `api/admin/invites/${made.json.code}`, { cookie: admin })).status, 204);
  const after = await call(port, 'GET', 'api/admin/invites', { cookie: admin });
  assert.equal(after.json.find((i) => i.code === made.json.code).revoked, true);

  // Password reset signs the person out and lets them in with the new one.
  const reset = (id, password) => call(port, 'POST', `api/admin/users/${id}/password`, { cookie: admin, body: { password } });
  assert.equal((await reset('no-such-user', 'new-password')).status, 404);
  assert.equal((await reset(ben.json.user.id, 'short')).status, 400);
  assert.equal((await reset(ben.json.user.id, 'new-password')).status, 204);
  assert.equal((await call(port, 'GET', 'api/state', { cookie: ben.cookie })).status, 401);
  assert.equal((await logIn(port, 'ben', 'new-password')).status, 200);
});

test('login is rate limited', async (t) => {
  const { port } = await start(t);
  for (let i = 0; i < 10; i++) assert.equal((await logIn(port, 'admin', 'wrong-password')).status, 401);
  const res = await logIn(port, 'admin', 'admin-password');
  assert.equal(res.status, 429);
  assert.deepEqual(res.json, { error: 'rate-limited' });
});

test('requests for another host are refused', async (t) => {
  const { port, invite } = await start(t);
  assert.equal((await call(port, 'GET', '', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await call(port, 'GET', 'api/me', { headers: { Host: 'evil.example' } })).status, 403);
  const { cookie } = await signUp(port, invite);
  // Another website's page cannot make changes, even with the person's cookie.
  const forged = await call(port, 'POST', 'api/sync', { cookie, body: { decks: [deck] }, headers: { Origin: 'https://evil.example' } });
  assert.equal(forged.status, 403);
  const crossSite = await call(port, 'GET', 'api/state', { cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const own = await call(port, 'POST', 'api/sync', { cookie, body: { decks: [deck] }, headers: { Origin: `http://localhost:${port}`, Host: `localhost:${port}` } });
  assert.equal(own.status, 200);
});

test('static files stay inside the folders they are served from', async (t) => {
  const { port } = await start(t);
  for (const path of [
    'js/..%2F..%2Fpackage.json', 'js/..%2Fserver%2Fauth.js', 'js/..%2F..%2Fdata%2Frecall.db',
    'css/%2e%2e/%2e%2e/package.json', 'js/..%5C..%5Cpackage.json', 'js/app.js%00', 'server.js', 'data/recall.db',
  ]) {
    assert.equal((await call(port, 'GET', path)).status, 404, path);
  }
  assert.equal((await call(port, 'GET', 'js/app.js')).status, 200);
  assert.equal((await call(port, 'GET', 'index.html')).status, 200);
  assert.equal((await call(port, 'GET', 'api/media/..%2F..%2Fpackage.json', { cookie: (await logIn(port, 'admin', 'admin-password')).cookie })).status, 404);
});

test('tts audio is cacheable on the phone', async (t) => {
  const { port, invite } = await start(t);
  const { cookie } = await signUp(port, invite);
  const saved = await call(port, 'GET', 'api/tts?text=hola&lang=es-ES', { cookie });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers['content-type'], 'audio/mpeg');
  assert.equal(saved.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.equal(saved.text, 'x');
  const unsaved = await call(port, 'GET', 'api/tts?text=hola&lang=es-ES&save=0', { cookie });
  assert.equal(unsaved.headers['cache-control'], 'no-store');
});

test('the session cookie is Secure when served over https', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'recall-http-'));
  const db = openDb(join(dataDir, 'recall.db'));
  const invite = createInvite(db, {}, NOW);
  const server = createRecallServer({ dataDir, origin: 'https://recall.example', tts: fakeTts });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const { port } = server.address();
  const res = await call(port, 'POST', 'api/signup', {
    body: { code: invite, username: 'ben', name: 'Ben', password: 'ben-password' },
    headers: { Host: 'recall.example', Origin: 'https://recall.example' },
  });
  assert.equal(res.status, 201);
  assert.match(res.setCookie, /; Secure$/);
});
