import test from 'node:test';
import assert from 'node:assert/strict';

import { Rating } from '../js/fsrs.js';
import * as store from '../js/store.js';
import * as api from '../js/api.js';

const T0 = new Date(2026, 0, 1, 9, 0, 0).getTime();

const json = (status, body, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const view = () => ({
  version: 1,
  decks: [{ id: 'd1', name: 'Words' }],
  cards: [
    { id: 'c1', deckId: 'd1', front: 'um', back: 'one', created: T0 },
    { id: 'c2', deckId: 'd1', front: 'dois', back: 'two', created: T0 + 1 },
  ],
  daily: {},
  log: {},
  settings: {},
  savedAt: 0,
});

/**
 * Stand in for the server: `answer(url, options)` gives each response. Records every request,
 * with its parsed body, in `calls`.
 */
function serve(answer) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body && JSON.parse(options.body) });
    return answer(url, options);
  };
  return calls;
}

const syncs = (calls) => calls.filter((c) => c.url === 'api/sync');
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('load reports signed out on 401', async () => {
  serve(() => json(401, { error: 'signed-out' }));
  assert.deepEqual(await store.load(), { signedIn: false });
});

test('load takes the state from the server, and saving sends only what changed', async () => {
  const calls = serve((url) => (url === 'api/state' ? json(200, view(), { 'X-Tts-Engine': 'Google' }) : json(200, { rejected: [] })));
  assert.deepEqual(await store.load(), { signedIn: true });
  assert.equal(store.cardsIn('d1').length, 2);
  assert.deepEqual(store.storageInfo(), { available: true, ok: true, signedOut: false, voice: 'Google' });

  // The defaults filled in on load are not sent back.
  await store.flush();
  assert.equal(syncs(calls).length, 0);

  store.answerCard('c1', Rating.Good, T0);
  await settle();
  const [sent] = syncs(calls);
  assert.equal(sent.method, 'POST');
  assert.deepEqual(sent.body.cards.map((c) => c.id), ['c1']);
  assert.equal(sent.body.decks, undefined);
  assert.ok(sent.body.daily);

  // Once saved, it is not sent again.
  await store.flush();
  assert.equal(syncs(calls).length, 1);
});

test('edits made while a save is on its way are sent next', async () => {
  let release;
  const calls = serve(async (url) => {
    if (url === 'api/state') return json(200, view());
    if (syncs(calls).length === 1) await new Promise((resolve) => (release = resolve));
    return json(200, { rejected: [] });
  });
  await store.load();
  store.updateCard('c1', { front: 'first' });
  await settle();
  store.updateCard('c2', { front: 'second' });
  release();
  await settle();
  const sent = syncs(calls).map((c) => c.body.cards.map((card) => `${card.id}:${card.front}`));
  assert.deepEqual(sent, [['c1:first'], ['c2:second']]);
});

test('refused changes reload the state from the server and say so', async () => {
  const messages = [];
  store.onStorageChange((message) => messages.push(message));
  let refuse = true;
  const calls = serve((url) => {
    if (url === 'api/state') return json(200, view());
    return json(200, { rejected: refuse ? ['c1'] : [] });
  });
  await store.load();
  store.updateCard('c1', { front: 'changed' });
  await settle();
  assert.equal(calls.filter((c) => c.url === 'api/state').length, 2);
  assert.equal(store.card('c1').front, 'um');
  assert.deepEqual(messages, ['Some changes could not be saved']);

  // The reloaded state is the new starting point: nothing is resent.
  refuse = false;
  await store.flush();
  assert.equal(syncs(calls).length, 1);
});

test('a save refused for being signed out marks the store signed out', async () => {
  let notified = 0;
  store.onStorageChange(() => notified++);
  serve((url) => (url === 'api/state' ? json(200, view()) : json(401, { error: 'signed-out' })));
  await store.load();
  store.answerCard('c1', Rating.Good, T0);
  await settle();
  assert.equal(store.storageInfo().signedOut, true);
  assert.ok(notified >= 1);
});

test('a failed save is kept and retried', async () => {
  let online = false;
  const calls = serve((url) => {
    if (url === 'api/state') return json(200, view());
    if (!online) throw new TypeError('network down');
    return json(200, { rejected: [] });
  });
  await store.load();
  store.updateCard('c1', { front: 'offline edit' });
  await settle();
  assert.equal(store.storageInfo().ok, false);

  online = true;
  store.updateCard('c2', { front: 'later edit' });
  await settle();
  assert.equal(store.storageInfo().ok, true);
  const last = syncs(calls).at(-1).body.cards.map((c) => c.id).sort();
  assert.deepEqual(last, ['c1', 'c2']);
});

test('api calls resolve to the JSON answer and throw the error code', async () => {
  const calls = serve((url) => {
    if (url === 'api/me') return json(200, { user: { name: 'Ana' } });
    if (url === 'api/login') return json(401, { error: 'bad-login' });
    if (url === 'api/signup') return json(429, { error: 'rate-limited' });
    if (url === 'api/admin/invites/abc') return new Response(null, { status: 204 });
    return json(500, {});
  });
  assert.deepEqual(await api.me(), { user: { name: 'Ana' } });
  await assert.rejects(api.logIn('ana', 'wrong'), { message: 'bad-login' });
  await assert.rejects(api.signUp({ code: 'x', username: 'ana', name: 'Ana', password: 'pw' }), { message: 'rate-limited' });
  await assert.rejects(api.admin.users(), { message: '500' });
  assert.equal(await api.admin.revokeInvite('abc'), null);
  assert.deepEqual(calls.find((c) => c.url === 'api/login').body, { username: 'ana', password: 'wrong' });
  assert.equal(calls.find((c) => c.url === 'api/admin/invites/abc').method, 'DELETE');
});

test('admin calls use the server routes', async () => {
  const calls = serve(() => json(200, {}));
  await api.admin.invites();
  await api.admin.createInvite(3);
  await api.admin.decks();
  await api.admin.assign('d 1', ['u1']);
  await api.admin.unassign('d1', ['u2']);
  await api.admin.resetPassword('u1', 'new-password');
  await api.logOut();
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url} ${JSON.stringify(c.body ?? null)}`),
    [
      'GET api/admin/invites null',
      'POST api/admin/invites {"uses":3}',
      'GET api/admin/decks null',
      'POST api/admin/decks/d%201/assign {"userIds":["u1"]}',
      'POST api/admin/decks/d1/unassign {"userIds":["u2"]}',
      'POST api/admin/users/u1/password {"password":"new-password"}',
      'POST api/logout null',
    ],
  );
});
