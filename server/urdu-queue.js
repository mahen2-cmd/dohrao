// Translates the Portuguese of cards on Urdu decks in the background, one card at a time, and
// stores the Urdu on the card as shared content.
import { needsUrdu, portugueseText } from '../js/urdu.js';

const parse = (text) => (text ? JSON.parse(text) : {});

const MINUTE = 60_000;
/** A failed card waits this long before it is tried again, doubling with each failure in a row. */
const FIRST_RETRY_MS = 5 * MINUTE;
const LONGEST_RETRY_MS = 6 * 60 * MINUTE;
/** After this many failures in a row, nothing is sent for PAUSE_MS. */
const FAILURES_BEFORE_PAUSE = 3;
const PAUSE_MS = 10 * MINUTE;

export function createUrduQueue({ db, translator, pauseMs = 300, now = Date.now, log = console.error }) {
  const pending = []; // { id, urduAt } in the order they were queued
  const queued = new Set();
  let counts = { translated: 0, failed: 0 };
  let running = null;
  let stopped = false;
  let pause = null; // { timer, resolve } while waiting between cards
  // Google may be refusing or down: back off rather than ask again on every sync.
  const retries = new Map(); // card id -> { failures, at } after a failure, until a success
  let failuresInARow = 0;
  let pausedUntil = 0;
  let resume = null; // the timer that restarts the work when a pause ends

  /** The card and its deck as stored now, or null when the card is gone. */
  function read(id) {
    const row = db.prepare('SELECT c.data AS card, d.data AS deck FROM cards c JOIN decks d ON d.id = c.deck_id WHERE c.id = ?').get(id);
    return row ? { card: parse(row.card), deck: parse(row.deck) } : null;
  }

  /** Translate one card. Returns true when the card was put back on the queue. */
  async function work({ id, urduAt }) {
    const before = read(id);
    if (!before || !needsUrdu(before.card, before.deck)) return false;
    const text = portugueseText(before.card, before.deck);
    const { urdu, urduRoman } = await translator.toUrdu(text);
    if (stopped) return false;
    // Someone may have changed the card while it was being translated; their change wins.
    const latest = read(id);
    if (!latest || !needsUrdu(latest.card, latest.deck)) return false;
    if (portugueseText(latest.card, latest.deck) !== text || latest.card.urduAt !== urduAt) {
      // The card still needs Urdu for its new state, and a scan meanwhile skipped it as queued.
      pending.push({ id, urduAt: latest.card.urduAt });
      return true;
    }
    const card = { ...latest.card, urdu, urduRoman, urduOf: text, urduBy: 'google', urduAt: now() };
    db.prepare('UPDATE cards SET data = ? WHERE id = ?').run(JSON.stringify(card), id);
    counts.translated++;
    return false;
  }

  const wait = (ms) => new Promise((resolve) => {
    pause = { timer: setTimeout(resolve, ms).unref(), resolve };
  }).finally(() => { pause = null; });

  const paused = () => now() < pausedUntil;

  function failed(id, error) {
    counts.failed++;
    log(`Urdu translation failed for card ${id}:`, error?.message ?? error);
    const failures = (retries.get(id)?.failures ?? 0) + 1;
    const delay = Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), LONGEST_RETRY_MS);
    retries.set(id, { failures, at: now() + delay });
    if (++failuresInARow < FAILURES_BEFORE_PAUSE) return;
    failuresInARow = 0;
    pausedUntil = now() + PAUSE_MS;
    log(`Urdu translation paused for ${PAUSE_MS / MINUTE} minutes after ${FAILURES_BEFORE_PAUSE} failures in a row.`);
    clearTimeout(resume);
    resume = setTimeout(start, PAUSE_MS).unref();
  }

  async function run() {
    await null; // let the caller (a sync, say) answer before the first card is sent
    while (pending.length && !stopped && !paused()) {
      const item = pending.shift();
      let requeued = false;
      try {
        requeued = await work(item);
        retries.delete(item.id);
        failuresInARow = 0;
      } catch (error) {
        failed(item.id, error);
      } finally {
        if (!requeued) queued.delete(item.id);
      }
      if (pending.length && !stopped && !paused() && pauseMs > 0) await wait(pauseMs);
    }
  }

  function start() {
    if (running || stopped || !pending.length || paused()) return;
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
      if (now() < (retries.get(row.id)?.at ?? 0)) continue; // failed lately: wait for its retry time
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

  /**
   * Resolves when there is nothing the queue may do now (nothing is queued, or it is paused after
   * failures), with what happened since the last call.
   */
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
    clearTimeout(resume);
    if (pause) {
      clearTimeout(pause.timer);
      pause.resolve();
    }
  }

  /** How many cards are queued but not yet tried, as when a pause stopped the work. */
  const waiting = () => pending.length;

  return { scanDeck, scanAll, idle, stop, waiting };
}
