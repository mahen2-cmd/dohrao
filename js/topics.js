// Pure helpers for topics and groups inside a deck: file names, readable names, study filters.

/**
 * The topic key in a file name: `new_cards_verb_ser.csv` gives `verb_ser`. Works for .csv, .xlsx,
 * .tsv and .txt in any case. `new_cards_all` and every other name give null.
 */
export function topicKeyFromFileName(name) {
  const m = /^new_cards_(.+)\.(?:csv|xlsx|tsv|txt)$/i.exec(String(name ?? ''));
  if (!m || m[1].toLowerCase() === 'all') return null;
  return m[1].toLowerCase();
}

/** A name a person can read from a key: `verb_ser` gives `Ser`, `cafe_ordering` gives `Cafe ordering`. */
export function readableTopicName(key) {
  const text = String(key).replace(/^verb_/i, '').replace(/_/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The group shared by every topic whose key starts with the same first segment as `key`
 * (`verb` for `verb_ir`). Null when there is no such topic or they sit in different groups.
 */
export function prefixGroup(deck, key) {
  if (!String(key).includes('_')) return null; // no prefix to share
  const first = String(key).split('_')[0];
  const ids = new Set();
  for (const t of deck.topics ?? []) {
    if (t.key && t.key.split('_')[0] === first) ids.add(t.groupId ?? null);
  }
  if (ids.size !== 1) return null;
  return [...ids][0] ?? null;
}

// The filter entries that still point at something in the deck, in order.
function liveEntries(deck, filter) {
  const groups = new Set((deck.groups ?? []).map((g) => g.id));
  const topics = new Set((deck.topics ?? []).map((t) => t.id));
  return (filter ?? []).filter(
    (e) => e === 'unsorted' || (e.startsWith('g:') && groups.has(e.slice(2))) || (e.startsWith('t:') && topics.has(e.slice(2))),
  );
}

/**
 * Turn a saved study filter into the set of topic ids to study (`''` is Unsorted). Null means
 * Everything: no filter, or none of its entries exist any more.
 */
export function resolveFilter(deck, filter) {
  const live = liveEntries(deck, filter);
  if (!live.length) return null;
  const set = new Set();
  for (const e of live) {
    if (e === 'unsorted') set.add('');
    else if (e.startsWith('t:')) set.add(e.slice(2));
    else for (const t of deck.topics ?? []) if (t.groupId === e.slice(2)) set.add(t.id);
  }
  return set;
}

/**
 * The topic a card is in: its `topic` while the deck still has that topic, otherwise `''`
 * (Unsorted). A topic id the deck no longer has counts as no topic, everywhere.
 */
export function effectiveTopic(deck, card) {
  const id = card.topic;
  return id && (deck?.topics ?? []).some((t) => t.id === id) ? id : '';
}

/** Whether a card in `deck` is in the resolved filter. A card with no topic counts as Unsorted. */
export function inFilter(card, set, deck) {
  return set === null || set.has(effectiveTopic(deck, card));
}

/** Short words for the filter: `Everything`, one name, or `Verbs and 2 more`. */
export function filterLabel(deck, filter) {
  const live = liveEntries(deck, filter);
  if (!live.length) return 'Everything';
  const name = (e) => {
    if (e === 'unsorted') return 'Unsorted';
    const list = e.startsWith('g:') ? deck.groups : deck.topics;
    return list.find((x) => x.id === e.slice(2)).name;
  };
  return live.length === 1 ? name(live[0]) : `${name(live[0])} and ${live.length - 1} more`;
}

/** Card text for the AI service: `[image:…]` markers removed, LaTeX left as written. */
export function aiText(side) {
  return String(side ?? '').replace(/\[image:[^\]]*\]/g, '').trim();
}
