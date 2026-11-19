// Fitting FSRS-6 and FSRS-7 weights to one person's answers on one deck, from the review log:
// which answers a fit can use, and running a fit in a worker thread. The optimizer itself is in
// fit-model.js, which only the worker loads, so the server starts even if it cannot.

import { Worker } from 'node:worker_threads';

/** Fewer answers than this and a fit mostly echoes the defaults, so it is not offered. */
export const FIT_MIN_ANSWERS = 1000;

/**
 * `userId`'s logged answers to the cards now in `deckId`, by card then time, keeping only cards
 * whose whole history is in the log: their first logged answer was to the card while new.
 */
export function usableReviews(db, userId, deckId) {
  const rows = db
    .prepare(
      `SELECT r.card_id, r.at, r.data FROM reviews r JOIN cards c ON c.id = r.card_id
        WHERE r.user_id = ? AND c.deck_id = ? ORDER BY r.card_id, r.at, r.rowid`,
    )
    .all(userId, deckId);
  const usable = [];
  let card = null;
  let whole = false;
  for (const row of rows) {
    const { rating, state, duration } = JSON.parse(row.data);
    if (row.card_id !== card) {
      card = row.card_id;
      whole = state === 0;
    }
    if (whole) usable.push({ cardId: row.card_id, at: row.at, rating, state, duration });
  }
  return usable;
}

/** The answers as the optimizer's CSV, with each card numbered 1, 2, 3… in order. */
export function reviewCsv(reviews) {
  const numbers = new Map();
  const lines = ['card_id,review_time,review_rating,review_state,review_duration'];
  for (const r of reviews) {
    if (!numbers.has(r.cardId)) numbers.set(r.cardId, numbers.size + 1);
    lines.push(`${numbers.get(r.cardId)},${r.at},${r.rating},${r.state},${r.duration ?? 0}`);
  }
  return new TextEncoder().encode(lines.join('\n'));
}

// A fit of a few thousand answers takes well under a second; this only catches a stuck one.
const FIT_TIMEOUT = 120_000;

// Each fit's worker takes 100 to 300 MB, so fits run one at a time, a few waiting at most.
const MAX_WAITING = 4;
const load = { running: 0, waiting: 0, most: 0 };
let queue = Promise.resolve();

/** How many fits run and wait now, and the most that have run at once. */
export const fitLoad = () => load;

/**
 * `fitWeights` in a worker thread, so the server keeps answering while it runs. Fits take turns;
 * with too many already waiting this rejects with Error('busy').
 */
export function runFit(input) {
  if (load.waiting >= MAX_WAITING) return Promise.reject(new Error('busy'));
  load.waiting++;
  const turn = queue.then(() => {
    load.waiting--;
    load.running++;
    load.most = Math.max(load.most, load.running);
    return fitInWorker(input).finally(() => load.running--);
  });
  queue = turn.catch(() => {});
  return turn;
}

function fitInWorker(input) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./fit-worker.js', import.meta.url), { workerData: input });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('fit-failed'));
    }, FIT_TIMEOUT);
    const done = (fn, value) => {
      clearTimeout(timer);
      worker.terminate();
      fn(value);
    };
    worker.once('message', ({ result, error }) => (error ? done(reject, new Error(error)) : done(resolve, result)));
    worker.once('error', (error) => done(reject, error));
    worker.once('exit', () => done(reject, new Error('fit-failed')));
  });
}
