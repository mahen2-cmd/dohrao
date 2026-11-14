import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecallServer } from '../server.js';
import { openDb } from '../server/db.js';
import { createUser, createInvite } from '../server/auth.js';
import { applyChanges } from '../server/sync.js';

const NOW = Date.now();
const fakeTts = { speak: async () => ({ body: Buffer.from('x'), type: 'audio/mpeg' }), engine: async () => 'Fake' };

/** A server on a free port with a temp data folder, an admin and an invite. */
async function start(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'recall-http-'));
  const db = openDb(join(dataDir, 'recall.db'));
  const admin = await createUser(db, { username: 'admin', name: 'Admin', password: 'admin-password', role: 'admin' }, NOW);
  const invite = createInvite(db, { uses: 5 }, NOW);
  const server = createRecallServer({ dataDir, tts: fakeTts, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { port: server.address().port, db, admin, invite, server };
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
    ['GET', 'api/admin/progress'], ['GET', 'api/admin/progress/x'],
  ]) {
    const res = await call(port, method, path, { cookie, body: {} });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  assert.equal((await call(port, 'GET', 'api/admin/users')).status, 401);
});

test('POST /api/admin/decks/:id/urdu needs the owner', async (t) => {
  const { port, invite } = await start(t);
  const admin = (await logIn(port, 'admin', 'admin-password')).cookie;
  const ben = await signUp(port, invite);
  const url = 'api/admin/decks/d1/urdu';
  assert.equal((await call(port, 'POST', url, { cookie: ben.cookie, body: { userId: 'x', on: true } })).status, 403);
  await call(port, 'POST', 'api/sync', { cookie: admin, body: { decks: [deck], cards: [card] } });
  const id = ben.json.user.id;
  for (const body of [{}, { userId: id }, { userId: 5, on: true }, { userId: id, on: 'yes' }]) {
    assert.equal((await call(port, 'POST', url, { cookie: admin, body })).status, 400);
  }
  assert.equal((await call(port, 'POST', url, { cookie: admin, body: { userId: id, on: true } })).status, 400, 'not given');
  assert.equal((await call(port, 'POST', 'api/admin/decks/nope/urdu', { cookie: admin, body: { userId: id, on: true } })).status, 404);
  await call(port, 'POST', 'api/admin/decks/d1/assign', { cookie: admin, body: { userIds: [id] } });
  assert.equal((await call(port, 'POST', url, { cookie: admin, body: { userId: id, on: true } })).status, 204);
  assert.equal((await call(port, 'GET', 'api/state', { cookie: ben.cookie })).json.decks[0].urduSwitch, true);
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

test('phones can add the app to the home screen with a proper icon', async (t) => {
  const { port } = await start(t);
  const page = (await call(port, 'GET', '')).text;
  assert.match(page, /<link rel="manifest" href="manifest\.webmanifest"/);
  assert.match(page, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png"/);

  const manifest = await call(port, 'GET', 'manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers['content-type'], 'application/manifest+json');
  const json = JSON.parse(manifest.text);
  assert.equal(json.name, 'Dohrao');
  assert.equal(json.display, 'standalone');
  for (const icon of json.icons) {
    const file = await call(port, 'GET', icon.src);
    assert.equal(file.status, 200, icon.src);
    assert.equal(file.headers['content-type'], 'image/png');
  }
  assert.ok(json.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  assert.equal((await call(port, 'GET', 'icons/apple-touch-icon.png')).headers['content-type'], 'image/png');
});

test('the app files are cached by the phone and revalidated with an ETag', async (t) => {
  const { port, invite } = await start(t);
  const first = await call(port, 'GET', 'js/app.js');
  assert.equal(first.status, 200);
  assert.equal(first.headers['cache-control'], 'no-cache');
  const etag = first.headers.etag;
  assert.match(etag, /^"[^"]+"$/);
  assert.equal((await call(port, 'GET', 'js/app.js')).headers.etag, etag);

  const again = await call(port, 'GET', 'js/app.js', { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.text, '');
  assert.equal(again.headers.etag, etag);
  // The ETag Caddy hands out for a compressed copy matches too.
  const gzipped = `W/${etag.slice(0, -1)}-gzip"`;
  assert.equal((await call(port, 'GET', 'js/app.js', { headers: { 'If-None-Match': gzipped } })).status, 304);
  assert.equal((await call(port, 'GET', 'js/app.js', { headers: { 'If-None-Match': '"other"' } })).status, 200);

  const page = await call(port, 'GET', '');
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-cache');
  assert.ok(page.headers.etag);
  assert.equal((await call(port, 'GET', 'index.html', { headers: { 'If-None-Match': page.headers.etag } })).status, 304);

  // Libraries in vendor/ change only with a release, so they are kept for longer.
  const library = await call(port, 'GET', 'vendor/katex/katex.min.js');
  assert.equal(library.status, 200);
  assert.match(library.headers['cache-control'], /^public, max-age=\d+$/);
  assert.ok(library.headers.etag);

  // A matching ETag never opens files outside the served folders, and the API is never cached.
  assert.equal((await call(port, 'GET', 'server.js', { headers: { 'If-None-Match': etag } })).status, 404);
  assert.equal((await call(port, 'GET', 'data/recall.db', { headers: { 'If-None-Match': '*' } })).status, 404);
  const { cookie } = await signUp(port, invite);
  const state = await call(port, 'GET', 'api/state', { cookie });
  assert.equal(state.headers['cache-control'], 'no-store');
  assert.equal(state.headers.etag, undefined);
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

test('sign-up says which field is wrong', async (t) => {
  const { port, invite } = await start(t);
  const signUpWith = (over) =>
    call(port, 'POST', 'api/signup', { body: { code: invite, username: 'ben', name: 'Ben', password: 'ben-password', ...over } });
  assert.deepEqual([(await signUpWith({ name: ' ' })).status, (await signUpWith({ name: ' ' })).json], [400, { error: 'bad-name' }]);
  assert.deepEqual((await signUpWith({ username: 'Ben Smith' })).json, { error: 'bad-username' });
  assert.deepEqual((await signUpWith({ password: 'short' })).json, { error: 'weak-password' });
});

test("the admin sees everyone's progress, and one person's cards", async (t) => {
  const { port, invite } = await start(t);
  const admin = (await logIn(port, 'admin', 'admin-password')).cookie;
  const ben = await signUp(port, invite);
  await call(port, 'POST', 'api/sync', { cookie: admin, body: { decks: [deck], cards: [card] } });
  await call(port, 'POST', 'api/admin/decks/d1/assign', { cookie: admin, body: { userIds: [ben.json.user.id] } });

  const all = await call(port, 'GET', 'api/admin/progress', { cookie: admin });
  assert.equal(all.status, 200);
  const row = all.json.find((p) => p.user.username === 'ben');
  assert.deepEqual([row.decks[0].id, row.decks[0].total, row.decks[0].reserve], ['d1', 1, 1]);

  const one = await call(port, 'GET', `api/admin/progress/${ben.json.user.id}`, { cookie: admin });
  assert.equal(one.status, 200);
  assert.deepEqual(one.json.cards, []);
  assert.equal((await call(port, 'GET', 'api/admin/progress/nobody', { cookie: admin })).status, 404);
});

/** A sorter that counts calls and puts every card it is shown into a new topic. */
function fakeSorter() {
  const calls = { place: 0, propose: 0, group: 0 };
  return {
    calls,
    async placeCards({ cards }) {
      calls.place++;
      return { placements: cards.map((c) => ({ id: c.id, topic: 'new:1' })), newTopics: [{ ref: 'new:1', name: 'Greetings', groupId: null }] };
    },
    async proposeTopics() {
      calls.propose++;
      return { groups: [{ id: 'g1', name: 'Words' }], topics: [{ id: 't1', name: 'Hello', groupId: 'g1' }] };
    },
    async groupTopics() {
      calls.group++;
      return [];
    },
  };
}

/** Wait until the sort for a deck is no longer running. */
async function sortDone(port, cookie, deckId = 'd1') {
  for (let i = 0; i < 200; i++) {
    const res = await call(port, 'GET', `api/admin/decks/${deckId}/sort`, { cookie });
    if (!res.json.running) return res.json;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('sort never finished');
}

test('sorting is refused to non-admins and for decks the admin does not own', async (t) => {
  const sorter = fakeSorter();
  const { port, db, admin: adminUser, invite } = await start(t, { sorter });
  const admin = (await logIn(port, 'admin', 'admin-password')).cookie;
  const ben = await signUp(port, invite);
  for (const [method, path] of [
    ['POST', 'api/admin/decks/d1/sort'], ['GET', 'api/admin/decks/d1/sort'], ['POST', 'api/admin/decks/d1/propose'],
    ['GET', 'api/admin/decks/d1/proposal'], ['POST', 'api/admin/decks/d1/proposal/approve'],
  ]) {
    assert.equal((await call(port, method, path, { cookie: ben.cookie, body: {} })).status, 403, path);
  }
  // A deck owned by Ben and given to the admin is still not the admin's to sort.
  applyChanges(db, ben.json.user.id, { decks: [{ ...deck, id: 'b1' }], cards: [{ ...card, id: 'bc', deckId: 'b1' }] }, NOW);
  db.prepare('INSERT INTO assignments (deck_id, user_id, active, assigned) VALUES (?, ?, 1, ?)').run('b1', adminUser.id, NOW);
  for (const id of ['b1', 'missing']) {
    for (const [method, tail] of [['POST', 'sort'], ['GET', 'sort'], ['POST', 'propose'], ['GET', 'proposal']]) {
      assert.equal((await call(port, method, `api/admin/decks/${id}/${tail}`, { cookie: admin, body: {} })).status, 404, `${id} ${tail}`);
    }
    assert.equal((await call(port, 'POST', `api/admin/decks/${id}/proposal/approve`, { cookie: admin, body: { groups: [], topics: [] } })).status, 404);
  }
  assert.deepEqual(sorter.calls, { place: 0, propose: 0, group: 0 });
});

/** The test deck with one topic, so it can be sorted without a proposal first. */
const topical = { ...deck, topics: [{ id: 't0', name: 'Other', groupId: null, by: 'admin' }], topicsAt: NOW };

test('sorting a deck with no topics is refused; it needs a proposal first', async (t) => {
  const sorter = fakeSorter();
  const { port } = await start(t, { sorter });
  const admin = (await logIn(port, 'admin', 'admin-password')).cookie;
  await call(port, 'POST', 'api/sync', { cookie: admin, body: { decks: [deck], cards: [card] } });
  const res = await call(port, 'POST', 'api/admin/decks/d1/sort', { cookie: admin });
  assert.deepEqual([res.status, res.json], [409, { error: 'no-topics' }]);
  assert.deepEqual(await sortDone(port, admin), { running: false, unsorted: 1 });
  assert.equal(sorter.calls.place, 0);
});

test('the admin sorts a deck in the background', async (t) => {
  const sorter = fakeSorter();
  const { port } = await start(t, { sorter });
  const admin = (await logIn(port, 'admin', 'admin-password')).cookie;
  await call(port, 'POST', 'api/sync', { cookie: admin, body: { decks: [topical], cards: [card] } });
  assert.equal((await call(port, 'GET', 'api/admin/decks/d1/sort', { cookie: admin })).json.unsorted, 1);
  const started = await call(port, 'POST', 'api/admin/decks/d1/sort', { cookie: admin });
  assert.equal(started.status, 202);
  assert.deepEqual(started.json, { running: true });
  assert.deepEqual(await sortDone(port, admin), { running: false, unsorted: 0 });
  const state = await call(port, 'GET', 'api/state', { cookie: admin });
  const sorted = state.json.cards.find((c) => c.id === 'c1');
  assert.equal(state.json.decks[0].topics.find((x) => x.id === sorted.topic).name, 'Greetings');
  assert.equal(sorted.topicBy, 'ai');
});

test('a failing sort ends without crashing the server', async (t) => {
  const sorter = { ...fakeSorter(), async placeCards() { throw new Error('network down'); } };
  const { port } = await start(t, { sorter });
  const admin = (await logIn(port, 'admin', 'admin-password')).cookie;
  await call(port, 'POST', 'api/sync', { cookie: admin, body: { decks: [topical], cards: [card] } });
  const log = console.error;
  console.error = () => {};
  try {
    await call(port, 'POST', 'api/admin/decks/d1/sort', { cookie: admin });
    assert.deepEqual(await sortDone(port, admin), { running: false, unsorted: 1 });
  } finally {
    console.error = log;
  }
});

test('sorting without a key answers 503 and the app still works', async (t) => {
  const { port } = await start(t, { sorter: null });
  const admin = (await logIn(port, 'admin', 'admin-password')).cookie;
  await call(port, 'POST', 'api/sync', { cookie: admin, body: { decks: [deck], cards: [card] } });
  for (const tail of ['sort', 'propose']) {
    const res = await call(port, 'POST', `api/admin/decks/d1/${tail}`, { cookie: admin });
    assert.deepEqual([res.status, res.json], [503, { error: 'no-sorter' }]);
  }
  const res = await call(port, 'POST', 'api/admin/decks/d1/proposal/approve', { cookie: admin, body: { groups: [], topics: [] } });
  assert.equal(res.status, 503);
  assert.deepEqual((await call(port, 'GET', 'api/admin/decks/d1/sort', { cookie: admin })).json, { running: false, unsorted: 1 });
  assert.equal((await call(port, 'GET', 'api/state', { cookie: admin })).status, 200);
});

test('approving a proposal writes the topics and starts a sort', async (t) => {
  const sorter = fakeSorter();
  const { port } = await start(t, { sorter });
  const admin = (await logIn(port, 'admin', 'admin-password')).cookie;
  await call(port, 'POST', 'api/sync', { cookie: admin, body: { decks: [deck], cards: [card] } });
  assert.equal((await call(port, 'GET', 'api/admin/decks/d1/proposal', { cookie: admin })).status, 404);
  const made = await call(port, 'POST', 'api/admin/decks/d1/propose', { cookie: admin });
  assert.equal(made.status, 200);
  assert.equal(made.json.topics[0].name, 'Hello');
  const got = await call(port, 'GET', 'api/admin/decks/d1/proposal', { cookie: admin });
  assert.deepEqual(got.json, made.json);

  const badBody = { groups: [], topics: [{ id: 't', name: '', groupId: null }] };
  assert.equal((await call(port, 'POST', 'api/admin/decks/d1/proposal/approve', { cookie: admin, body: badBody })).status, 400);

  const body = { groups: made.json.groups, topics: made.json.topics };
  assert.equal((await call(port, 'POST', 'api/admin/decks/d1/proposal/approve', { cookie: admin, body })).status, 204);
  await sortDone(port, admin);
  const state = await call(port, 'GET', 'api/state', { cookie: admin });
  const names = state.json.decks[0].topics.map((x) => [x.name, x.by]).sort();
  assert.deepEqual(names, [['Greetings', 'ai'], ['Hello', 'admin']]);
  assert.equal((await call(port, 'GET', 'api/admin/decks/d1/proposal', { cookie: admin })).status, 404);
  assert.equal(sorter.calls.place, 1);
});

test('a sync on an urdu deck queues its new cards', async (t) => {
  const translator = { async toUrdu(text) { return { urdu: `ur:${text}`, urduRoman: `rom:${text}` }; } };
  const { port, invite, server } = await start(t, { translator });
  const { cookie } = await signUp(port, invite);
  const ptDeck = { id: 'd1', name: 'Portuguese', created: NOW, frontLang: 'en-US', backLang: 'pt-PT', urdu: true };
  const ptCard = { id: 'c1', deckId: 'd1', front: 'hello', back: 'olá', created: NOW, updated: NOW };
  const sync = await call(port, 'POST', 'api/sync', { cookie, body: { decks: [ptDeck], cards: [ptCard] } });
  assert.deepEqual(sync.json, { rejected: [] });
  assert.deepEqual(await server.urduQueue.idle(), { translated: 1, failed: 0 });
  const state = await call(port, 'GET', 'api/state', { cookie });
  assert.equal(state.json.cards[0].urdu, 'ur:olá');
  assert.equal(state.json.cards[0].urduBy, 'google');
});
