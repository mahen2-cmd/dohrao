import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { applyChanges } from '../server/sync.js';
import { createUrduQueue } from '../server/urdu-queue.js';

const NOW = 1_700_000_000_000;

const urduDeck = { id: 'd1', name: 'Portuguese', created: NOW, frontLang: 'en-US', backLang: 'pt-PT', urdu: true };
const plainDeck = { id: 'd2', name: 'Other', created: NOW, frontLang: 'en-US', backLang: 'pt-PT' };
const cardOf = (id, deckId, back, over = {}) => ({ id, deckId, front: `English ${id}`, back, created: NOW, updated: NOW, ...over });

/** A translator that answers with marked copies of the text, and records what it was sent. */
function fakeTranslator() {
  const sent = [];
  return { sent, async toUrdu(text) { sent.push(text); return { urdu: `ur:${text}`, urduRoman: `rom:${text}` }; } };
}

/** ana owns an Urdu deck d1 with cards c1, c2 and a plain deck d2 with c3. */
async function seed(cards) {
  const db = openDb(':memory:');
  const ana = await createUser(db, { username: 'ana', name: 'Ana', password: 'password-ana' }, NOW);
  const all = cards ?? [cardOf('c1', 'd1', 'Olá'), cardOf('c2', 'd1', 'Adeus'), cardOf('c3', 'd2', 'Obrigado')];
  assert.deepEqual(applyChanges(db, ana.id, { decks: [urduDeck, plainDeck], cards: all }, NOW), { rejected: [] });
  return { db, ana };
}

const stored = (db, id) => JSON.parse(db.prepare('SELECT data FROM cards WHERE id = ?').get(id).data);
const queueFor = (db, translator, over = {}) =>
  createUrduQueue({ db, translator, pauseMs: 0, now: () => NOW + 10, log: () => {}, ...over });

test('fills every card of an urdu deck and none of another deck', async () => {
  const { db } = await seed();
  const translator = fakeTranslator();
  const queue = queueFor(db, translator);
  queue.scanAll();
  assert.deepEqual(await queue.idle(), { translated: 2, failed: 0 });
  assert.deepEqual(translator.sent.sort(), ['Adeus', 'Olá']);
  const c1 = stored(db, 'c1');
  assert.equal(c1.urdu, 'ur:Olá');
  assert.equal(c1.urduRoman, 'rom:Olá');
  assert.equal(c1.urduOf, 'Olá');
  assert.equal(c1.urduBy, 'google');
  assert.equal(c1.urduAt, NOW + 10);
  assert.equal(stored(db, 'c3').urdu, undefined);
  // Nothing is left to do, so a second scan sends nothing.
  queue.scanDeck('d1');
  assert.deepEqual(await queue.idle(), { translated: 0, failed: 0 });
  assert.equal(translator.sent.length, 2);
});

test('skips cards whose Portuguese is empty and does not call the translator for them', async () => {
  const { db } = await seed([cardOf('c1', 'd1', '[image:a.png]'), cardOf('c2', 'd1', '  '), cardOf('c3', 'd1', 'Sim')]);
  const translator = fakeTranslator();
  const queue = queueFor(db, translator);
  queue.scanDeck('d1');
  assert.deepEqual(await queue.idle(), { translated: 1, failed: 0 });
  assert.deepEqual(translator.sent, ['Sim']);
  assert.equal(stored(db, 'c1').urdu, undefined);
  assert.equal(stored(db, 'c2').urdu, undefined);
});

test('a card edited by hand while queued is not overwritten', async () => {
  const { db, ana } = await seed([cardOf('c1', 'd1', 'Olá')]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let asked;
  const asking = new Promise((resolve) => { asked = resolve; });
  const translator = { async toUrdu(text) { asked(); await gate; return { urdu: `ur:${text}`, urduRoman: '' }; } };
  const queue = queueFor(db, translator);
  queue.scanDeck('d1');
  await asking;
  const manual = { urdu: 'ہیلو', urduRoman: 'hello', urduOf: 'Olá', urduBy: 'manual', urduAt: NOW + 50 };
  assert.deepEqual(applyChanges(db, ana.id, { cards: [cardOf('c1', 'd1', 'Olá', manual)] }, NOW), { rejected: [] });
  release();
  assert.deepEqual(await queue.idle(), { translated: 0, failed: 0 });
  assert.equal(stored(db, 'c1').urduBy, 'manual');
  assert.equal(stored(db, 'c1').urdu, 'ہیلو');
});

test('a failure is counted, logged and retried on the next scan', async () => {
  const { db } = await seed([cardOf('c1', 'd1', 'Olá'), cardOf('c2', 'd1', 'Adeus'), cardOf('c3', 'd1', 'Sim')]);
  const fake = fakeTranslator();
  let thrown = false;
  const translator = {
    async toUrdu(text) {
      if (text === 'Adeus' && !thrown) { thrown = true; throw new Error('google-503'); }
      return fake.toUrdu(text);
    },
  };
  const logged = [];
  const queue = queueFor(db, translator, { log: (...args) => logged.push(args.join(' ')) });
  queue.scanDeck('d1');
  assert.deepEqual(await queue.idle(), { translated: 2, failed: 1 });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /c2.*google-503/);
  assert.equal(stored(db, 'c2').urdu, undefined);
  queue.scanDeck('d1');
  assert.deepEqual(await queue.idle(), { translated: 1, failed: 0 });
  assert.equal(stored(db, 'c2').urdu, 'ur:Adeus');
});

test('a card changed to new Portuguese is translated again; a manual one is not', async () => {
  const { db, ana } = await seed([cardOf('c1', 'd1', 'Olá'), cardOf('c2', 'd1', 'Adeus')]);
  const translator = fakeTranslator();
  const queue = queueFor(db, translator);
  queue.scanDeck('d1');
  assert.deepEqual(await queue.idle(), { translated: 2, failed: 0 });

  const manual = { urdu: 'خدا حافظ', urduRoman: 'khuda hafiz', urduOf: 'Adeus', urduBy: 'manual', urduAt: NOW + 100 };
  const changes = { cards: [cardOf('c1', 'd1', 'Olá a todos'), cardOf('c2', 'd1', 'Adeus a todos', manual)] };
  assert.deepEqual(applyChanges(db, ana.id, changes, NOW), { rejected: [] });
  queue.scanDeck('d1');
  assert.deepEqual(await queue.idle(), { translated: 1, failed: 0 });
  assert.equal(stored(db, 'c1').urdu, 'ur:Olá a todos');
  assert.equal(stored(db, 'c1').urduOf, 'Olá a todos');
  assert.equal(stored(db, 'c2').urdu, 'خدا حافظ');
  assert.equal(stored(db, 'c2').urduBy, 'manual');
});

test('a stopped queue does no more work', async () => {
  const { db } = await seed();
  const translator = fakeTranslator();
  const queue = queueFor(db, translator);
  queue.scanAll();
  queue.stop();
  assert.deepEqual(await queue.idle(), { translated: 0, failed: 0 });
  assert.equal(translator.sent.length, 0);
});

test('the script fills a named deck and refuses one without Urdu', async () => {
  const { translateDeck } = await import('../scripts/translate-urdu.js');
  const { db } = await seed([cardOf('c1', 'd1', 'Olá'), cardOf('c2', 'd1', 'Adeus'), cardOf('c3', 'd2', 'Sim')]);
  const run = (deckName) => translateDeck(db, { deckName, translator: fakeTranslator(), pauseMs: 0, log: () => {} });
  await assert.rejects(run('Missing'), /^Error: No deck named "Missing"$/);
  await assert.rejects(run('Other'), /^Error: Switch on Translate the front into Urdu first$/);
  assert.deepEqual(await run('Portuguese'), { translated: 2, failed: 0, alreadyDone: 0 });
  assert.deepEqual(await run('Portuguese'), { translated: 0, failed: 0, alreadyDone: 2 });
});
