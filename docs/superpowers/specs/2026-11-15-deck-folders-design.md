# Deck folders

## Intent

The admin's home page is filling up with textbook chapters next to the Portuguese decks. Folders let them group decks on **their own** home page, for example "Portuguese" and "Textbooks". Nobody else's list changes.

## Goals

- Create, rename and delete folders, one level deep.
- Put a deck in a folder, or take it out, from Deck settings. On a desktop, decks can also be dragged onto a folder heading or out to the loose list.
- On the home page, each folder is a heading that opens and closes, like the Hidden section. It shows the deck count and the combined new / learning / due counts of its decks. Decks in no folder stay loose, below the folders.
- Which folders are open is remembered.
- Folders follow the person between devices.

## Non-goals

- No folders inside folders.
- No studying a whole folder at once. Start review is unchanged.
- No change for people a deck was given to, and nothing on the Admin screen.

## Anti-goals

- Deleting a folder must never delete or hide a deck.
- Folders must not change a deck's name, which for a given deck is shared with everyone.

## Approaches

- **A. Personal folders saved with the person's settings (picked).** Changes nothing anyone else sees, and syncs like the other settings.
- **B. Anki-style names (`Textbooks::Robotics`).** Dropped: it renames decks, which for a given deck changes the name for every recipient.

## Design

- **Storage:**
  - The folder list goes in the user's settings as `folders: [{ id, name }]`, in display order. Settings already sync per user and are capped at 16 KB on the server, which is plenty.
  - A deck's folder is a personal deck pref `folder: <folder id>`, absent when loose. It is stored in `deck_prefs` like `hidden`, so it works on given decks too.
  - `giveTo` (`server/admin.js`) drops `folder` from the prefs it copies to a new recipient, as it drops `hidden`.
  - A `folder` naming a folder that no longer exists counts as loose.
- **Hidden wins.** A hidden deck shows only in the Hidden section. Showing it again puts it back in its folder.
- **Home page** (`renderHome`):
  - Order: folders in list order, then loose decks, then Hidden.
  - A folder is a `<details>` whose summary reads "Name · N decks" with the combined count pills. Inside it are the same deck rows as the loose list.
  - An empty folder still shows, as "Name · empty", so it can be filled or deleted.
  - The folder's ⋯ menu has Rename and Delete. Delete moves its decks back to loose and says so in a toast.
  - Open folders are remembered in `localStorage`, wrapped in try/catch, closed by default.
- **Deck settings:** a **Folder** select listing "No folder", each folder, and "New folder…". Choosing New folder asks for a name and creates the folder.
- **Drag and drop (desktop only):** a deck row can be dragged onto a folder summary to file it there, or onto the loose list to take it out. Phones use Deck settings.
- Today's figures, the Start review deck order, Upcoming and Statistics are unchanged.

## Left to the builder

- Folder ids (use the store's existing `uid()`).
- Exact styling, matched to the Hidden section and the deck rows.
- Whether the name prompt is a small dialog in the app's existing style or a text field in the menu.
