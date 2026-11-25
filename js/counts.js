// Merging answer counts kept on two devices.

import { DAY } from './fsrs.js';
import { dayKey, isDayKey } from './progress.js';

const isCount = (n) => Number.isInteger(n) && n >= 0;
// Study time is whole seconds for one deck on one day, so never more than a day's worth.
const isSeconds = (n) => isCount(n) && n <= 86_400;

/**
 * Answer counts with only what the app itself can write: real days no later than tomorrow
 * (`now`'s day plus one, for clocks a little ahead), holding whole counts of zero or more. In
 * `log` each day holds, per deck, an array of such counts (or one count, as files from the
 * single-person version did). In `time` each day holds, per deck, one whole number of seconds
 * no longer than a day. Anything else is dropped.
 */
export function cleanCounts(counts, kind, now) {
  const last = dayKey(now + DAY);
  const out = {};
  if (!isObject(counts)) return out;
  for (const [key, value] of Object.entries(counts)) {
    if (!isDayKey(key) || key > last) continue;
    if (kind === 'daily') {
      if (isCount(value)) out[key] = value;
    } else if (isObject(value)) {
      const keep = kind === 'time' ? isSeconds : (row) => isCount(row) || (Array.isArray(row) && row.every(isCount));
      const decks = Object.fromEntries(Object.entries(value).filter(([, row]) => keep(row)));
      if (Object.keys(decks).length) out[key] = decks;
    }
  }
  return out;
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Combine two copies of the answer counts (`daily` or `log`), keeping the larger count at each
 * place: per day, and per deck and kind of answer within `log`. What only one copy has is kept,
 * so a day counted on one device is not lost when another saves its own.
 */
export function mergeCounts(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (i in a ? (i in b ? mergeCounts(a[i], b[i]) : a[i]) : b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const out = { ...a };
    for (const [key, value] of Object.entries(b)) out[key] = key in a ? mergeCounts(a[key], value) : value;
    return out;
  }
  return b ?? a;
}
