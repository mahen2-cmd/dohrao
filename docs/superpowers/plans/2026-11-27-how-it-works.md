# How it works page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A short "How it works" page at `#/help`, in English, Urdu script and Roman Urdu with a toggle, opened from the account menu, the login and sign-up screens, and the `?` key.

**Architecture:** The page's text in all three languages and the pure decisions (which language to start in, whether a key press means "open help") live in a new `js/help.js`, tested with `node --test`. `js/app.js` draws the page in a new `renderHelp()`, routed from `render()` both signed in and signed out, and adds the three ways in. Styles go in `css/styles.css`.

**Tech Stack:** Plain browser JavaScript modules, no build step; `node:test` and `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-11-27-how-it-works-design.md`

## Global Constraints

- Route: `#/help`, readable signed in and signed out.
- Toggle labels, in this order: **English | اردو | Roman Urdu**. Language codes: `'en'`, `'ur'`, `'ur-Latn'`. No "Both".
- Button names, counts and keys appear exactly as in the interface, in English letters, in every language: `Start review`, `Show answer`, `Again`, `Hard`, `Good`, `Easy`, `New`, `Learning`, `Due`, `Nothing due`, `Pull in`.
- Urdu script: `lang="ur" dir="rtl"`, the cards' Nastaliq font stack. Roman Urdu: `lang="ur-Latn"`, left to right.
- Choice saved in `localStorage` under `dohrao.helpLang`; every read and write in try/catch. With nothing saved: Urdu if any deck's front shows Urdu (`'ur-Latn'` if that deck uses Roman Urdu), else English. Signed out: English unless a choice is saved.
- `?` opens the page from any screen, except while typing in a field (`input, textarea, select, [contenteditable], math-field`) or with a dialog open.
- Voice: plain, short, concrete sentences. No new dependencies.
- The owner checks the Urdu and Roman Urdu copy before deploying.

## Review Focus

1. **`?` typed in the card editor, the search box or the MathLive equation box** must type a `?`, not leave the page. `<math-field>` is not an `input`, so it must be in the selector. Covered by `isHelpKey` tests with `typing: true` (Task 1) and the selector in Task 3.
2. **Private browsing or blocked storage**: `localStorage` throws, and the page must still render, in the default language, and the toggle must still switch. Covered by an `initialHelpLang(undefined, …)` test (Task 1) and a manual check in Task 2.
3. **Signed out on `#/help`, then "Log in"**: must reach the login form, not a blank page. The auth screen skips redrawing when a form is already showing, and the help page must not be mistaken for one. Manual check in Task 2.
4. **Urdu script on a 360px phone**: Nastaliq needs extra line height, and key names inside RTL text must stay left to right (`Ctrl+Z` must not become `Z+Ctrl`). Keys are wrapped in `<kbd dir="ltr">`. Manual check in Task 2.
5. **`?` during a study session**: the page opens, the study clock pauses (the existing `render()` already does this off the study view), and browser Back returns to the card. Manual check in Task 3.

---

### Task 1: The help text and its decisions (`js/help.js`)

**Files:**
- Create: `js/help.js`
- Test: `tests/help.test.js`

**Interfaces:**
- Consumes: `frontShows(deck) -> 'en' | 'ur' | 'both'` from `js/urdu.js`; a deck's `urduScript` is `'arabic' | 'roman'` (missing means `'arabic'`).
- Produces:
  - `HELP_LANGS: [['en', 'English'], ['ur', 'اردو'], ['ur-Latn', 'Roman Urdu']]`
  - `HELP_LANG_KEY = 'dohrao.helpLang'`
  - `HELP: { [lang]: { title: string, intro: string, sections: Section[] } }` where `Section = { id: 'daily' | 'buttons' | 'counts' | 'reserve' | 'keys', heading: string, steps?: string[], terms?: [string, string][], text?: string[], keys?: [string[], string][] }`. `steps` is a numbered list, `terms` a term and its meaning, `text` paragraphs, `keys` key names and what they do.
  - `initialHelpLang(saved: string | null | undefined, decks: Deck[] | undefined) -> 'en' | 'ur' | 'ur-Latn'`
  - `isHelpKey({ key, ctrlKey, metaKey, altKey, typing }) -> boolean`

- [ ] **Step 1: Write the failing tests in `tests/help.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELP, HELP_LANGS, initialHelpLang, isHelpKey } from '../js/help.js';

const LANGS = ['en', 'ur', 'ur-Latn'];
const IDS = ['daily', 'buttons', 'counts', 'reserve', 'keys'];
const all = (lang) => JSON.stringify(HELP[lang]);

test('the toggle offers English, Urdu and Roman Urdu, in that order', () => {
  assert.deepEqual(HELP_LANGS, [['en', 'English'], ['ur', 'اردو'], ['ur-Latn', 'Roman Urdu']]);
});

test('every language has the same sections, in the same order, with the same number of rows', () => {
  for (const lang of LANGS) {
    assert.deepEqual(HELP[lang].sections.map((s) => s.id), IDS, lang);
    for (const [i, s] of HELP[lang].sections.entries()) {
      const en = HELP.en.sections[i];
      for (const part of ['steps', 'terms', 'text', 'keys']) assert.equal(s[part]?.length, en[part]?.length, `${lang} ${s.id} ${part}`);
    }
  }
});

test('the buttons, counts and keys keep their English names in every language', () => {
  for (const lang of LANGS) {
    const section = (id) => HELP[lang].sections.find((s) => s.id === id);
    assert.deepEqual(section('buttons').terms.map(([t]) => t), ['Again', 'Hard', 'Good', 'Easy'], lang);
    assert.deepEqual(section('counts').terms.map(([t]) => t), ['New', 'Learning', 'Due'], lang);
    assert.deepEqual(section('keys').keys.map(([k]) => k), HELP.en.sections[4].keys.map(([k]) => k), lang);
    for (const label of ['Start review', 'Show answer', 'Nothing due', 'Pull in']) assert.ok(all(lang).includes(label), `${lang}: ${label}`);
  }
});

test('the shortcuts listed are the ones the study screen has, plus ? for this page', () => {
  assert.deepEqual(HELP.en.sections[4].keys.map(([k]) => k), [['Space', 'Enter'], ['1', '2', '3', '4'], ['R'], ['E'], ['H'], ['Ctrl+Z'], ['?']]);
});

test('a saved choice wins; an unknown one is ignored', () => {
  assert.equal(initialHelpLang('ur-Latn', []), 'ur-Latn');
  assert.equal(initialHelpLang('en', [{ frontShows: 'ur' }]), 'en');
  assert.equal(initialHelpLang('fr', []), 'en');
});

test('with nothing saved, a deck showing the Urdu front starts the page in its Urdu writing', () => {
  assert.equal(initialHelpLang(null, [{ frontShows: 'en' }, { frontShows: 'ur' }]), 'ur');
  assert.equal(initialHelpLang(null, [{ frontShows: 'both', urduScript: 'roman' }]), 'ur-Latn');
  assert.equal(initialHelpLang(null, [{ urduSwitch: 'ur', urduScript: 'arabic' }]), 'ur');
  assert.equal(initialHelpLang(null, [{ frontShows: 'en' }]), 'en');
  assert.equal(initialHelpLang(undefined, undefined), 'en'); // signed out, or storage blocked
});

test('? opens help, but not with a modifier or while typing', () => {
  assert.equal(isHelpKey({ key: '?' }), true);
  assert.equal(isHelpKey({ key: '?', ctrlKey: true }), false);
  assert.equal(isHelpKey({ key: '?', metaKey: true }), false);
  assert.equal(isHelpKey({ key: '?', altKey: true }), false);
  assert.equal(isHelpKey({ key: '?', typing: true }), false);
  assert.equal(isHelpKey({ key: '/' }), false);
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --test tests/help.test.js`
Expected: FAIL, `Cannot find module '…/js/help.js'`.

- [ ] **Step 3: Write `js/help.js`**

Use the copy below exactly, as `HELP` (see Interfaces for the shape). In `initialHelpLang`, the first deck whose `frontShows(deck)` is not `'en'` decides: `'ur-Latn'` if its `urduScript === 'roman'`, else `'ur'`. `isHelpKey` is true only for `key === '?'` with no Ctrl, Cmd or Alt and `typing` false (Shift is how `?` is typed, so it is allowed).

**English (`en`)**

- title: How it works
- intro: Dohrao is a flashcard app. It shows you each card again just before you would forget it, so a few minutes a day is enough to remember a lot.
- daily, "Every day", steps:
  1. Open Dohrao once a day and press Start review.
  2. Read the front of the card and try to remember the back. Then press Show answer.
  3. Press a button to say how well you remembered.
  4. When nothing is left, you are done for the day.
  - text: Missed a day? That's fine. Your cards wait for you.
- buttons, "The four buttons", terms:
  - Again: You forgot. The card comes back in a few minutes.
  - Hard: You remembered, with effort. It comes back sooner than with Good.
  - Good: You remembered. This is the usual answer.
  - Easy: It took no effort. It comes back much later.
  - text: Under each button is when the card would come back. Answer honestly: the schedule only works if your answers are true.
- counts, "New, Learning and Due", terms:
  - New: Cards you haven't studied yet. A few join each day.
  - Learning: Cards you saw recently. They come back later the same day.
  - Due: Cards you know, back today to check you still remember them.
- reserve, "The reserve", text:
  - Cards on the reserve are kept out of study until you pull them in.
  - A deck someone gives you starts on your reserve, so at first it says Nothing due. Open the deck, choose how many cards to pull in, and press Pull in. They become New cards. Pull in more whenever you are ready.
- keys, "Keyboard shortcuts (on a computer)", keys:
  - Space, Enter: Show the answer, then answer Good
  - 1, 2, 3, 4: Again, Hard, Good, Easy
  - R: Read the card aloud again
  - E: Edit the card
  - H: Back to your decks
  - Ctrl+Z: Undo your last answer
  - ?: Open this page

**Urdu script (`ur`)**

- title: یہ کیسے کام کرتا ہے
- intro: دہراؤ ایک فلیش کارڈ ایپ ہے۔ یہ ہر کارڈ آپ کو عین اُس وقت دوبارہ دکھاتی ہے جب آپ اسے بھولنے والے ہوں، اس لیے روزانہ چند منٹ بہت کچھ یاد رکھنے کے لیے کافی ہیں۔
- daily, "ہر روز", steps:
  1. دن میں ایک بار دہراؤ کھولیں اور Start review دبائیں۔
  2. کارڈ کا سامنے والا حصہ پڑھیں اور پیچھے والا حصہ یاد کرنے کی کوشش کریں۔ پھر Show answer دبائیں۔
  3. ایک بٹن دبا کر بتائیں کہ آپ کو کتنا اچھا یاد تھا۔
  4. جب کچھ باقی نہ رہے تو آج کا کام ختم۔
  - text: کوئی دن رہ گیا؟ کوئی بات نہیں۔ آپ کے کارڈ آپ کا انتظار کریں گے۔
- buttons, "چار بٹن", terms:
  - Again: آپ بھول گئے۔ کارڈ چند منٹ میں واپس آئے گا۔
  - Hard: یاد تھا، مگر مشکل سے۔ یہ Good کے مقابلے میں جلدی واپس آئے گا۔
  - Good: آپ کو یاد تھا۔ عام طور پر یہی جواب ہوتا ہے۔
  - Easy: بالکل آسان تھا۔ یہ کافی دیر بعد واپس آئے گا۔
  - text: ہر بٹن کے نیچے لکھا ہوتا ہے کہ کارڈ کب واپس آئے گا۔ ایمانداری سے جواب دیں: شیڈول تبھی ٹھیک چلتا ہے جب آپ کے جواب سچے ہوں۔
- counts, "New، Learning اور Due", terms:
  - New: وہ کارڈ جو آپ نے ابھی تک نہیں پڑھے۔ ہر روز چند نئے کارڈ شامل ہوتے ہیں۔
  - Learning: وہ کارڈ جو آپ نے ابھی حال ہی میں دیکھے۔ یہ اسی دن بعد میں دوبارہ آتے ہیں۔
  - Due: وہ کارڈ جو آپ جانتے ہیں، آج یہ دیکھنے کے لیے واپس آئے ہیں کہ آپ کو اب بھی یاد ہیں۔
- reserve, "ریزرو", text:
  - ریزرو پر رکھے کارڈ پڑھائی میں شامل نہیں ہوتے، جب تک آپ انہیں خود نہ لائیں۔
  - کسی کا دیا ہوا ڈیک شروع میں آپ کے ریزرو پر ہوتا ہے، اس لیے پہلے اس پر Nothing due لکھا آتا ہے۔ ڈیک کھولیں، چنیں کہ کتنے کارڈ لانے ہیں، اور Pull in دبائیں۔ یہ New کارڈ بن جائیں گے۔ جب بھی تیار ہوں، اور لے آئیں۔
- keys, "کی بورڈ شارٹ کٹ (کمپیوٹر پر)", keys:
  - Space, Enter: جواب دکھائیں، پھر Good
  - 1, 2, 3, 4: Again، Hard، Good، Easy
  - R: کارڈ دوبارہ سنیں
  - E: کارڈ میں تبدیلی کریں
  - H: اپنے ڈیکس پر واپس جائیں
  - Ctrl+Z: آخری جواب واپس لیں
  - ?: یہ صفحہ کھولیں

**Roman Urdu (`ur-Latn`)**

- title: Yeh kaise kaam karta hai
- intro: Dohrao aik flashcard app hai. Yeh har card aap ko ain us waqt dobara dikhati hai jab aap usay bhoolne wale hon, is liye roz chand minute bohat kuch yaad rakhne ke liye kaafi hain.
- daily, "Har roz", steps:
  1. Din mein aik baar Dohrao kholein aur Start review dabayein.
  2. Card ka saamne wala hissa parhein aur peeche wala hissa yaad karne ki koshish karein. Phir Show answer dabayein.
  3. Aik button daba kar batayein ke aap ko kitna acha yaad tha.
  4. Jab kuch baqi na rahe to aaj ka kaam khatam.
  - text: Koi din reh gaya? Koi baat nahin. Aap ke cards aap ka intezar karenge.
- buttons, "Chaar button", terms:
  - Again: Aap bhool gaye. Card chand minute mein wapas aaye ga.
  - Hard: Yaad tha, magar mushkil se. Yeh Good ke muqablay mein jaldi wapas aaye ga.
  - Good: Aap ko yaad tha. Aam taur par yehi jawab hota hai.
  - Easy: Bilkul aasaan tha. Yeh kaafi der baad wapas aaye ga.
  - text: Har button ke neeche likha hota hai ke card kab wapas aaye ga. Imandari se jawab dein: schedule tabhi theek chalta hai jab aap ke jawab sachay hon.
- counts, "New, Learning aur Due", terms:
  - New: Woh cards jo aap ne abhi tak nahin parhe. Har roz chand naye cards shamil hote hain.
  - Learning: Woh cards jo aap ne abhi haal hi mein dekhe. Yeh usi din baad mein dobara aate hain.
  - Due: Woh cards jo aap jaante hain, aaj yeh dekhne ke liye wapas aaye hain ke aap ko ab bhi yaad hain.
- reserve, "Reserve", text:
  - Reserve par rakhe cards parhai mein shamil nahin hote, jab tak aap unhein khud na layein.
  - Kisi ka diya hua deck shuru mein aap ke reserve par hota hai, is liye pehle us par Nothing due likha aata hai. Deck kholein, chunein ke kitne cards lane hain, aur Pull in dabayein. Yeh New cards ban jayenge. Jab bhi tayyar hon, aur le aayein.
- keys, "Keyboard shortcuts (computer par)", keys:
  - Space, Enter: Jawab dikhayein, phir Good
  - 1, 2, 3, 4: Again, Hard, Good, Easy
  - R: Card dobara sunein
  - E: Card mein tabdeeli karein
  - H: Apne decks par wapas jayein
  - Ctrl+Z: Aakhri jawab wapas lein
  - ?: Yeh safha kholein

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test tests/help.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add js/help.js tests/help.test.js
git commit -m "Write the How it works text in English, Urdu and Roman Urdu"
```

---

### Task 2: The page at `#/help`

**Files:**
- Modify: `js/app.js` (imports at the top; `ICONS` near line 80; `render()` near line 4859; a new `renderHelp()` next to `renderAuth()` near line 4316)
- Modify: `css/styles.css` (a new `.help` block; reuse `.segmented` at line 2130 and the Nastaliq stack at line 1509)

**Interfaces:**
- Consumes: everything Task 1 produces; `store.decks()`; the existing `h()`, `icon()`, `topbar()`, `brand()`.
- Produces: `renderHelp()` in `js/app.js`, and `icon('help')` (a circled question mark in the same stroke style as the other icons) for Task 3.

- [ ] **Step 1: Route `#/help`**

In `render()`, before the signed-out branch: when `view === 'help'`, call `renderHelp()` and return. That serves the page both signed in and signed out.

- [ ] **Step 2: Write `renderHelp()`**

- Language: `initialHelpLang(saved, account ? store.decks() : undefined)`, where `saved` is read from `localStorage` under `HELP_LANG_KEY` in try/catch (`null` on error).
- Signed in: `topbar('How it works')` above the page. Signed out: `brand('a', { href: '#/' })` and a link **Log in** to `#/`. That link sits outside any `.auth` element, so `render()` draws the login form when it is followed.
- Under the title: a `.segmented` group (`role="group"`, `aria-label="Language"`), one button per `HELP_LANGS` entry with `aria-pressed`. A click saves the choice (try/catch) and redraws only the page's content, keeping the scroll position.
- The content element gets `lang` and, for `'ur'`, `dir="rtl"` and the class `urdu-text`. Each section is an `<h2>`, `steps` as an `<ol>`, `terms` as a `<dl>`, `text` as `<p>`s, and `keys` as a `<dl>` whose terms are `<kbd dir="ltr">` elements joined by " or " in English and "/" in the other two languages.
- `document.title` stays as the app sets it.

- [ ] **Step 3: Style it in `css/styles.css`**

The page uses the reading width of the other pages, with headings in the same scale as the statistics panels. `.help .urdu-text` uses the Nastaliq stack from line 1509 with `line-height: 2.1`. `kbd` gets the look the study screen already gives it. Below 640px it keeps a 16px gutter with no sideways scroll.

- [ ] **Step 4: Check it in the app**

Run: `RECALL_DATA=./data node server.js`, open `http://localhost:5173/#/help`.
Expected:
- signed out, the page shows in English with a Log in link, and Log in shows the login form;
- signed in, the page shows with the top bar;
- each toggle button switches the text, and the choice survives a reload;
- Urdu script reads right to left in Nastaliq, and `Ctrl+Z` reads `Ctrl+Z`;
- at 360px wide there is no sideways scroll, in light and dark;
- with `localStorage` throwing (DevTools: block site data), the page still renders and the toggle still works for that visit.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add js/app.js css/styles.css
git commit -m "Add the How it works page at #/help"
```

---

### Task 3: The ways in

**Files:**
- Modify: `js/app.js` (`accountMenu()` at line 1751; `renderAuth()` at line 4316; a new `keydown` listener beside the study one near line 4896)
- Modify: `README.md` (one line in the feature list)

**Interfaces:**
- Consumes: `isHelpKey` from Task 1; `icon('help')` and `#/help` from Task 2.

- [ ] **Step 1: Account menu**

Add `h('a', { href: '#/help' }, icon('help'), 'How it works')` to `accountMenu()`, just above Log out, for everyone, on desktop and phone.

- [ ] **Step 2: Login and sign-up screens**

In `renderAuth()`, add a second line under `.auth-switch`: a link **How it works** to `#/help`, on both modes.

- [ ] **Step 3: The `?` key**

Add a separate `document` `keydown` listener. Return when `document.querySelector('dialog[open]')`. Otherwise compute `typing = !!e.target.closest?.('input, textarea, select, [contenteditable], math-field')`, and when `isHelpKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, typing })` and `route().view !== 'help'`, call `e.preventDefault()` and set `location.hash = '#/help'`. It works signed out too.

- [ ] **Step 4: README**

In the Features list, after **Keyboard-first studying**, add: `- **How it works.** A short page on the daily routine, the four buttons, the counts, the reserve and the shortcuts, in English, Urdu or Roman Urdu. It is in the account menu, on the login screen, and on the ? key.`

- [ ] **Step 5: Check it in the app**

Expected:
- the account menu's How it works opens the page on desktop and at phone width;
- the login and sign-up screens link to it;
- `?` opens it from home, a deck page, statistics and the study screen;
- after `?` on the study screen, Back returns to the same card, and the study time did not count the time spent on the page;
- typing `?` in the card editor's text, the deck search box and the equation box types a `?`;
- `?` with the card dialog open does nothing.

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test`, expect all pass. Then:

```bash
git add js/app.js README.md
git commit -m "Open How it works from the account menu, the login screen and the ? key"
```

---

After Task 3: the owner reads the Urdu and Roman Urdu on the page and corrects anything that reads badly. Then deploy with `deploy/deploy.sh`; no server change is needed.
