# How it works page

## Why

New people, invited friends and family, often don't know what Dohrao is or how spaced repetition works, and some come from Anki and have never seen a reserve. Several of them read Urdu more easily than English. A short page that explains the daily routine gives them, and the admin, somewhere to point to.

## Goals

- A short page at `#/help`, readable in about two minutes, with five sections:
  1. **The daily routine**: open the app each day, study what is due, stop when it says you are done. Dohrao brings each card back just before you would forget it.
  2. **The four buttons**: Again (forgot it, comes back soon), Hard, Good (the usual choice), Easy. Each button shows when the card would come back.
  3. **New, learning and due**: what each count on a deck means.
  4. **The reserve**: cards kept out of study until you pull them in. A deck you were given starts on your reserve, so open it and press Pull in to start.
  5. **Keyboard shortcuts**: Space/Enter, 1–4, R, E, H, Ctrl+Z, and `?` for this page. Headed as being for a computer.
- A toggle at the top: **English | اردو | Roman Urdu**, the same choices as the cards' front and Urdu writing.
- Opened from:
  - a **How it works** item in the account menu (desktop and phone);
  - a **How it works** link on the login and sign-up screens;
  - the `?` key on any screen, except while typing in a field or with a dialog open.
- Readable before login, so that someone who only has an invite link can read it.

## Non-goals

- Translating the rest of the interface into Urdu.
- A guided tour, tooltips or first-run hints (a separate idea).
- Help for the admin (giving decks, invite codes) or for authoring (maths, images, imports).
- A "Both" option showing two languages side by side: too long on a phone.

## Anti-goals

- Anything that gets between the learner and the next card. The page is only ever opened on purpose.
- Machine-translated Urdu that reads badly.

## Approaches

- **A. A page inside the app (chosen).** The text for all three languages lives in a new `js/help.js`, and `render()` draws it at `#/help` like any other screen, with the same theme and phone layout. Chosen because it fits the app, reaches the login screen with one route, and keeps one set of styles.
- **B. Separate static HTML pages.** Quick to write, but outside the app: no theme toggle, duplicate styles, and `?` would have to leave the app.
- **C. Text the admin can edit from the Admin screen.** Needs a table, an editor and sync, for a page that will rarely change.

## Decided

- The Urdu script and Roman Urdu are written by Claude, not Google Translate, and the owner checks both before deploying.
- Button names, counts and keys stay as they appear in the interface (Again, Good, Pull in, `1`–`4`), in English letters, inside the Urdu text, so the page matches what people see.
- Urdu script is right to left (`lang="ur" dir="rtl"`) in the same Nastaliq font stack the cards use; Roman Urdu is `lang="ur-Latn"`, left to right.
- The toggle's choice is remembered in the browser (`localStorage`, wrapped in try/catch). With no choice saved, it starts in Urdu if any of the person's decks shows the Urdu front, otherwise in English. Before login it starts in English.
- Logged in, the page has the usual top bar. Logged out, it has the brand and a link back to Log in.
- Voice: plain, short, concrete sentences, as in PRODUCT.md, with Anki's words kept.

## Left to the builder

- The account menu icon, the exact layout of the toggle (a segmented control like the rest of the app), and how the shortcut list is drawn.
- What `?` does on the study screen: going to the page is fine, since the study clock already pauses when the page changes, and Back returns to the card.
- Tests: the three languages have the same sections in the same order, and `?` is ignored in text fields and dialogs.
- It is a browser-only change; deploy with `deploy/deploy.sh` as usual.
