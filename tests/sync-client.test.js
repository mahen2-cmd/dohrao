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

/** A browser storage kept in memory. */
class MemoryStorage {
  #items = new Map();
  getItem(key) { return this.#items.has(key) ? this.#items.get(key) : null; }
  setItem(key, value) { this.#items.set(key, String(value)); }
  removeItem(key) { this.#items.delete(key); }
  keys() { return [...this.#items.keys()]; }
}

const realFetch = globalThis.fetch;
const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let storage;
test.beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
});
test.after(() => {
  globalThis.fetch = realFetch;
  if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage);
  else delete globalThis.localStorage;
});

/**
 * Stand in for the server: `answer(url, options)` gives each response, and `api/me` answers as
 * user `me` (signed out when null). Records every request, with its parsed body, in `calls`.
 */
function serve(answer, { me = 'u1' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body && JSON.parse(options.body) });
    if (url === 'api/me') return me ? json(200, { user: { id: me, name: me } }) : json(401, { error: 'signed-out' });
    return answer(url, options);
  };
  return calls;
}

const syncs = (calls) => calls.filter((c) => c.url === 'api/sync');
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('load reports signed out on 401', async () => {
  serve(() => json(401, { error: 'signed-out' }), { me: null });
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

test('changes not yet sent are kept in the browser under the user, until the server has them', async () => {
  let online = false;
  serve((url) => {
    if (url === 'api/state') return json(200, view());
    if (!online) throw new TypeError('network down');
    return json(200, { rejected: [] });
  });
  await store.load();
  store.answerCard('c1', Rating.Good, T0);
  await settle();
  assert.deepEqual(storage.keys(), ['recall.pending.u1']);
  const kept = JSON.parse(storage.getItem('recall.pending.u1'));
  assert.deepEqual(kept.cards.map((c) => c.id), ['c1']);
  assert.ok(kept.daily);

  online = true;
  await store.flush();
  assert.deepEqual(storage.keys(), []);
});

test("load lays the user's unsent changes over the server's state and sends them", async () => {
  const unsent = { cards: [{ ...view().cards[0], front: 'offline edit' }], daily: { '2026-01-01': 2 }, savedAt: T0 };
  storage.setItem('recall.pending.u1', JSON.stringify(unsent));
  storage.setItem('recall.pending.u2', JSON.stringify({ cards: [{ ...view().cards[1], front: 'not yours' }] }));
  const calls = serve((url) => {
    if (url === 'api/state') return json(200, { ...view(), daily: { '2026-01-01': 5, '2025-12-31': 1 } });
    return json(200, { rejected: [] });
  });
  await store.load();
  assert.equal(store.card('c1').front, 'offline edit');
  assert.equal(store.card('c2').front, 'dois');
  // Counts from the server and from here are merged, keeping the larger.
  assert.equal(store.stats(new Date(2026, 0, 1, 12).getTime()).reviewedToday, 5);
  await settle();
  const [sent] = syncs(calls);
  assert.deepEqual(sent.body.cards.map((c) => `${c.id}:${c.front}`), ['c1:offline edit']);
  assert.equal(storage.getItem('recall.pending.u1'), null);
  assert.ok(storage.getItem('recall.pending.u2'));
});

test('logging out sends what is left and forgets it', async () => {
  const calls = serve((url) => (url === 'api/state' ? json(200, view()) : url === 'api/logout' ? new Response(null, { status: 204 }) : json(200, { rejected: [] })));
  await store.load();
  storage.setItem('recall.pending.u1', '{"cards":[]}');
  await store.logOut();
  assert.ok(calls.some((c) => c.url === 'api/logout' && c.method === 'POST'));
  assert.deepEqual(storage.keys(), []);
  assert.equal(store.decks().length, 0);
  assert.equal(store.storageInfo().available, false);
});

test('logging out with answers the server has not taken keeps them and stays signed in', async () => {
  let online = false;
  const calls = serve((url) => {
    if (url === 'api/state') return json(200, view());
    if (url === 'api/logout') return new Response(null, { status: 204 });
    if (!online) return json(502, { error: 'bad-gateway' });
    return json(200, { rejected: [] });
  });
  await store.load();
  store.answerCard('c1', Rating.Good, T0);
  await settle();
  await assert.rejects(store.logOut(), { message: 'unsaved' });
  assert.ok(!calls.some((c) => c.url === 'api/logout'));
  assert.equal(store.storageInfo().available, true);
  assert.equal(store.card('c1').reps, 1);
  const kept = JSON.parse(storage.getItem('recall.pending.u1'));
  assert.deepEqual(kept.cards.map((c) => c.id), ['c1']);

  // Once the server can be reached, logging out sends the answer first.
  online = true;
  await store.logOut();
  const order = calls.filter((c) => c.url === 'api/sync' || c.url === 'api/logout').map((c) => c.url);
  assert.deepEqual(order.slice(-2), ['api/sync', 'api/logout']);
  assert.deepEqual(syncs(calls).at(-1).body.cards.map((c) => c.id), ['c1']);
  assert.deepEqual(storage.keys(), []);
  assert.equal(store.storageInfo().available, false);
});

test('logging out while a save is on its way waits for it and sends changes made meanwhile', async () => {
  let release;
  let loggedOut = false;
  const calls = serve(async (url) => {
    if (url === 'api/state') return json(200, view());
    if (url === 'api/logout') {
      loggedOut = true;
      return new Response(null, { status: 204 });
    }
    if (loggedOut) return json(401, { error: 'signed-out' });
    if (syncs(calls).length === 1) await new Promise((resolve) => (release = resolve));
    return json(200, { rejected: [] });
  });
  await store.load();
  store.updateCard('c1', { front: 'first' });
  await settle();
  store.updateCard('c2', { front: 'during' });
  const out = store.logOut();
  await settle();
  release();
  await out;
  const order = calls.filter((c) => c.url === 'api/sync' || c.url === 'api/logout');
  assert.deepEqual(order.map((c) => c.url), ['api/sync', 'api/sync', 'api/logout']);
  assert.deepEqual(order[1].body.cards.map((c) => `${c.id}:${c.front}`), ['c2:during']);
  assert.deepEqual(storage.keys(), []);
  assert.equal(store.storageInfo().available, false);
});

test('refresh takes newer state from the server only when nothing is waiting to be sent', async () => {
  let notified = 0;
  store.onStorageChange(() => notified++);
  let latest = view();
  let online = true;
  serve((url) => {
    if (url === 'api/state') return json(200, latest);
    if (!online) throw new TypeError('network down');
    return json(200, { rejected: [] });
  });
  await store.load();

  latest = { ...view(), cards: [{ ...view().cards[0], reps: 3, state: 2, due: T0 + 86400000 }, view().cards[1]] };
  assert.equal(await store.refresh(), true);
  assert.equal(store.card('c1').reps, 3);
  assert.equal(notified, 1);

  online = false;
  store.updateCard('c2', { front: 'unsent' });
  await settle();
  latest = view();
  assert.equal(await store.refresh(), false);
  assert.equal(store.card('c2').front, 'unsent');
  assert.equal(store.card('c1').reps, 3);
  online = true;
  await store.flush();
});

test('edits made while a refused save is on its way survive the reload', async () => {
  const messages = [];
  store.onStorageChange((message) => message && messages.push(message));
  let release;
  const calls = serve(async (url) => {
    if (url === 'api/state') return json(200, view());
    if (syncs(calls).length === 1) {
      await new Promise((resolve) => (release = resolve));
      return json(200, { rejected: ['c1'] });
    }
    return json(200, { rejected: [] });
  });
  await store.load();
  store.updateCard('c1', { front: 'refused' });
  await settle();
  store.answerCard('c2', Rating.Good, T0);
  release();
  await settle();
  assert.deepEqual(messages, ['Some changes could not be saved']);
  assert.equal(store.card('c1').front, 'um');
  assert.equal(store.card('c2').reps, 1);
  const last = syncs(calls).at(-1).body;
  assert.deepEqual(last.cards.map((c) => c.id), ['c2']);
  assert.ok(last.daily);
});

test('a save the server will never take is dropped, not retried', async () => {
  const messages = [];
  store.onStorageChange((message) => message && messages.push(message));
  let bad = true;
  const calls = serve((url) => {
    if (url === 'api/state') return json(200, view());
    return bad ? json(400, { error: 'bad-request' }) : json(200, { rejected: [] });
  });
  await store.load();
  store.updateCard('c1', { front: 'malformed' });
  await settle();
  assert.equal(syncs(calls).length, 1);
  assert.deepEqual(messages, ['Some changes could not be saved']);
  assert.equal(store.card('c1').front, 'um');
  assert.equal(store.storageInfo().ok, true);
  assert.deepEqual(storage.keys(), []);

  // Later changes are saved as usual.
  bad = false;
  store.updateCard('c2', { front: 'fine' });
  await settle();
  assert.deepEqual(syncs(calls).at(-1).body.cards.map((c) => c.id), ['c2']);
});

test('api calls resolve to the JSON answer and throw the error code', async () => {
  const calls = serve((url) => {
    if (url === 'api/login') return json(401, { error: 'bad-login' });
    if (url === 'api/signup') return json(429, { error: 'rate-limited' });
    if (url === 'api/admin/invites/abc') return new Response(null, { status: 204 });
    return json(500, {});
  });
  assert.deepEqual(await api.me(), { user: { id: 'u1', name: 'u1' } });
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

test('an undone answer sends the restored card', async () => {
  const calls = serve((url) => (url === 'api/state' ? json(200, view()) : json(200, { rejected: [] })));
  await store.load();
  const copy = store.answerCard('c1', Rating.Good, T0);
  await settle();
  store.restoreCard(copy);
  await settle();
  const last = syncs(calls).at(-1);
  assert.deepEqual(last.body.cards.map((c) => c.id), ['c1']);
  assert.equal(last.body.cards[0].state, copy.state);
  assert.equal(last.body.cards[0].due, copy.due);
});

test('sent reviews leave the browser, and undo still deletes them on the server', async () => {
  const calls = serve((url) => (url === 'api/state' ? json(200, view()) : json(200, { rejected: [] })));
  await store.load();
  const copy = store.answerCard('c1', Rating.Good, T0);
  await store.flush();
  assert.equal(syncs(calls).at(-1).body.reviews.length, 1);
  assert.equal(store.reviewLog().length, 0);
  store.answerCard('c2', Rating.Good, T0);
  await store.flush();
  assert.deepEqual(syncs(calls).at(-1).body.reviews.map((r) => r.cardId), ['c2']);
  store.restoreCard(copy);
  await store.flush();
  assert.deepEqual(syncs(calls).at(-1).body.deletedReviews, [copy.reviewId]);
  assert.equal(syncs(calls).at(-1).body.reviews, undefined);
});

test('a long review log goes up in several syncs', async () => {
  const calls = serve((url) => (url === 'api/state' ? json(200, view()) : json(200, { rejected: [] })));
  await store.load();
  const entries = Array.from({ length: 12_000 }, (_, i) => ({
    id: `r${i}`, cardId: 'c1', deckId: 'd1', at: T0 + i, rating: 3, state: 2, elapsed: 1, duration: 1,
    scheduler: null, retention: null, intervalBefore: 1, intervalAfter: 2,
  }));
  store.applyPending({ reviews: entries });
  await store.flush();
  const sizes = syncs(calls).map((c) => c.body.reviews?.length ?? 0);
  assert.ok(sizes.length >= 3, `${sizes}`);
  assert.ok(sizes.every((n) => n <= store.REVIEWS_PER_SYNC), `${sizes}`);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 12_000);
  assert.equal(store.reviewLog().length, 0);
});

test('study time is taken from the server, added to and sent when it changes', async () => {
  const day = store.dayKey(T0);
  const calls = serve((url) => (url === 'api/state' ? json(200, { ...view(), time: { [day]: { d1: 50 } } }) : json(200, { rejected: [] })));
  await store.load();
  store.answerCard('c1', Rating.Good, T0, { active: 5_000 });
  await settle();
  const [sent] = syncs(calls);
  assert.deepEqual(sent.body.time, { [day]: { d1: 55 } });
  assert.equal(sent.body.reviews[0].active, 5_000);

  store.answerCard('c2', Rating.Good, T0);
  await settle();
  assert.equal(syncs(calls)[1].body.time, undefined);
});
