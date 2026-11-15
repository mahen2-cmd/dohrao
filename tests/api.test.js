import test from 'node:test';
import assert from 'node:assert/strict';

import { speechErrorMessage } from '../js/api.js';
import { canTranslateDecks } from '../js/urdu.js';

test('a refused speech request is told in words, not as the server’s JSON', () => {
  assert.equal(speechErrorMessage(429), 'Too many audio requests. Wait a minute.');
  assert.equal(speechErrorMessage(400), "That language can't be read aloud.");
  assert.equal(speechErrorMessage(500), 'Could not play audio');
});

test('only the admin is offered Urdu translation for a deck', () => {
  assert.equal(canTranslateDecks({ role: 'admin' }), true);
  assert.equal(canTranslateDecks({ role: 'user' }), false);
  assert.equal(canTranslateDecks(null), false);
});
