import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { applyChanges } from '../server/sync.js';
import { createUrduQueue } from '../server/urdu-queue.js';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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

test('a card whose Portuguese changes while it is being translated is translated again', async () => {
  const { db, ana } = await seed([cardOf('c1', 'd1', 'Olá')]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let asked;
  const asking = new Promise((resolve) => { asked = resolve; });
  const sent = [];
  const translator = {
    async toUrdu(text) {
      sent.push(text);
      if (sent.length === 1) { asked(); await gate; }
      return { urdu: `ur:${text}`, urduRoman: '' };
    },
  };
  const queue = queueFor(db, translator);
  queue.scanDeck('d1');
  await asking;
  assert.deepEqual(applyChanges(db, ana.id, { cards: [cardOf('c1', 'd1', 'Olá a todos')] }, NOW), { rejected: [] });
  queue.scanDeck('d1'); // skipped: the card is still queued
  release();
  assert.deepEqual(await queue.idle(), { translated: 1, failed: 0 });
  assert.deepEqual(sent, ['Olá', 'Olá a todos']);
  assert.equal(stored(db, 'c1').urdu, 'ur:Olá a todos');
  assert.equal(stored(db, 'c1').urduOf, 'Olá a todos');
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
  let clock = NOW;
  const queue = queueFor(db, translator, { now: () => clock, log: (...args) => logged.push(args.join(' ')) });
  queue.scanDeck('d1');
  assert.deepEqual(await queue.idle(), { translated: 2, failed: 1 });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /c2.*google-503/);
  assert.equal(stored(db, 'c2').urdu, undefined);
  clock += 5 * MINUTE;
  queue.scanDeck('d1');
  assert.deepEqual(await queue.idle(), { translated: 1, failed: 0 });
  assert.equal(stored(db, 'c2').urdu, 'ur:Adeus');
});

test('a failed card is skipped until its retry time, which doubles with each failure', async () => {
  const { db } = await seed([cardOf('c1', 'd1', 'Olá')]);
  const sent = [];
  let failing = true;
  const translator = {
    async toUrdu(text) {
      sent.push(text);
      if (failing) throw new Error('google-429');
      return { urdu: `ur:${text}`, urduRoman: '' };
    },
  };
  let clock = NOW;
  const queue = queueFor(db, translator, { now: () => clock });
  const scan = async () => { queue.scanDeck('d1'); return queue.idle(); };
  assert.deepEqual(await scan(), { translated: 0, failed: 1 });
  clock += 5 * MINUTE - 1;
  assert.deepEqual(await scan(), { translated: 0, failed: 0 }); // too soon: not sent
  assert.equal(sent.length, 1);
  clock += 1;
  assert.deepEqual(await scan(), { translated: 0, failed: 1 }); // second failure: wait 10 minutes
  clock += 10 * MINUTE - 1;
  assert.deepEqual(await scan(), { translated: 0, failed: 0 });
  assert.equal(sent.length, 2);
  failing = false;
  clock += 1;
  assert.deepEqual(await scan(), { translated: 1, failed: 0 });
  assert.equal(stored(db, 'c1').urdu, 'ur:Olá');
  queue.stop();
});

test('the wait for a failed card is capped at 6 hours and cleared by a success', async () => {
  const { db, ana } = await seed([cardOf('c1', 'd1', 'Olá')]);
  let failing = true;
  const sent = [];
  const translator = {
    async toUrdu(text) {
      sent.push(text);
      if (failing) throw new Error('google-429');
      return { urdu: `ur:${text}`, urduRoman: '' };
    },
  };
  let clock = NOW;
  const queue = queueFor(db, translator, { now: () => clock });
  const scan = async () => { queue.scanDeck('d1'); return queue.idle(); };
  // Each failure doubles the card's wait from 5 minutes, up to 6 hours (the eighth would be 640).
  for (const wait of [5, 10, 20, 40, 80, 160, 320, 360, 360]) {
    assert.equal((await scan()).failed, 1);
    const tries = sent.length;
    clock += wait * MINUTE - 1;
    assert.deepEqual(await scan(), { translated: 0, failed: 0 });
    assert.equal(sent.length, tries);
    clock += 1;
  }
  failing = false;
  assert.deepEqual(await scan(), { translated: 1, failed: 0 });
  // After the success the card starts afresh: its next failure waits 5 minutes again.
  failing = true;
  assert.deepEqual(applyChanges(db, ana.id, { cards: [cardOf('c1', 'd1', 'Olá a todos')] }, NOW), { rejected: [] });
  assert.equal((await scan()).failed, 1);
  const tries = sent.length;
  clock += 5 * MINUTE - 1;
  assert.equal((await scan()).failed, 0);
  clock += 1;
  assert.equal((await scan()).failed, 1);
  assert.equal(sent.length, tries + 1);
  queue.stop();
});

test('three failures in a row pause the whole queue for 10 minutes', async () => {
  const cards = ['Um', 'Dois', 'Três', 'Quatro', 'Cinco'].map((back, i) => cardOf(`c${i + 1}`, 'd1', back));
  const { db, ana } = await seed(cards);
  const sent = [];
  let failing = true;
  const translator = {
    async toUrdu(text) {
      sent.push(text);
      if (failing) throw new Error('google-503');
      return { urdu: `ur:${text}`, urduRoman: '' };
    },
  };
  const logged = [];
  let clock = NOW;
  const queue = queueFor(db, translator, { now: () => clock, log: (...args) => logged.push(args.join(' ')) });
  queue.scanDeck('d1');
  // idle resolves while paused: there is nothing the queue may do now.
  assert.deepEqual(await queue.idle(), { translated: 0, failed: 3 });
  assert.deepEqual(sent, ['Um', 'Dois', 'Três']);
  assert.match(logged.at(-1), /paused/i);
  // A scan during the pause may record a new card, but nothing is sent.
  assert.deepEqual(applyChanges(db, ana.id, { cards: [cardOf('c6', 'd1', 'Seis')] }, NOW), { rejected: [] });
  clock += 10 * MINUTE - 1;
  queue.scanDeck('d1');
  assert.deepEqual(await queue.idle(), { translated: 0, failed: 0 });
  assert.equal(sent.length, 3);
  // When the pause ends, the waiting cards go, and the failed ones too: their 5 minutes are up.
  failing = false;
  clock += 1;
  queue.scanDeck('d1');
  assert.deepEqual(await queue.idle(), { translated: 6, failed: 0 });
  assert.deepEqual(sent.slice(3).sort(), ['Cinco', 'Dois', 'Quatro', 'Seis', 'Três', 'Um']);
  queue.stop();
});

test('a card changed to new Portuguese is translated again; a manual one is not', async () => {
  const { db, ana } = await seed([cardOf('c1', 'd1', 'Olá'), cardOf('c2', 'd1', 'Adeus')]);
  const translator = fakeTranslator();
  const queue = queueFor(db, translator);
  queue.scanDeck('d1');
  assert.deepEqual(await queue.idle(), { translated: 2, failed: 0 });

  const manual = { urdu: 'خدا حافظ', urduRoman: 'khuda hafiz', urduOf: 'Adeus', urduBy: 'manual', urduAt: NOW + 100 };
  const changes = { cards: [cardOf('c1', 'd1', 'Olá a todos'), cardOf('c2', 'd1', 'Adeus a todos', manual)] };
  assert.deepEqual(applyChanges(db, ana.id, changes, NOW + 20), { rejected: [] });
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
  assert.deepEqual(await run('Portuguese'), { translated: 2, failed: 0, alreadyDone: 0, left: 0 });
  assert.deepEqual(await run('Portuguese'), { translated: 0, failed: 0, alreadyDone: 2, left: 0 });
});

test('the script reports the cards left when Google keeps failing, instead of waiting', async () => {
  const { translateDeck } = await import('../scripts/translate-urdu.js');
  const cards = ['Um', 'Dois', 'Três', 'Quatro', 'Cinco'].map((back, i) => cardOf(`c${i + 1}`, 'd1', back));
  const { db } = await seed(cards);
  const translator = { async toUrdu() { throw new Error('google-503'); } };
  const result = await translateDeck(db, { deckName: 'Portuguese', translator, pauseMs: 0, log: () => {} });
  assert.deepEqual(result, { translated: 0, failed: 3, alreadyDone: 0, left: 2 });
});
