// Active study time: how long someone is really working on a card. The clock counts only
// while the card is in view and they are not idle, and gives back the time since their last
// input once they have been idle for longer than the card's limit.

export const IDLE_BASE = 30_000;
export const IDLE_PER_WORD = 250;
export const IDLE_MAX = 180_000;

/** How long, in ms, someone may go without input on a card of `words` words before they count as idle. */
export const idleLimit = (words) => Math.min(IDLE_BASE + words * IDLE_PER_WORD, IDLE_MAX);

/** The words in a card's text, its markup left out. */
export function wordCount(text) {
  if (!text) return 0;
  return String(text).replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
}

/**
 * A clock for one card at a time. `start` begins a card, `input` marks someone at work (and
 * starts the clock again after a pause or idling), `pause` stops it while out of view, and
 * `take` hands back the active ms and resets it. Every method takes the time, `Date.now()` by default.
 */
export function createStudyClock() {
  let running = false;
  let since = 0;
  let lastInput = 0;
  let limit = IDLE_BASE;
  let banked = 0;

  const credit = (t) => {
    if (!running) return;
    banked += Math.max(0, Math.min(t, lastInput + limit) - since);
    since = t;
  };

  return {
    start(words, t = Date.now()) {
      banked = 0;
      running = true;
      since = lastInput = t;
      limit = idleLimit(words);
    },
    setWords(words) {
      limit = idleLimit(words);
    },
    input(t = Date.now()) {
      if (running) credit(t);
      else {
        running = true;
        since = t;
      }
      lastInput = t;
    },
    pause(t = Date.now()) {
      credit(t);
      running = false;
    },
    take(t = Date.now()) {
      credit(t);
      const ms = banked;
      running = false;
      banked = 0;
      return ms;
    },
  };
}

/** Seconds of study as "45 s", "18 min", "2 h 5 min" or "2 h". */
export function formatStudyTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s === 0) return '0 min';
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
