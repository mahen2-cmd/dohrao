// Undo for the study screen: the answers given in one session, newest last, and which cards
// came back by undo. A card brought back is not counted again on its next answer, as its first
// answer was counted already and counts are never lowered. After that it counts as usual.

export function createUndo() {
  const history = [];
  const uncounted = new Set();
  return {
    get size() {
      return history.length;
    },
    /** Keep what `answerCard` handed back. */
    record(copy) {
      history.push(copy);
    },
    /** Take back the newest answer `restore` accepts, going past any it refuses. The copy, or null. */
    undo(restore) {
      while (history.length > 0) {
        const copy = history.pop();
        if (!restore(copy)) continue;
        uncounted.add(copy.id);
        return copy;
      }
      return null;
    },
    /** Whether an answer to card `id` adds to the day's counts. */
    countAnswer(id) {
      return !uncounted.delete(id);
    },
  };
}
