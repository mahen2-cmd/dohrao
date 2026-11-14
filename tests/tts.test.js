import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTts } from '../tts.js';

test('an ur-PK request picks the Urdu voice', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'recall-tts-test-'));
  const realFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = realFetch;
    await rm(dataDir, { recursive: true, force: true });
  });
  await writeFile(
    join(dataDir, 'tts.json'),
    JSON.stringify({ azureKey: 'fake-key', azureRegion: 'westeurope', voice: 'pt-PT-RaquelNeural' }),
  );
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), body: options.body });
    return new Response(Buffer.from('fake mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  // `root` has no .tts folder, so Edge and Piper are not offered.
  const tts = createTts({ root: dataDir, dataDir });

  const { engine } = await tts.prepare('آپ کہاں رہتے ہیں؟', 'ur-PK');
  assert.equal(engine, 'azure:ur-PK-UzmaNeural');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/westeurope\.tts\.speech\.microsoft\.com\//);
  assert.match(requests[0].body, /xml:lang='ur-PK'/);
  assert.match(requests[0].body, /<voice name='ur-PK-UzmaNeural'>آپ کہاں رہتے ہیں؟<\/voice>/);
});
