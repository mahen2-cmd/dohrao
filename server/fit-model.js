// The optimizer: fits FSRS-6 and FSRS-7 weights with the official fsrs-rs optimizer (through
// @open-spaced-repetition/binding). It blocks the thread it runs on, so only the fit worker and
// the tests load this file; the server itself never does.

import {
  FSRSBinding,
  computeParameters,
  convertCsvToFsrsItems,
} from '@open-spaced-repetition/binding';
import { DEFAULT_W, DEFAULT_W7 } from '../js/fsrs.js';
import { FIT_MIN_ANSWERS, reviewCsv } from './fit.js';

// A new day starts at 4am, as in the scheduler.
const ROLLOVER_HOUR = 4;

// The latest fifth of the answers is held back to judge a fit against the deck's current weights.
const HELD_OUT = 0.2;

const encode = (lines) => new TextEncoder().encode(lines.join('\n'));

/**
 * The optimizer's items for `csv`, split by time: `train` from the answers before the latest
 * fifth, `test` the rest. The optimizer orders items by time, so the earlier answers' items are
 * the first ones of the whole set; that is checked, not assumed.
 */
export function heldOutSplit(csv, timezone, modelVersion) {
  const lines = new TextDecoder().decode(csv).split('\n');
  const times = lines.slice(1).map((line) => Number(line.split(',')[1])).sort((a, b) => a - b);
  const cutoff = times[Math.floor(times.length * (1 - HELD_OUT))];
  const earlier = [lines[0], ...lines.slice(1).filter((line) => Number(line.split(',')[1]) < cutoff)];
  const all = convertCsvToFsrsItems(csv, ROLLOVER_HOUR, timezone, modelVersion);
  const train = convertCsvToFsrsItems(encode(earlier), ROLLOVER_HOUR, timezone, modelVersion);
  if (!train.every((item, i) => item.toString() === all[i]?.toString())) throw new Error('held-out-split');
  return { train, test: all.slice(train.length), all };
}

/**
 * Fit one model and judge it against `current`. Both are scored on the same latest answers, which
 * the trial fit has not seen, so neither is flattered; weights fitted before those answers came in
 * have not seen them either. A fit that wins by at least 1% is then refitted on every answer.
 */
async function fitModel(csv, timezone, modelVersion, current) {
  const { train, test, all } = heldOutSplit(csv, timezone, modelVersion);
  if (!train.length || !test.length) return { kept: false };
  const options = { modelVersion, enableShortTerm: true, numRelearningSteps: 1 };
  const trial = await computeParameters(train, options);
  const fittedLoss = new FSRSBinding(trial).evaluate(test).logLoss;
  const currentLoss = new FSRSBinding(current).evaluate(test).logLoss;
  const improvement = Math.round((100 * (currentLoss - fittedLoss)) / currentLoss);
  if (!(improvement >= 1)) return { kept: false };
  const params = await computeParameters(all, options);
  if (!params.every(Number.isFinite)) return { kept: false };
  return { kept: true, params, improvement };
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

