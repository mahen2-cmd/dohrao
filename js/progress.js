// How far someone has got: card statuses, deck progress, streaks and recent study.
// Shared by the app and the server, so the admin's Progress page counts the same way.

import { DAY, State, dayStart } from './fsrs.js';

// A review card is known well once its interval reaches three weeks (Anki's "mature").
export const KNOWN_DAYS = 21;
// A card forgotten this many times is struggling.
export const STRUGGLING_LAPSES = 3;

/** The day `t` falls in, as '2026-01-31'. Days roll over at 4am, as in Anki. */
export function dayKey(t) {
  const d = new Date(dayStart(t));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whether `key` is a real calendar day written as '2026-01-31'. */
export function isDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/**
 * Where a card stands for the person studying it: 'reserve' (not pulled in yet), 'waiting'
 * (pulled in, never answered), 'struggling', 'known' (well) or 'learning'.
 */
export function cardStatus(c) {
  if (c.reserved) return 'reserve';
  if (c.state === State.New) return 'waiting';
  if ((c.lapses ?? 0) >= STRUGGLING_LAPSES) return 'struggling';
  if (c.state === State.Review && (c.scheduledDays ?? 0) >= KNOWN_DAYS) return 'known';
  return 'learning';
}

/** How many of a deck's cards are in each status. `learned` counts every card answered at least once. */
export function deckProgress(cards) {
  const p = { total: cards.length, reserve: 0, waiting: 0, learning: 0, known: 0, struggling: 0 };
  for (const c of cards) p[cardStatus(c)]++;
  return { ...p, learned: p.learning + p.known + p.struggling, pulledIn: p.total - p.reserve };
}

/** Answers today, and how many days in a row up to today (or yesterday, before today's first answer). */
export function streakOf(perDay, now) {
  const reviewedToday = perDay[dayKey(now)] ?? 0;
  let streak = 0;
  const day = new Date(dayStart(now));
  if (!reviewedToday) day.setDate(day.getDate() - 1);
  while (perDay[dayKey(day)] > 0) {
    streak++;
    day.setDate(day.getDate() - 1);
  }
  return { reviewedToday, streak };
}

/** Answers on each of the last `n` days, oldest first and ending today, as `{ key, n }`. */
function lastDays(daily, n, now) {
  const day = new Date(dayStart(now));
  day.setDate(day.getDate() - (n - 1));
  const days = [];
  for (let i = 0; i < n; i++, day.setDate(day.getDate() + 1)) {
    const key = dayKey(day);
    days.push({ key, n: daily[key] ?? 0 });
  }
  return days;
}

/** A summary of someone's recent study, from their answers per day. */
export function recentStudy(daily, now) {
  const month = lastDays(daily, 30, now);
  const sum = (days) => days.reduce((total, d) => total + d.n, 0);
  const studied = Object.keys(daily).filter((key) => isDayKey(key) && daily[key] > 0).sort();
  return {
    ...streakOf(daily, now),
    last14: month.slice(-14),
    daysIn30: month.filter((d) => d.n > 0).length,
    answersIn7: sum(month.slice(-7)),
    answersIn30: sum(month),
    lastStudied: studied.at(-1) ?? null,
  };
}

/**
 * The share of answers over the last 30 days that were not Again, for one deck or (with a
 * null `deckId`) all of them; null when there are none. `log[day][deckId]` holds twelve
 * counts: Again, Hard, Good and Easy for each kind of card.
 */
export function rightShare(log, deckId, now) {
  const from = dayKey(now - 29 * DAY);
  let again = 0;
  let total = 0;
  for (const [key, byDeck] of Object.entries(log)) {
    if (key < from) continue;
    for (const [id, row] of Object.entries(byDeck)) {
      if (deckId && id !== deckId) continue;
      row.forEach((n, i) => {
        total += n;
        if (i % 4 === 0) again += n;
      });
    }
  }
  return total ? (total - again) / total : null;
}
