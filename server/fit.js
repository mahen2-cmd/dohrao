// Fitting FSRS-6 and FSRS-7 weights to one person's answers on one deck, from the review log.
// Uses the official optimizer (fsrs-rs, through @open-spaced-repetition/binding). It runs on
// whatever thread calls it and blocks that thread, so the server calls it from a worker.

import {
  FSRSBinding,
  computeParameters,
  convertCsvToFsrsItems,
  evaluateWithTimeSeriesSplits,
} from '@open-spaced-repetition/binding';
import { Worker } from 'node:worker_threads';
import { DEFAULT_W, DEFAULT_W7 } from '../js/fsrs.js';

/** Fewer answers than this and a fit mostly echoes the defaults, so it is not offered. */
export const FIT_MIN_ANSWERS = 1000;

// A new day starts at 4am, as in the scheduler.
const ROLLOVER_HOUR = 4;

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

/**
 * Fit one model and score it against `current` on the same answers. The fit is scored out of
 * sample (trained on earlier answers, tested on later ones), so fitting the answers it is tested
 * on does not flatter it; the current weights were not fitted to them, so they are scored on all.
 */
async function fitModel(csv, timezone, modelVersion, current) {
  const items = convertCsvToFsrsItems(csv, ROLLOVER_HOUR, timezone, modelVersion);
  const options = { modelVersion, enableShortTerm: true, numRelearningSteps: 1 };
  const params = await computeParameters(items, options);
  const fittedLoss = (await evaluateWithTimeSeriesSplits(items, options)).logLoss;
  const currentLoss = new FSRSBinding(current).evaluate(items).logLoss;
  if (!(fittedLoss < currentLoss) || !params.every(Number.isFinite)) return { kept: false };
  return { kept: true, params, improvement: Math.round((100 * (currentLoss - fittedLoss)) / currentLoss) };
}

/**
 * Fit FSRS-6 and FSRS-7 to `reviews` (from `usableReviews`). `current6` and `current7` are the
 * deck's weights now, the defaults when omitted. Each result is kept only when it predicts better.
 */
export async function fitWeights({ reviews, timezone, current6, current7 }) {
  if (reviews.length < FIT_MIN_ANSWERS) throw new Error('not-enough-answers');
  const csv = reviewCsv(reviews);
  return {
    fsrs6: await fitModel(csv, timezone, 'FSRS-6', current6 ?? DEFAULT_W),
    fsrs7: await fitModel(csv, timezone, 'FSRS-7', current7 ?? DEFAULT_W7),
  };
}

// A fit of a few thousand answers takes well under a second; this only catches a stuck one.
const FIT_TIMEOUT = 120_000;

/** `fitWeights` in a worker thread, so the server keeps answering while it runs. */
export function runFit(input) {
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
