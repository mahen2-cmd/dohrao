// Which fields are shared content and which are per-user progress.

/** Deck fields every user sees; the rest of a deck's fields are personal. */
export const DECK_SHARED = ['name', 'created', 'ankiId', 'frontLang', 'backLang', 'saveAudio', 'groups', 'topics', 'topicsAt'];

/** Card fields that are content; the rest (due, state, ...) are progress. */
export const CARD_CONTENT = ['front', 'back', 'created', 'updated', 'ankiId', 'reversed', 'topic', 'topicBy', 'topicAt'];

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
