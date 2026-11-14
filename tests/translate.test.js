import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogle, createTranslator } from '../server/translate.js';

const ONE = [[["آپ کہاں رہتے ہیں؟","Onde moras?",null,null,3],[null,null,"aap kahan rahte hen?"]],null,"pt"];
const TWO = [[["صبح بخیر ","Bom dia. ",null,null,11],["کیسی ہو؟","Como está?",null,null,11],[null,null,"sabah bakhair kisi ho?"]],null,"pt"];

test('parseGoogle reads script and romanisation', () => {
  assert.deepEqual(parseGoogle(ONE), { urdu: 'آپ کہاں رہتے ہیں؟', urduRoman: 'aap kahan rahte hen?' });
  assert.deepEqual(parseGoogle(TWO), { urdu: 'صبح بخیر کیسی ہو؟', urduRoman: 'sabah bakhair kisi ho?' });
});

test('parseGoogle refuses an unexpected shape', () => {
  assert.throws(() => parseGoogle({}), /bad-response/);
  assert.throws(() => parseGoogle([[]]), /bad-response/);
});

test('toUrdu sends the Portuguese to the gtx endpoint', async () => {
  let url;
  const t = createTranslator({ fetch: async (u) => ((url = new URL(u)), { ok: true, json: async () => ONE }) });
  assert.equal((await t.toUrdu('Onde moras?')).urdu, 'آپ کہاں رہتے ہیں؟');
  assert.equal(url.host, 'translate.googleapis.com');
  assert.deepEqual([url.searchParams.get('sl'), url.searchParams.get('tl'), url.searchParams.getAll('dt')], ['pt', 'ur', ['t', 'rm']]);
  assert.equal(url.searchParams.get('q'), 'Onde moras?');
});

test('toUrdu fails on a bad status', async () => {
  const t = createTranslator({ fetch: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(t.toUrdu('Olá'), /google-429/);
});
