// What the desktop deck page decides without a page: how wide the tabbed layout reaches, which
// reserve cards Pull in would take, and which ticked cards each column acts on.

import { inTab } from './phone.js';

// Up to this width the deck page shows the phone's Cards / Reserve / Topics tabs; wider, the
// reserve and the cards being studied sit side by side.
export const TABBED_DECK_QUERY = '(max-width: 899px)';

const DEFAULT_AMOUNT = 10;

/** How many cards to pull in: a whole number from 1 to what is available, or 0 when nothing is. */
export function clampAmount(value, available) {
  if (available <= 0) return 0;
  const n = Number.isFinite(value) ? Math.round(value) : Math.min(available, DEFAULT_AMOUNT);
  return Math.min(available, Math.max(1, n));
}

/**
 * Each card's place in the queue Pull in takes from (1 first), and the ids of the next `n`.
 * A search shows some of the queue: its rows keep these places, so the numbers never lie.
 */
export function pullPreview(queue, n) {
  const place = new Map(queue.map((card, i) => [card.id, i + 1]));
  const next = new Set(queue.slice(0, clampAmount(n, queue.length)).map((card) => card.id));
  return { place, next };
}

/** "Pull all 1,465", or "Pull all 212 from Verbs" when a topic is chosen. */
export function pullAllLabel(count, topicName) {
  return `Pull all ${count.toLocaleString()}${topicName ? ` from ${topicName}` : ''}`;
}

/** The ticked ids among `cards` that belong to a list's view: the reserve, the rest, or all. */
export function ownTicks(selected, cards, view) {
  return cards.filter((card) => selected.has(card.id) && (view === 'all' || inTab(card, view))).map((card) => card.id);
}

/**
 * Untick, in place, the cards a list no longer shows: those in its view that are not among
 * `shown`, and any that no longer exist. Ticks in another list's view are left alone.
 */
export function pruneTicks(selected, shown, view, cardOf) {
  const kept = new Set(shown.map((card) => card.id));
  for (const id of [...selected]) {
    const card = cardOf(id);
    if (!card || ((view === 'all' || inTab(card, view)) && !kept.has(id))) selected.delete(id);
  }
}
