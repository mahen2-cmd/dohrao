import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aiText, filterLabel, inFilter, prefixGroup, readableTopicName, resolveFilter, topicKeyFromFileName } from '../js/topics.js';

const deck = {
  groups: [{ id: 'g1', name: 'Verbs' }, { id: 'g2', name: 'Nature' }],
  topics: [
    { id: 't1', key: 'verb_ser', name: 'Ser', groupId: 'g1', by: 'file' },
    { id: 't2', key: 'verb_ter', name: 'Ter', groupId: 'g1', by: 'file' },
    { id: 't3', key: 'animals', name: 'Animals', groupId: 'g2', by: 'file' },
  ],
};

test('topic keys come from new_cards_<key> file names', () => {
  assert.equal(topicKeyFromFileName('new_cards_verb_ser.csv'), 'verb_ser');
  assert.equal(topicKeyFromFileName('NEW_CARDS_Cafe.XLSX'), 'cafe');
  for (const ext of ['tsv', 'txt']) assert.equal(topicKeyFromFileName(`new_cards_a.${ext}`), 'a');
  assert.equal(topicKeyFromFileName('cards.csv'), null);
  assert.equal(topicKeyFromFileName('new_cards_x.pdf'), null);
});
test('new_cards_all is not a topic', () => assert.equal(topicKeyFromFileName('new_cards_all.csv'), null));

test('readable names drop verb_ and capitalise', () => {
  assert.equal(readableTopicName('cafe_ordering'), 'Cafe ordering');
  assert.equal(readableTopicName('verb_ser'), 'Ser');
});

test('prefixGroup needs agreeing topics with the same first segment', () => {
  assert.equal(prefixGroup(deck, 'verb_ir'), 'g1');
  assert.equal(prefixGroup(deck, 'animals'), null);
  const split = { ...deck, topics: [...deck.topics, { id: 't4', key: 'verb_ir', name: 'Ir', groupId: 'g2' }] };
  assert.equal(prefixGroup(split, 'verb_ver'), null);
});

test('no filter, or only unknown ids, means everything', () => {
  assert.equal(resolveFilter(deck, undefined), null);
  assert.equal(resolveFilter(deck, []), null);
  assert.equal(resolveFilter(deck, ['t:gone', 'g:gone']), null);
});
test('a group expands to its topics and unsorted is the empty key', () => {
  assert.deepEqual([...resolveFilter(deck, ['g:g1', 'unsorted'])].sort(), ['', 't1', 't2']);
  assert.deepEqual([...resolveFilter(deck, ['t:t3', 't:gone'])], ['t3']);
});

test('inFilter treats a missing topic as unsorted', () => {
  assert.equal(inFilter({}, null), true);
  assert.equal(inFilter({}, new Set(['t1'])), false);
  assert.equal(inFilter({}, new Set([''])), true);
  assert.equal(inFilter({ topic: 't1' }, new Set(['t1'])), true);
});

test('filterLabel names the choice', () => {
  assert.equal(filterLabel(deck, []), 'Everything');
  assert.equal(filterLabel(deck, ['g:g1']), 'Verbs');
  assert.equal(filterLabel(deck, ['t:t3']), 'Animals');
  assert.equal(filterLabel(deck, ['g:g1', 't:t3', 'unsorted']), 'Verbs and 2 more');
  assert.equal(filterLabel(deck, ['g:gone']), 'Everything');
});

test('aiText strips image markers and keeps LaTeX', () => {
  assert.equal(aiText('  see [image:abc.png] here $x^2$ '), 'see  here $x^2$');
});
