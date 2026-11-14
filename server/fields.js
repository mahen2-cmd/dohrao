// Which fields are shared content and which are per-user progress.

/** Deck fields every user sees; the rest of a deck's fields are personal. */
export const DECK_SHARED = ['name', 'created', 'ankiId', 'frontLang', 'backLang', 'saveAudio', 'groups', 'urdu', 'topics', 'topicsAt', 'deletedGroupIds', 'deletedTopicIds'];

/** Card fields that are content; the rest (due, state, ...) are progress. */
export const CARD_CONTENT = ['front', 'back', 'created', 'updated', 'ankiId', 'reversed', 'topic', 'topicBy', 'topicAt', 'urdu', 'urduRoman', 'urduOf', 'urduBy', 'urduAt'];

/** Split an object into [shared, personal] by key list, dropping id and deckId. */
export function split(obj, sharedKeys) {
  const shared = {};
  const personal = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'id' || key === 'deckId') continue;
    (sharedKeys.includes(key) ? shared : personal)[key] = value;
  }
  return [shared, personal];
}

/**
 * Keep the newer topic when an older device syncs. Returns `incoming`, except that when the
 * stored copy's `atKey` time is later, `fields` and `atKey` come from `stored` instead (a field
 * the stored copy lacks is left out).
 */
export function mergeTopics(stored, incoming, fields, atKey) {
  if ((stored[atKey] ?? 0) <= (incoming[atKey] ?? 0)) return incoming;
  const merged = { ...incoming };
  for (const key of [...fields, atKey]) {
    if (key in stored) merged[key] = stored[key];
    else delete merged[key];
  }
  return merged;
}

/** How many deleted ids a deck remembers per list; the oldest are forgotten first. */
export const TOMBSTONES_MAX = 500;

/** `list` with `id` added at the end (moved there if it was already in), the most recent kept. */
export function addTombstone(list, id) {
  return [...(list ?? []).filter((x) => x !== id), id].slice(-TOMBSTONES_MAX);
}

/**
 * Merge a deck's groups and topics item by item. For an item on both sides the side with the
 * later `topicsAt` wins; an item on one side only is kept unless either side has deleted it (its
 * id is in `deletedGroupIds` / `deletedTopicIds`, which are joined). A topic whose group is gone
 * is left outside any group. Every other field comes from `incoming`.
 */
export function mergeDeckTopics(stored, incoming) {
  const storedNewer = (stored.topicsAt ?? 0) > (incoming.topicsAt ?? 0);
  const [newer, older] = storedNewer ? [stored, incoming] : [incoming, stored];
  const merged = { ...incoming };
  // Anything malformed counts as an empty list.
  const arr = (side, key) => (Array.isArray(side[key]) ? side[key] : []);
  const tombs = (key) => {
    const all = [...arr(older, key), ...arr(newer, key)].filter((id) => typeof id === 'string');
    return [...new Set(all)].slice(-TOMBSTONES_MAX);
  };
  const items = (key, gone) => {
    const valid = (side) => arr(side, key).filter((x) => x && typeof x === 'object');
    const seen = new Set(valid(newer).map((x) => x.id));
    const list = [...valid(newer), ...valid(older).filter((x) => !seen.has(x.id))];
    return list.filter((x) => !gone.has(x.id));
  };
  for (const [listKey, tombKey] of [['groups', 'deletedGroupIds'], ['topics', 'deletedTopicIds']]) {
    const gone = tombs(tombKey);
    if (gone.length) merged[tombKey] = gone;
    else delete merged[tombKey];
    if (listKey in stored || listKey in incoming) merged[listKey] = items(listKey, new Set(gone));
    else delete merged[listKey];
  }
  if (merged.topics) {
    const groups = new Set((merged.groups ?? []).map((g) => g.id));
    merged.topics = merged.topics.map((t) => (t.groupId != null && !groups.has(t.groupId) ? { ...t, groupId: null } : t));
  }
  if ('topicsAt' in newer) merged.topicsAt = newer.topicsAt;
  else delete merged.topicsAt;
  return merged;
}
