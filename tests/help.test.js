import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HELP, HELP_LANGS, initialHelpLang, isHelpKey } from '../js/help.js';

const LANGS = ['en', 'ur', 'ur-Latn'];
const IDS = ['daily', 'buttons', 'counts', 'reserve', 'keys'];
const all = (lang) => JSON.stringify(HELP[lang]);

test('the toggle offers English, Urdu and Roman Urdu, in that order', () => {
  assert.deepEqual(HELP_LANGS, [['en', 'English'], ['ur', 'اردو'], ['ur-Latn', 'Roman Urdu']]);
});

test('every language has the same sections, in the same order, with the same number of rows', () => {
  for (const lang of LANGS) {
    assert.deepEqual(HELP[lang].sections.map((s) => s.id), IDS, lang);
    for (const [i, s] of HELP[lang].sections.entries()) {
      const en = HELP.en.sections[i];
      for (const part of ['steps', 'terms', 'text', 'keys']) assert.equal(s[part]?.length, en[part]?.length, `${lang} ${s.id} ${part}`);
    }
  }
});

test('the buttons, counts and keys keep their English names in every language', () => {
  for (const lang of LANGS) {
    const section = (id) => HELP[lang].sections.find((s) => s.id === id);
    assert.deepEqual(section('buttons').terms.map(([t]) => t), ['Again', 'Hard', 'Good', 'Easy'], lang);
    assert.deepEqual(section('counts').terms.map(([t]) => t), ['New', 'Learning', 'Due'], lang);
    assert.deepEqual(section('keys').keys.map(([k]) => k), HELP.en.sections[4].keys.map(([k]) => k), lang);
    for (const label of ['Start review', 'Show answer', 'Nothing due', 'Pull in']) assert.ok(all(lang).includes(label), `${lang}: ${label}`);
  }
});

test('the shortcuts listed are the ones the study screen has, plus ? for this page', () => {
  assert.deepEqual(HELP.en.sections[4].keys.map(([k]) => k), [['Space', 'Enter'], ['1', '2', '3', '4'], ['R'], ['E'], ['H'], ['Ctrl+Z'], ['?']]);
});

test('a saved choice wins; an unknown one is ignored', () => {
  assert.equal(initialHelpLang('ur-Latn', []), 'ur-Latn');
  assert.equal(initialHelpLang('en', [{ frontShows: 'ur' }]), 'en');
  assert.equal(initialHelpLang('fr', []), 'en');
});

test('with nothing saved, a deck showing the Urdu front starts the page in its Urdu writing', () => {
  assert.equal(initialHelpLang(null, [{ frontShows: 'en' }, { frontShows: 'ur' }]), 'ur');
  assert.equal(initialHelpLang(null, [{ frontShows: 'both', urduScript: 'roman' }]), 'ur-Latn');
  assert.equal(initialHelpLang(null, [{ urduSwitch: 'ur', urduScript: 'arabic' }]), 'ur');
  assert.equal(initialHelpLang(null, [{ frontShows: 'en' }]), 'en');
  assert.equal(initialHelpLang(undefined, undefined), 'en'); // signed out, or storage blocked
});

test('? opens help, but not with a modifier or while typing', () => {
  assert.equal(isHelpKey({ key: '?' }), true);
  assert.equal(isHelpKey({ key: '?', ctrlKey: true }), false);
  assert.equal(isHelpKey({ key: '?', metaKey: true }), false);
  assert.equal(isHelpKey({ key: '?', altKey: true }), false);
  assert.equal(isHelpKey({ key: '?', typing: true }), false);
  assert.equal(isHelpKey({ key: '/' }), false);
});
