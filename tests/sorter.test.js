import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSorter, loadSorter } from '../server/sorter.js';

function fakeClient(reply) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        create: async (req) => {
          requests.push(req);
          return typeof reply === 'function' ? reply(req) : reply;
        },
      },
    },
  };
}
const ok = (obj) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });

const groups = [{ id: 'g1', name: 'Verbs' }];
const topics = [{ id: 't1', name: 'Ser', groupId: 'g1' }, { id: 't2', name: 'Food', groupId: null }];

test('placeCards sends only front and back text and the topic list', async () => {
  const client = fakeClient(ok({ placements: [], newTopics: [] }));
  const sorter = createSorter({ client });
  await sorter.placeCards({
    deckName: 'Spanish', groups, topics,
    cards: [{ id: 'c1', front: 'to be [image:x.png]', back: 'ser', due: 123456, state: 2 }],
  });
  const req = client.requests[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.output_config.effort, 'low');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.max_tokens, 16000);
  assert.equal(req.temperature, undefined);
  assert.equal(req.thinking, undefined);
  const user = JSON.stringify(req.messages);
  assert.ok(user.includes('to be'));
  assert.ok(user.includes('ser'));
  assert.ok(!user.includes('image:'));
  assert.ok(!user.includes('123456'));
  assert.ok(!user.includes('state'));
  assert.ok(user.includes('Ser') && user.includes('Food'));
});

test('ignores placements it cannot use', async () => {
  const client = fakeClient(ok({
    placements: [
      { id: 'nope', topic: 't1' },
      { id: 'c1', topic: 'tX' },
      { id: 'c1', topic: 't1' },
      { id: 'c2', topic: 'new:1' },
      { id: 'c3', topic: 'new:9' },
    ],
    newTopics: [{ ref: 'new:1', name: 'Travel', groupId: 'gX' }],
  }));
  const sorter = createSorter({ client });
  const out = await sorter.placeCards({
    deckName: 'D', groups, topics,
    cards: [{ id: 'c1', front: 'a', back: 'b' }, { id: 'c2', front: 'c', back: 'd' }, { id: 'c3', front: 'e', back: 'f' }],
  });
  assert.deepEqual(out.placements, [{ id: 'c1', topic: 't1' }, { id: 'c2', topic: 'new:1' }]);
  assert.deepEqual(out.newTopics, [{ ref: 'new:1', name: 'Travel', groupId: null }]);
});

test('a refusal or bad JSON gives an empty result', async () => {
  const args = { deckName: 'D', groups, topics, cards: [{ id: 'c1', front: 'a', back: 'b' }] };
  let sorter = createSorter({ client: fakeClient({ stop_reason: 'refusal', content: [] }) });
  assert.deepEqual(await sorter.placeCards(args), { placements: [], newTopics: [] });
  sorter = createSorter({ client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }) });
  assert.deepEqual(await sorter.placeCards(args), { placements: [], newTopics: [] });
  sorter = createSorter({ client: fakeClient(ok({ wrong: 1 })) });
  assert.deepEqual(await sorter.placeCards(args), { placements: [], newTopics: [] });
});

test('API errors propagate', async () => {
  const client = fakeClient(() => { throw new Error('network down'); });
  const sorter = createSorter({ client });
  await assert.rejects(sorter.placeCards({ deckName: 'D', groups, topics, cards: [] }), /network down/);
});

test('proposeTopics returns groups and topics with valid group ids', async () => {
  const client = fakeClient(ok({
    groups: [{ id: 'g1', name: 'Verbs' }],
    topics: [{ id: 't1', name: 'Ser', groupId: 'g1' }, { id: 't2', name: 'Food', groupId: 'g9' }],
  }));
  const sorter = createSorter({ client, model: 'claude-x' });
  const out = await sorter.proposeTopics({ deckName: 'D', cards: [{ id: 'c1', front: 'a', back: 'b' }] });
  assert.equal(client.requests[0].model, 'claude-x');
  assert.deepEqual(out.groups, [{ id: 'g1', name: 'Verbs' }]);
  assert.deepEqual(out.topics, [{ id: 't1', name: 'Ser', groupId: 'g1' }, { id: 't2', name: 'Food', groupId: null }]);
  const empty = createSorter({ client: fakeClient({ stop_reason: 'refusal', content: [] }) });
  assert.deepEqual(await empty.proposeTopics({ deckName: 'D', cards: [] }), { groups: [], topics: [] });
});

test('groupTopics keeps only known topics and groups', async () => {
  const client = fakeClient(ok({ assignments: [
    { id: 't2', groupId: 'g1' }, { id: 'zz', groupId: 'g1' }, { id: 't2', groupId: 'g9' },
  ] }));
  const sorter = createSorter({ client });
  const out = await sorter.groupTopics({ deckName: 'D', groups, topics: [{ id: 't2', name: 'Food' }] });
  assert.deepEqual(out, [{ id: 't2', groupId: 'g1' }]);
  const empty = createSorter({ client: fakeClient({ stop_reason: 'refusal', content: [] }) });
  assert.deepEqual(await empty.groupTopics({ deckName: 'D', groups, topics }), []);
});

function withEnvKey(value, fn) {
  const saved = process.env.ANTHROPIC_API_KEY;
  if (value === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = value;
  try {
    fn(mkdtempSync(join(tmpdir(), 'sorter-')));
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  }
}

test('loadSorter is null without a key', () => {
  withEnvKey(undefined, (dir) => {
    assert.equal(loadSorter(dir), null);
    writeFileSync(join(dir, 'claude.json'), '{ broken');
    assert.equal(loadSorter(dir), null);
  });
});

test('loadSorter reads the key from claude.json or the environment', () => {
  withEnvKey(undefined, (dir) => {
    writeFileSync(join(dir, 'claude.json'), JSON.stringify({ apiKey: 'sk-test', model: 'claude-x' }));
    assert.ok(loadSorter(dir));
  });
  withEnvKey('sk-env', (dir) => assert.ok(loadSorter(dir)));
});
