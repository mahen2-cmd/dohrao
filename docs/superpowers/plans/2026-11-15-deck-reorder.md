# Deck Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drag decks on the desktop home page to set their order within a folder or the loose list.

**Architecture:** A personal deck pref `homeOrder` (a number) orders each home-page group. `store.reorderDecks(ids)` writes it. `homeGroups` sorts by it. The server validates it and keeps it from being copied to recipients. Desktop drag and drop on deck rows calls the store.

**Tech Stack:** plain ES modules, `node --test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-15-deck-reorder-design.md`

## Global Constraints

- `homeOrder` is personal. It is not in `DECK_SHARED` (`server/fields.js`) or `SHARED_DECK_KEYS` (`js/store.js`).
- `giveTo` (`server/admin.js` ~line 57) drops `homeOrder`.
- Server prefs validation (`server/sync.js`, near the `folder` check ~line 58) rejects a `homeOrder` that isn't a finite number.
- Sorting is stable. Decks without `homeOrder` sort after those with one, keeping their input order.
- Reordering never changes a deck's folder unless it was dropped into a different group.
- Desktop only. The drop line uses the classes `drop-before` and `drop-after` on the target row.

## Review Focus

1. **A deck with no `homeOrder` among ordered ones:** it sorts after them, without jumping around between renders. Tested in Task 1.
2. **A hand-made `homeOrder` such as `"x"` or `Infinity`:** the server rejects it. Tested in Task 1.
3. **A drop onto the deck's own row:** no change. Checked in the Task 2 browser check.
4. **A drop onto a row in another folder:** the folder changes and the deck lands at that position. Checked in the Task 2 browser check.
5. **A new recipient of a deck you've ordered:** they get no `homeOrder`. Tested in Task 1.

---

### Task 1: Order in the store and the server

**Files:**
- Modify `js/store.js` (`homeGroups` ~line 502; add `reorderDecks`), `server/sync.js` (prefs validation) and `server/admin.js` (`giveTo`).
- Test in `tests/store.test.js`, `tests/sync.test.js` and `tests/admin.test.js`.

**Produces:**
- `reorderDecks(ids: string[]) -> void`. For each id that matches a deck, it sets `homeOrder` to that id's index, then saves. Unknown ids are ignored.
- `homeGroups(list)`: the same shape as today, with each folder's `decks` and `loose` sorted stably by `homeOrder` (missing counts as `Infinity`).

- [ ] **Step 1: Write failing tests:**
  - store:
    - 'reorderDecks orders decks within a folder and within the loose list';
    - 'decks without homeOrder sort after ordered ones, keeping their order';
    - 'reorderDecks never changes a deck's folder';
    - 'homeOrder is a personal deck field', mirroring the folder test.
  - sync: 'a homeOrder that is not a finite number is refused'. Sending `"x"` or `null` gets the deck rejected; `3` is saved.
  - admin: "the owner's homeOrder is not copied to a new recipient".
- [ ] **Step 2:** Run `npm test`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: all PASS.
- [ ] **Step 5:** Commit with the message "Keep a personal order for decks on the home page".

### Task 2: Drag to reorder on the home page

**Files:** Modify `js/app.js` (the deck row builder and the drag handlers ~lines 1880–1930) and `css/styles.css` (next to the existing drop-target styles).

**Consumes:** `store.reorderDecks`, `store.setDeckFolder`, `store.folderOf`, `store.homeGroups`.

- [ ] **Step 1: Row drop targets.** On wide screens, each deck row gets `dragover` (preventDefault; set `drop-before` or `drop-after` by comparing the pointer's `clientY` with the row's vertical middle), `dragleave` (clear the class) and `drop`.
- [ ] **Step 2: Drop logic.**
  - Ignore a drop of a deck onto itself.
  - The target group is the row's folder id (or null for loose).
  - If it differs from the dragged deck's `folderOf`, call `setDeckFolder(dragged, targetFolder)`.
  - Build the target group's current ids (from `homeGroups(store.decks())`, minus the dragged deck), insert the dragged id before or after the target, call `reorderDecks(ids)`, then `render()`.
- [ ] **Step 3: Heading drops.** Dropping on a folder heading still files the deck into the folder, and now also puts it last by setting its `homeOrder` above the folder's current maximum.
- [ ] **Step 4: CSS.** Show the drop line as a 2px accent-coloured line above (`drop-before`) or below (`drop-after`) the row. Use a pseudo-element or box-shadow so nothing shifts. It must work in light and dark.
- [ ] **Step 5:** Run `npm test`. Expected: PASS.
- [ ] **Step 6: Check in a browser,** with the Playwright Chromium in the scratchpad against a server on a fresh data copy:
  - reorder two decks inside a folder;
  - reload, and the order is kept;
  - reorder in the loose list;
  - drag a deck onto a row in another folder, and it moves there at that spot;
  - drop a deck on its own row, and nothing changes;
  - drop on a folder heading, and the deck goes to the end;
  - look at the drop line in light and dark.

  Take screenshots.
- [ ] **Step 7:** Commit with the message "Drag decks to reorder them on the home page".
