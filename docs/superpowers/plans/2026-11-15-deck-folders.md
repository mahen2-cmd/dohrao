# Deck Folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each person can group decks into one-level folders on their own home page.

**Architecture:** The folder list lives in the user's synced `settings.folders`. A deck's folder is the personal deck pref `folder`. Store helpers in `js/store.js` own all reads and writes. `renderHome` groups the rows. Deck settings and a folder menu edit them. Drag and drop is desktop-only sugar over the same helpers.

**Tech Stack:** plain ES modules, `node --test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-15-deck-folders-design.md`

## Global Constraints

- Folders are personal. `folder` is not in `DECK_SHARED` (`server/fields.js`) or `SHARED_DECK_KEYS` (`js/store.js`).
- `giveTo` drops `folder` when copying the owner's prefs, as it drops `hidden`.
- Deleting a folder never deletes or hides a deck.
- A `folder` id with no matching folder counts as loose.
- Hidden wins over folder on the home page.
- Copy:
  - Deck settings select "Folder" with the options "No folder", the folder names, and "New folder…";
  - the summary reads "Name · N decks", or "Name · empty";
  - the menu items are "Rename folder" and "Delete folder";
  - the delete toast reads "Deleted “Name”. Its decks are back in your list."
- Open folders are kept in `localStorage` key `recall.openFolders` (an array of ids). Every access is wrapped in try/catch, and folders are closed by default.

## Review Focus

1. **Folder name empty or only spaces:** refused; the dialog stays open. Test in Task 1 (`createFolder` throws).
2. **Deck's folder deleted on another device:** the deck shows loose, with no crash. Test in Task 1 (`folderOf`).
3. **Given deck put in a folder, then given to someone new:** the recipient's copy has no `folder`. Test in Task 2.
4. **Hidden deck inside a folder:** it shows only under Hidden. Test in Task 1 (`homeGroups`).
5. **Duplicate folder names:** allowed (ids differ); Task 1 `createFolder` test.

---

### Task 1: Store helpers

**Files:** Modify `js/store.js`; test in `tests/store.test.js` (mirror the setup of the 'hiding and showing a deck' test near line 787).

**Produces:**
- `folders() -> Array<{ id: string, name: string }>`: returns `settings.folders`, or `[]` when unset.
- `createFolder(name: string) -> { id, name }`. It trims the name, throws `Error('empty-name')` when it's empty, appends the folder and saves.
- `renameFolder(id: string, name: string) -> void`. Same trim and empty check; it does nothing for an unknown id.
- `deleteFolder(id: string) -> number`. It removes the folder and the `folder` field from every deck that had it, saves, and returns how many decks were moved.
- `setDeckFolder(deckId: string, folderId: string|null) -> void`. `null` deletes the field.
- `folderOf(deck) -> string|null`: the deck's `folder` if a folder with that id exists, otherwise `null`.
- `homeGroups(decks) -> { folders: Array<{ folder, decks }>, loose: deck[], hidden: deck[] }`. Hidden decks go only in `hidden`. Folders follow `folders()` order, including empty ones. Loose decks keep their input order.

- [ ] **Step 1: Write failing tests:**
  - 'folders can be created, renamed and deleted, and deleting moves decks back': `deleteFolder` returns 2 for two filed decks, after which `folderOf` is null for both and `folders()` is empty;
  - 'a folder name cannot be empty': `createFolder('   ')` throws `empty-name`;
  - 'two folders may share a name';
  - 'a deck whose folder is gone counts as loose';
  - 'homeGroups puts hidden decks only under hidden, keeps folder order and empty folders';
  - 'folder is a personal deck field': `updateDeck`/`setDeckFolder` on an assigned deck works, like the hidden test at line 798.
- [ ] **Step 2:** Run `node --test tests/store.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. Folders are written through the existing `setSetting('folders', …)` so they sync; use the store's `uid()`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Let the store keep deck folders".

### Task 2: A new recipient doesn't get the owner's folder

**Files:** Modify `server/admin.js` (`giveTo`, the destructure that drops `hidden`); test in `tests/admin.test.js` (beside the test at line 165).

- [ ] **Step 1:** Write the failing test "the owner's folder is not copied to a new recipient": Ana's prefs have `folder: 'f1'`; after `assignDeck` to Ben, Ben's view of the deck has no `folder`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Add `folder` to the destructure.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Keep the owner's deck folder to themselves when giving a deck".

### Task 3: Home page, Deck settings, folder menu, drag and drop

**Files:** Modify `js/app.js` (`renderHome` ~line 1776, `hiddenSection` ~1750, `openDeckDialog` ~540) and `css/styles.css` (next to `.hidden-decks` ~line 636).

**Consumes:** Task 1's helpers.

- [ ] **Step 1: Home page.**
  - Pull the existing `row` builder in `renderHome` out so folder bodies and the loose list share it.
  - Render `homeGroups(shown + hidden)`:
    - each folder is a `<details class="deck-folder">`. Its summary holds the chevron, then "Name · N decks" (or "Name · empty"), then `countPills` summed over its decks, then a `menu(…)` with Rename folder and Delete folder;
    - its body is a `ul.deck-list` of rows;
    - then the loose `ul.deck-list`, then `hiddenSection`.
  - `todayPanel` keeps getting every shown deck, whatever its folder.
- [ ] **Step 2: Open state.** Keep `recall.openFolders` in localStorage under try/catch, and update it on `toggle`.
- [ ] **Step 3: Rename and Delete.**
  - Rename and New folder… use one small `modal()` with a text field and Save, matching the app's dialogs. An empty name keeps the dialog open.
  - Delete confirms with the existing confirm pattern if there is one (grep `confirm(`), otherwise acts directly, then shows the toast from Global Constraints.
- [ ] **Step 4: Deck settings.** Add the Folder select after the Hidden checkbox:
  - its value is `folderOf(deck)`, with '' meaning No folder;
  - choosing "New folder…" opens the name dialog, then selects the new folder;
  - on Save, call `setDeckFolder` when the value changed;
  - not shown in the New deck dialog.
- [ ] **Step 5: Drag and drop (desktop).**
  - Deck rows get `draggable="true"` on wide screens only, carrying the deck id.
  - A folder summary and the loose list accept the drop (`dragover` preventDefault, a highlight class) and call `setDeckFolder`, then `render()`.
  - Grep how the reserve column does drag and drop (`dataTransfer` in app.js) and match its approach.
- [ ] **Step 6: CSS.** Style `.deck-folder` like `.hidden-decks`: summary row, chevron rotation and hover, with a drop-target highlight. Make it work at phone width, with no horizontal scroll.
- [ ] **Step 7:** Run `npm test`. Expected: PASS.
- [ ] **Step 8: Check in a browser,** with Playwright Chromium from the scratchpad against a local server on a copy of the data. Check:
  - create a folder from Deck settings;
  - file two decks into it;
  - the summary counts;
  - collapse and reload, and it stays closed;
  - rename;
  - drag a deck out (desktop);
  - delete the folder, and the decks are back;
  - hide a filed deck, and it shows only under Hidden;
  - the page at 390 px wide.

  Take screenshots in light and dark.
- [ ] **Step 9:** Commit with the message "Group decks into folders on the home page".
