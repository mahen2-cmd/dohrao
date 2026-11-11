// Which fields are shared content and which are per-user progress.

/** Deck fields every user sees; the rest of a deck's fields are personal. */
export const DECK_SHARED = ['name', 'created', 'ankiId', 'frontLang', 'backLang', 'saveAudio'];

/** Card fields that are content; the rest (due, state, ...) are progress. */
export const CARD_CONTENT = ['front', 'back', 'created', 'updated', 'ankiId', 'reversed'];

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
