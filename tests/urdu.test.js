import test from 'node:test';
import assert from 'node:assert/strict';
import { portugueseSide, englishSide, needsUrdu, frontShows, shownSide } from '../js/urdu.js';

const deck = { urdu: true, frontLang: 'en-US', backLang: 'pt-PT' };
const card = { front: 'Where do you live?', back: 'Onde moras?' };
test('Portuguese is the back, or the front of a reversed copy', () => {
  assert.equal(portugueseSide(card, deck), 'back');
  assert.equal(portugueseSide({ ...card, reversed: true }, deck), 'front');
  assert.equal(englishSide({ ...card, reversed: true }, deck), 'back');
});
test('needsUrdu', () => {
  assert.equal(needsUrdu(card, deck), true);
  assert.equal(needsUrdu(card, { ...deck, urdu: false }), false);
  assert.equal(needsUrdu({ ...card, back: '[image:a.png]' }, deck), false);
  const done = { ...card, urdu: 'آپ', urduOf: 'Onde moras?', urduBy: 'google' };
  assert.equal(needsUrdu(done, deck), false);
  assert.equal(needsUrdu({ ...done, front: 'Where do you live (informal)?' }, deck), false);
  assert.equal(needsUrdu({ ...done, back: 'Onde vives?' }, deck), true);
  assert.equal(needsUrdu({ ...done, back: 'Onde vives?', urduBy: 'manual' }, deck), false);
});
test('frontShows takes the newer of the choice and the switch', () => {
  assert.equal(frontShows({}), 'en');
  assert.equal(frontShows({ frontShows: 'both', frontShowsAt: 5 }), 'both');
  assert.equal(frontShows({ frontShows: 'en', frontShowsAt: 5, urduSwitch: true, urduSwitchAt: 9 }), 'ur');
  assert.equal(frontShows({ frontShows: 'en', frontShowsAt: 10, urduSwitch: true, urduSwitchAt: 9 }), 'en');
  assert.equal(frontShows({ urduSwitch: false, urduSwitchAt: 9 }), 'en');
});
test('shownSide', () => {
  const c = { ...card, urdu: 'آپ کہاں رہتے ہیں؟', urduRoman: 'aap kahan rahte hen?' };
  assert.deepEqual(shownSide(c, { ...deck, frontShows: 'ur', frontShowsAt: 1 }), { english: null, urdu: 'آپ کہاں رہتے ہیں؟', urduLang: 'ur' });
  assert.deepEqual(shownSide(c, { ...deck, frontShows: 'both', frontShowsAt: 1, urduScript: 'roman' }), { english: 'Where do you live?', urdu: 'aap kahan rahte hen?', urduLang: 'ur-Latn' });
  assert.deepEqual(shownSide(card, { ...deck, frontShows: 'ur', frontShowsAt: 1 }), { english: 'Where do you live?', urdu: null, urduLang: 'ur' });
  assert.deepEqual(shownSide(c, { ...deck, urdu: false, frontShows: 'ur', frontShowsAt: 1 }).urdu, null);
  const english = { english: 'Where do you live?', urdu: null, urduLang: 'ur' };
  assert.deepEqual(shownSide(c, { ...deck, frontShows: 'en', frontShowsAt: 1 }), english);
  assert.deepEqual(shownSide(c, deck), english);
});
