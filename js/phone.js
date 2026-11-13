// What the phone layout (640px and narrower) decides without a page: which cards a deck tab
// lists, and what a swipe on the study card means.

import { Rating } from './fsrs.js';

export const PHONE_QUERY = '(max-width: 640px)';

// Weeks of activity in the statistics calendar: a phone shows what fits its width.
export const HEAT_WEEKS = { phone: 16, wide: 53 };

/**
 * The list filters a deck tab uses on a phone, as a new object: the Reserve tab shows the whole
 * reserve in the order it is pulled in (it has no filters of its own to show or clear), and the
 * Cards tab drops the "On reserve" chip.
 */
export function tabFilters(filters, tab) {
  if (tab === 'reserve') return { ...filters, groups: ['reserve'], due: 'any', added: 'any', lapses: 'any', topics: [], sort: 'reserve' };
  return { ...filters, groups: filters.groups.filter((g) => g !== 'reserve'), sort: filters.sort === 'reserve' ? 'newest' : filters.sort };
}

/** Whether a card belongs in a deck tab's list on a phone. */
export const inTab = (card, tab) => (tab === 'reserve' ? !!card.reserved : !card.reserved);

// How far the card must travel to rate, as a share of its width (sideways) or height (up and down).
export const SWIPE = { x: 0.3, y: 0.22 };

/** The answer a drag points at, however short: right Good, left Again, up Easy, down Hard. */
export function swipeLeaning({ dx, dy, verticalAllowed }) {
  const y = verticalAllowed ? dy : 0;
  if (!dx && !y) return null;
  if (Math.abs(dx) >= Math.abs(y)) return dx > 0 ? Rating.Good : Rating.Again;
  return y < 0 ? Rating.Easy : Rating.Hard;
}

/** The answer a drag gives when let go, or null when it fell short of the threshold. */
export function classifySwipe({ dx, dy, width, height, verticalAllowed }) {
  // On a card that scrolls, a mostly vertical drag is a scroll, never a sideways rating.
  if (!verticalAllowed && Math.abs(dy) > Math.abs(dx)) return null;
  const rating = swipeLeaning({ dx, dy, verticalAllowed });
  if (rating === Rating.Good || rating === Rating.Again) return Math.abs(dx) >= SWIPE.x * width ? rating : null;
  if (rating) return Math.abs(dy) >= SWIPE.y * height ? rating : null;
  return null;
}

// Things inside a card that are pressed or scrolled for themselves, not to turn the card over.
const OWN_TARGETS = 'button, a, input, textarea, select, img, .katex-display, [contenteditable]';

/** Whether a tap on `target` should show the answer: anywhere on `card` but its own controls. */
export function isRevealTap(target, card) {
  const hit = target.closest?.(OWN_TARGETS);
  return !(hit && card.contains(hit));
}

/**
 * Whether a drag starting on `target` may swipe the card: not when it starts inside something
 * that scrolls sideways (a wide equation or image), which scrolls instead. `scrollsX(el)` says
 * whether an element scrolls sideways; the walk up stops at `stop`, the card.
 */
export function canSwipeFrom(target, { scrollsX, stop }) {
  for (let el = target; el && el !== stop; el = el.parentElement) if (scrollsX(el)) return false;
  return true;
}
