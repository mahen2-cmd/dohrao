// Translates the Portuguese of cards on Urdu decks in the background, one card at a time, and
// stores the Urdu on the card as shared content.
import { needsUrdu, portugueseText } from '../js/urdu.js';

const parse = (text) => (text ? JSON.parse(text) : {});

export function createUrduQueue({ db, translator, pauseMs = 300, now = Date.now, log = console.error }) {
  const pending = []; // { id, urduAt } in the order they were queued
  const queued = new Set();
  let counts = { translated: 0, failed: 0 };
  let running = null;
  let stopped = false;
  let pause = null; // { timer, resolve } while waiting between cards

  /** The card and its deck as stored now, or null when the card is gone. */
  function read(id) {
    const row = db.prepare('SELECT c.data AS card, d.data AS deck FROM cards c JOIN decks d ON d.id = c.deck_id WHERE c.id = ?').get(id);
    return row ? { card: parse(row.card), deck: parse(row.deck) } : null;
  }

  async function work({ id, urduAt }) {
    const before = read(id);
    if (!before || !needsUrdu(before.card, before.deck)) return;
    const text = portugueseText(before.card, before.deck);
    const { urdu, urduRoman } = await translator.toUrdu(text);
    if (stopped) return;
    // Someone may have changed the card while it was being translated; their change wins.
    const latest = read(id);
    if (!latest || !needsUrdu(latest.card, latest.deck)) return;
    if (portugueseText(latest.card, latest.deck) !== text || latest.card.urduAt !== urduAt) return;
    const card = { ...latest.card, urdu, urduRoman, urduOf: text, urduBy: 'google', urduAt: now() };
    db.prepare('UPDATE cards SET data = ? WHERE id = ?').run(JSON.stringify(card), id);
    counts.translated++;
  }

  const wait = (ms) => new Promise((resolve) => {
    pause = { timer: setTimeout(resolve, ms).unref(), resolve };
  }).finally(() => { pause = null; });

  async function run() {
    await null; // let the caller (a sync, say) answer before the first card is sent
    while (pending.length && !stopped) {
      const item = pending.shift();
      try {
        await work(item);
      } catch (error) {
        counts.failed++;
        log(`Urdu translation failed for card ${item.id}:`, error?.message ?? error);
      } finally {
        queued.delete(item.id);
      }
      if (pending.length && !stopped && pauseMs > 0) await wait(pauseMs);
    }
  }

  function start() {
    if (running || stopped || !pending.length) return;
    running = run().finally(() => {
      running = null;
      start(); // a card queued during the last step
    });
  }

  /** Queue the deck's cards that need Urdu and aren't queued already. */
  function scanDeck(deckId) {
    if (stopped) return;
    const deckRow = db.prepare('SELECT data FROM decks WHERE id = ?').get(deckId);
    const deck = parse(deckRow?.data);
    if (!deck.urdu) return;
    for (const row of db.prepare('SELECT id, data FROM cards WHERE deck_id = ? ORDER BY rowid').all(deckId)) {
      const card = parse(row.data);
      if (queued.has(row.id) || !needsUrdu(card, deck)) continue;
      queued.add(row.id);
      pending.push({ id: row.id, urduAt: card.urduAt });
    }
    start();
  }

  /** Scan every deck that has Urdu switched on. */
  function scanAll() {
    for (const row of db.prepare('SELECT id, data FROM decks ORDER BY rowid').all()) {
      if (parse(row.data).urdu) scanDeck(row.id);
    }
  }

  /** Resolves when nothing is queued, with what happened since the last call. */
  async function idle() {
    while (running) await running;
    const done = counts;
    counts = { translated: 0, failed: 0 };
    return done;
  }

  /** Drop what is queued and write nothing more; used when the server closes. */
  function stop() {
    stopped = true;
    pending.length = 0;
    queued.clear();
    if (pause) {
      clearTimeout(pause.timer);
      pause.resolve();
    }
  }

  return { scanDeck, scanAll, idle, stop };
}
