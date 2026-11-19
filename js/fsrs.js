// Anki's scheduler, ported from Anki's source (anki/rslib/src/scheduler/states).
// It has three modes:
//   - 'sm2'  Anki's default: each interval is the last one times the card's ease
//   - 'fsrs' Anki with FSRS switched on: intervals come from the FSRS-6 memory model
//            (fsrs-rs, src/model_v6.rs)
//   - 'fsrs7' the same, with intervals from the FSRS-7 memory model (fsrs-rs v7.0.0,
//            src/model_v7.rs), which counts time in fractional days
// Learning steps, relearning and fuzz are the same in all three.
// Pure functions only: no DOM, no storage. Times are epoch milliseconds.

export const Rating = { Again: 1, Hard: 2, Good: 3, Easy: 4 };
export const State = { New: 0, Learning: 1, Review: 2, Relearning: 3 };

// Default FSRS-6 parameters (w0..w20), as shipped with Anki.
export const DEFAULT_W = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722,
  0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425,
  0.0912, 0.0658, 0.1542,
];

export const MINUTE = 60_000;
export const DAY = 86_400_000;
const DAY_SECS = 86_400;

// Anki's deck defaults.
export const LEARN_STEPS = [1, 10]; // minutes
export const RELEARN_STEPS = [10]; // minutes
export const MAX_INTERVAL = 36500;
const ROLLOVER_HOUR = 4; // a new day starts at 4am

// Anki's defaults for the SM-2 mode.
const INITIAL_EASE = 2.5;
const MINIMUM_EASE = 1.3;
const EASE_AGAIN = -0.2;
const EASE_HARD = -0.15;
const EASE_EASY = 0.15;
const HARD_MULTIPLIER = 1.2;
const EASY_MULTIPLIER = 1.3;
const GRADUATING_GOOD = 1; // days
const GRADUATING_EASY = 4; // days

const S_MIN = 0.0001;
const S_MAX = 36500;
const D_MIN = 1;
const D_MAX = 10;

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

// ---- Days -------------------------------------------------------------------

/** The next day rollover (4am local time) after `now`. */
export function nextDayAt(now) {
  const d = new Date(now);
  d.setHours(ROLLOVER_HOUR, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Start of the scheduling day that `now` falls in. */
export function dayStart(now) {
  const d = new Date(nextDayAt(now));
  d.setDate(d.getDate() - 1);
  return d.getTime();
}

/** Days elapsed since `then`, counted in scheduling days as Anki does. */
export function daysElapsed(then, now) {
  return Math.max(0, Math.floor((nextDayAt(now) - then) / DAY));
}

// ---- FSRS-6 memory model ----------------------------------------------------

function curve(w) {
  const decay = -w[20];
  return { decay, factor: Math.pow(0.9, 1 / decay) - 1 };
}

/** Probability of recall after `t` days for a card with stability `s`. */
export function retrievability(t, s, w = DEFAULT_W) {
  const { decay, factor } = curve(w);
  return Math.pow(1 + (factor * Math.max(t, 0)) / Math.max(s, S_MIN), decay);
}

/** Days (fractional) until retrievability drops to `retention`. */
export function nextInterval(s, retention = 0.9, w = DEFAULT_W) {
  const { decay, factor } = curve(w);
  const dr = clamp(retention, 0.0001, 0.9999);
  return clamp((Math.max(s, S_MIN) / factor) * (Math.pow(dr, 1 / decay) - 1), 0, S_MAX);
}

const initDifficulty = (g, w) => w[4] - Math.exp(w[5] * (g - 1)) + 1;

function nextDifficulty(d, g, w) {
  const delta = -w[6] * (g - 3);
  const damped = d + ((10 - d) / 9) * delta;
  // Mean reversion toward the initial difficulty of an "Easy" card.
  return clamp(w[7] * initDifficulty(Rating.Easy, w) + (1 - w[7]) * damped, D_MIN, D_MAX);
}

function stabilityAfterSuccess(s, r, d, g, w) {
  const hardPenalty = g === Rating.Hard ? w[15] : 1;
  const easyBonus = g === Rating.Easy ? w[16] : 1;
  return (
    s *
    (Math.exp(w[8]) *
      (11 - d) *
      Math.pow(s, -w[9]) *
      (Math.exp((1 - r) * w[10]) - 1) *
      hardPenalty *
      easyBonus +
      1)
  );
}

function stabilityAfterFailure(s, r, d, w) {
  const ceiling = s / Math.exp(w[17] * w[18]);
  const next =
    w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]);
  return Math.min(next, ceiling);
}

/** Stability and difficulty after answering `g`, `elapsed` days after the last review. */
export function nextMemory(memory, g, elapsed, w = DEFAULT_W) {
  if (!memory || !memory.stability) {
    return {
      stability: clamp(w[g - 1], S_MIN, S_MAX),
      difficulty: clamp(initDifficulty(g, w), D_MIN, D_MAX),
    };
  }
  const s = clamp(memory.stability, S_MIN, S_MAX);
  const d = clamp(memory.difficulty, D_MIN, D_MAX);
  const t = Math.round(Math.max(elapsed, 0));
  let stability;
  if (t === 0) {
    // Same-day review.
    const sinc = Math.exp(w[17] * (g - 3 + w[18])) * Math.pow(s, -w[19]);
    stability = s * (g >= Rating.Hard ? Math.max(sinc, 1) : sinc);
  } else {
    const r = retrievability(t, s, w);
    stability =
      g === Rating.Again ? stabilityAfterFailure(s, r, d, w) : stabilityAfterSuccess(s, r, d, g, w);
  }
  return { stability: clamp(stability, S_MIN, S_MAX), difficulty: nextDifficulty(d, g, w) };
}

// ---- FSRS-7 memory model (fsrs-rs v7.0.0, src/model_v7.rs) ------------------
// A card has two stabilities, a slow one and a fast one that covers minutes and hours,
// plus a difficulty. Time is in fractional days, so same-day reviews count.
// A memory is `{ stability, stabilityFast, difficulty }`.

// Default FSRS-7 parameters (w0..w33). w31..w33 are stored shifted; the formulas undo it.
export const DEFAULT_W7 = [
  0.1104, 2.2395, 3.9221, 11.7841, 6.1686, 0.6457, 3.6807, 1.9795, 0.0, 1.3826, 0.7024, 0.5999,
  0.8146, 0.6398, 1.0, 1.3207, 0.6707, 3.8668, 0.4416, 0.0934, 1.8631, 0.6162, 1.0869, 0.1567,
  0.0801, 0.2421, 0.9464, 0.1433, 0.7145, 0.0, 0.5667, 0.3734, 0.5333, 0.3048,
];

const BISECTION_ITERS = 50;

function fastRecall7(t, sFast, w) {
  const decay = -clamp(w[23] * Math.pow(sFast, w[33] - 0.3), 0.01, 0.95);
  const factor = Math.exp(Math.min(Math.log(w[25]) / decay, 60)) - 1;
  return Math.pow(1 + factor * (t / sFast), decay);
}

/** Probability of recall `t` days after the last review, for an FSRS-7 memory. */
export function retrievability7(t, memory, w = DEFAULT_W7) {
  t = Math.max(t, 0);
  const s = Math.max(memory.stability, S_MIN);
  const sFast = Math.max(memory.stabilityFast, S_MIN);
  const d = clamp(memory.difficulty, D_MIN, D_MAX);
  const r1 = fastRecall7(t, clamp(sFast, S_MIN, S_MAX), w);
  const decay2 = -clamp(w[24], 0.01, 0.95);
  const factor2 = Math.pow(w[26], 1 / decay2) - 1;
  const timescale = Math.exp((d - 5) * (w[32] - 0.3));
  const r2 = Math.pow(1 + factor2 * timescale * (t / s), decay2);
  const weight1 = w[27] * Math.pow(sFast, -w[29]);
  const weight2 = w[28] * Math.pow(s, w[30]) * Math.exp((d - 5) * (w[31] - 0.5));
  const r = (weight1 * r1 + weight2 * r2) / (weight1 + weight2);
  return r * (1 - 2e-5) + 1e-5;
}

const initDifficulty7 = (g, w) => w[4] - Math.exp(w[5] * (g - 1)) + 1;

function nextDifficulty7(d, g, r, w) {
  let delta = -w[6] * (g - 3);
  if (g === Rating.Again) delta *= r + 0.1;
  const damped = d + ((10 - d) * delta) / 9;
  return clamp(initDifficulty7(Rating.Easy, w) * 0.01 + damped * 0.99, D_MIN, D_MAX);
}

// One stability trace's update; `start` picks its weights (7 slow, 15 fast).
function nextStability7(w, s, d, r, g, start) {
  const hardPenalty = g === Rating.Hard ? w[start + 6] : 1;
  const easyBonus = g === Rating.Easy ? w[start + 7] : 1;
  const failed = w[start + 3] * (Math.pow(s + 1, w[start + 4]) - 1) * Math.exp((1 - r) * w[start + 5]);
  const postLapse = Math.min(s, failed);
  const sinc =
    Math.exp(w[start] - 1.5) *
      (11 - d) *
      Math.pow(s, -w[start + 1]) *
      (Math.exp((1 - r) * w[start + 2]) - 1) *
      hardPenalty *
      easyBonus +
    1;
  return clamp(g > Rating.Again ? Math.max(postLapse, s * sinc) : postLapse, S_MIN, S_MAX);
}

/** FSRS-7 memory after answering `g`, `elapsed` (fractional) days after the last review. */
export function nextMemory7(memory, g, elapsed, w = DEFAULT_W7) {
  if (!memory || !memory.stability) {
    const stability = clamp(w[g - 1], S_MIN, S_MAX);
    return {
      stability,
      stabilityFast: clamp(stability * 0.8, S_MIN, S_MAX),
      difficulty: clamp(initDifficulty7(g, w), D_MIN, D_MAX),
    };
  }
  const last = {
    stability: clamp(memory.stability, S_MIN, S_MAX),
    stabilityFast: clamp(memory.stabilityFast, S_MIN, S_MAX),
    difficulty: clamp(memory.difficulty, D_MIN, D_MAX),
  };
  const t = Math.max(elapsed, 0);
  const r = retrievability7(t, last, w);
  const slow = nextStability7(w, last.stability, last.difficulty, r, g, 7);
  let fast = nextStability7(w, last.stabilityFast, last.difficulty, fastRecall7(t, last.stabilityFast, w), g, 15);
  if (g === Rating.Again) fast = Math.min(fast, slow * 0.8);
  return {
    stability: slow,
    stabilityFast: clamp(fast, S_MIN, S_MAX),
    difficulty: nextDifficulty7(last.difficulty, g, r, w),
  };
}

/** Days (fractional) until FSRS-7 recall drops to `retention`. */
export function nextInterval7(memory, retention = 0.9, w = DEFAULT_W7) {
  const dr = clamp(retention, 0.0001, 0.9999);
  if (dr >= 0.9999) return 0;
  let low = 0;
  let high = Math.max(memory.stability, memory.stabilityFast, 1);
  while (retrievability7(high, memory, w) > dr && high < S_MAX) high = Math.min(high * 2, S_MAX);
  for (let i = 0; i < BISECTION_ITERS; i++) {
    const mid = (low + high) / 2;
    if (retrievability7(mid, memory, w) > dr) low = mid;
    else high = mid;
  }
  return clamp((low + high) / 2, 0, S_MAX);
}

/**
 * A starting FSRS-7 memory for a card that only has FSRS-6 memory: same difficulty, both
 * stabilities scaled so recall is 90% at the FSRS-6 stability, as FSRS-6 stability is the
 * time to 90%. Mirrors fsrs-rs scale_memory_state_to_interval.
 */
export function seedMemory7(stability6, difficulty6, w = DEFAULT_W7) {
  const difficulty = clamp(difficulty6, D_MIN, D_MAX);
  const interval = clamp(stability6, S_MIN, S_MAX);
  const at = (logS) => {
    const stability = clamp(Math.exp(logS), S_MIN, S_MAX);
    return { stability, stabilityFast: clamp(stability * 0.8, S_MIN, S_MAX), difficulty };
  };
  let low = Math.log(S_MIN);
  let high = Math.log(S_MAX);
  if (0.9 <= retrievability7(interval, at(low), w)) return at(low);
  if (0.9 >= retrievability7(interval, at(high), w)) return at(high);
  for (let i = 0; i < BISECTION_ITERS; i++) {
    const mid = (low + high) / 2;
    const r = retrievability7(interval, at(mid), w);
    if (Math.abs(r - 0.9) <= 1e-6) return at(mid);
    if (r < 0.9) low = mid;
    else high = mid;
  }
  return at((low + high) / 2);
}

// ---- Learning steps (anki: states/steps.rs) ---------------------------------

const stepSecs = (steps, index) => (index < steps.length ? Math.trunc(steps[index] * 60) : undefined);

const stepIndex = (steps, left) =>
  Math.min(Math.max(steps.length - (left % 1000), 0), Math.max(steps.length - 1, 0));

const roundInDays = (secs) => (secs > DAY_SECS ? Math.round(secs / DAY_SECS) * DAY_SECS : secs);

function hardDelaySecs(steps, left) {
  const index = stepIndex(steps, left);
  const current = stepSecs(steps, index) ?? stepSecs(steps, 0);
  if (index !== 0) return current;
  // On the first step, Hard sits between Again and Good.
  const next = stepSecs(steps, 1);
  if (next !== undefined) return roundInDays(Math.trunc((current + next) / 2));
  return roundInDays(Math.min(Math.trunc((current * 3) / 2), current + DAY_SECS));
}

const goodDelaySecs = (steps, left) => stepSecs(steps, stepIndex(steps, left) + 1);
const leftAfterGood = (steps, left) => Math.max(steps.length - (stepIndex(steps, left) + 1), 0);

// ---- Fuzz (anki: states/fuzz.rs) --------------------------------------------

const FUZZ_RANGES = [
  { start: 2.5, end: 7, factor: 0.15 },
  { start: 7, end: 20, factor: 0.1 },
  { start: 20, end: Infinity, factor: 0.05 },
];

function fuzzDelta(interval) {
  if (interval < 2.5) return 0;
  return FUZZ_RANGES.reduce(
    (delta, r) => delta + r.factor * Math.max(Math.min(interval, r.end) - r.start, 0),
    1,
  );
}

function fuzzBounds(interval, minimum, maximum) {
  minimum = Math.min(minimum, maximum);
  interval = clamp(interval, minimum, maximum);
  const delta = fuzzDelta(interval);
  const lower = clamp(Math.round(interval - delta), minimum, maximum);
  let upper = clamp(Math.round(interval + delta), minimum, maximum);
  if (upper === lower && upper > 2 && upper < maximum) upper = lower + 1;
  return [lower, upper];
}

/** Pick a whole-day interval near `interval`. `fuzz` is in [0, 1), or undefined for none. */
export function withReviewFuzz(fuzz, interval, minimum, maximum) {
  if (fuzz === undefined) return clamp(Math.round(interval), minimum, maximum);
  const [lower, upper] = fuzzBounds(interval, minimum, maximum);
  return Math.floor(lower + fuzz * (1 + upper - lower));
}

/** Lowest interval fuzz may pick, so a passed review never shrinks the interval by chance. */
function minimumFuzzInterval(interval, previous, maximum) {
  const [, upper] = fuzzBounds(interval, 1, maximum);
  if (Math.round(interval) > previous) return previous + 1;
  if (previous <= upper) return previous;
  return 0; // interval genuinely shrank
}

// ---- Scheduling -------------------------------------------------------------

/** Scheduling fields for a card that has never been reviewed. */
export function newSchedule(now = Date.now()) {
  return {
    state: State.New,
    stability: 0,
    difficulty: 0,
    due: now,
    scheduledDays: 0,
    ease: INITIAL_EASE,
    left: 0,
    reps: 0,
    lapses: 0,
    lastReview: null,
    stability7: 0,
    stabilityFast7: 0,
    difficulty7: 0,
  };
}

/**
 * The outcome of each possible rating for `card` at time `now`.
 * Returns `{ 1: schedule, 2: schedule, 3: schedule, 4: schedule }`.
 *
 * Options:
 *   scheduler     'fsrs' (FSRS-6, the default), 'fsrs7' or 'sm2'
 *   retention     desired retention, 0..1; FSRS-6 and FSRS-7 only
 *   w             FSRS-6 parameters; FSRS-7 always uses DEFAULT_W7
 *   fuzz          number in [0, 1) used to spread review intervals; omit for none
 *   easyInterval  fixed interval in days for Easy on a card still being learned for
 *                 the first time; 0 means Anki's own choice (4 days in SM-2, and
 *                 whatever FSRS computes in FSRS mode)
 *
 * The FSRS-6 and FSRS-7 memory states and the SM-2 ease are all kept up to date in every
 * mode, so a deck can switch between them at any time.
 */
export function preview(card, now = Date.now(), options = {}) {
  const {
    scheduler = 'fsrs',
    retention = 0.9,
    w = DEFAULT_W,
    maxInterval = MAX_INTERVAL,
    fuzz,
    easyInterval = 0,
  } = options;
  const maximum = Math.max(maxInterval, 1);
  const sm2 = scheduler === 'sm2';
  const ease = card.ease ?? INITIAL_EASE;
  const elapsed = card.lastReview == null ? 0 : daysElapsed(card.lastReview, now);

  // FSRS-7 memory: the card's own, or one seeded from its FSRS-6 memory if it has none yet.
  // FSRS-7 counts the exact time since the last answer, so same-day answers count.
  const memory7In =
    card.stability7 > 0
      ? { stability: card.stability7, stabilityFast: card.stabilityFast7, difficulty: card.difficulty7 }
      : card.lastReview != null && card.stability > 0
        ? seedMemory7(card.stability, card.difficulty)
        : null;
  const elapsed7 = card.lastReview == null ? 0 : Math.max(0, (now - card.lastReview) / DAY);

  const memory = {};
  const interval = {};
  for (const g of [1, 2, 3, 4]) {
    const m6 = nextMemory(card, g, elapsed, w);
    const m7 = nextMemory7(memory7In, g, elapsed7);
    memory[g] = { ...m6, stability7: m7.stability, stabilityFast7: m7.stabilityFast, difficulty7: m7.difficulty };
    interval[g] = scheduler === 'fsrs7' ? nextInterval7(m7, retention) : nextInterval(m6.stability, retention, w);
  }

  const fuzzed = (days, minimum) => withReviewFuzz(fuzz, days, clamp(minimum, 1, maximum), maximum);
  const whole = (days) => Math.max(Math.round(days), 1);

  const base = (g) => ({
    ...memory[g],
    ease,
    reps: card.reps + 1,
    lapses: card.lapses,
    lastReview: now,
  });
  const step = (g, state, secs, left) => ({
    ...base(g),
    state,
    left,
    due: now + secs * 1000,
    scheduledDays: card.scheduledDays ?? 0,
  });
  const review = (g, days) => ({
    ...base(g),
    state: State.Review,
    left: 0,
    due: now + days * DAY,
    scheduledDays: days,
  });

  if (card.state === State.Review) {
    const previous = card.scheduledDays ?? 0;
    let hard, good, easy;
    if (sm2) {
      const current = Math.max(previous, 1);
      const late = Math.max(elapsed - previous, 0);
      hard = fuzzed(current * HARD_MULTIPLIER, previous + 1);
      good = fuzzed((current + late / 2) * ease, hard + 1);
      easy = fuzzed((current + late) * ease * EASY_MULTIPLIER, good + 1);
    } else {
      const passing = (g, floor) =>
        fuzzed(interval[g], Math.max(minimumFuzzInterval(interval[g], previous, maximum), floor));
      hard = passing(2, 1);
      good = passing(3, hard + 1);
      easy = passing(4, good + 1);
    }
    return {
      1: {
        ...step(1, State.Relearning, stepSecs(RELEARN_STEPS, 0), RELEARN_STEPS.length),
        lapses: card.lapses + 1,
        ease: Math.max(ease + EASE_AGAIN, MINIMUM_EASE),
        // The interval the card restarts from once it leaves relearning. SM-2 resets it
        // to a day; FSRS computes it, and fuzz is applied on leaving relearning.
        scheduledDays: sm2 ? 1 : whole(interval[1]),
      },
      2: { ...review(2, hard), ease: Math.max(ease + EASE_HARD, MINIMUM_EASE) },
      3: review(3, good),
      4: { ...review(4, easy), ease: ease + EASE_EASY },
    };
  }

  // New, learning and relearning cards all walk through steps.
  const relearning = card.state === State.Relearning;
  const steps = relearning ? RELEARN_STEPS : LEARN_STEPS;
  const state = relearning ? State.Relearning : State.Learning;
  const left = card.state === State.New ? steps.length : (card.left ?? 0);

  const goodDelay = goodDelaySecs(steps, left);
  const restart = Math.max(card.scheduledDays ?? 0, 1); // set when the card lapsed
  const graduateGood = () => {
    if (sm2) return Math.min(relearning ? restart : GRADUATING_GOOD, maximum);
    return fuzzed(whole(interval[3]), 1);
  };
  const graduateEasy = () => {
    if (!relearning && easyInterval > 0) return Math.min(Math.round(easyInterval), maximum);
    if (sm2) return Math.min(relearning ? restart + 1 : GRADUATING_EASY, maximum);
    const good = fuzzed(interval[3], 1);
    return fuzzed(whole(interval[4]), good + 1);
  };

  return {
    1: step(1, state, stepSecs(steps, 0), steps.length),
    2: step(2, state, hardDelaySecs(steps, left), left),
    3:
      goodDelay !== undefined
        ? step(3, state, goodDelay, leftAfterGood(steps, left))
        : review(3, graduateGood()),
    4: review(4, graduateEasy()),
  };
}

/** New scheduling fields for `card` after it is answered with `rating`. */
export function schedule(card, rating, now = Date.now(), options = {}) {
  return preview(card, now, options)[rating];
}
