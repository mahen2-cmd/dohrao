# Thumb-first phone layout: design

## Intent

The owner finds Dohrao clunky on a phone next to the web version. Most of the people now using it (friends and family) study on phones, in short bursts, often one-handed and in the evening. The daily review is meant to be frictionless (Product Principles 1 and 5), and on a phone it is not.

Seen at 390px wide today (screenshots taken 2026-11-13):

- **Home:** "Decks", "Import from Anki" and "New deck" crowd one line; each deck block carries a Study button and a counts row that compete; the top bar spends space on the brand.
- **Deck page:** around ten stacked controls before the first card: ⋯, Add card, Study, Sort into topics, the reserve pull-in row, search, five filter chips over two lines, Filter and sort, Select all.
- **Study:** the top bar holds counts plus Edit and **Delete** where the thumb lands; Show answer is a small centred button; nothing reacts to a tap on the card or a swipe.
- **Statistics:** the activity calendar runs off the screen and the four figures are cramped.

The owner picked direction **A, "Thumb first"**, from 20 mockups (4 directions × 5 screens), plus **swipe to rate** from direction C and the **select-mode toolbar** from direction D. Mockups: https://claude.ai/artifact/9wGnnF38E95wPrtSbKSrao (row A, and C4 and D2 for the two extras).

## Goals

On a phone (`max-width: 640px`), in both themes:

1. Everything you press often sits in the bottom third of the screen.
2. The deck page shows cards without scrolling past a wall of controls.
3. Studying needs no precise taps: tap the card to reveal, swipe to rate, or use large buttons.
4. Destructive actions (Delete card, Delete deck) are never one stray tap away.

## Non-goals

- **The desktop layout does not change.** Above 640px every screen looks and works as it does now. Keyboard shortcuts are unchanged everywhere.
- No redesign of the card editor, dialogs, Upcoming, sign-in, sign-up or admin. They only pick up the shared pieces below (menus as sheets, the tab bar).
- No new scheduling behaviour. Swipe is another way to press the same four buttons.
- No new visual identity: same tokens, fonts and the interval ruler (DESIGN.md, "Night minimal").

## Anti-goals

- Phone and desktop drifting into two codebases.
- A swipe that rates a card the person did not mean to rate, or blocks scrolling a long answer.
- Hiding a feature on the phone that exists on desktop. Things may move, but everything stays reachable.

## Approaches considered

1. **Same screens, phone layout in CSS, a few phone-only elements. Chosen.** Each screen keeps one render function. The phone layout lives in the `max-width: 640px` CSS. Where A needs structure the desktop lacks, it is added once and hidden on wide screens with the existing `phone-only` / `wide-only` pattern (already used for Export backup in `accountMenu()` and the reserve's `reserve-wide` / `reserve-narrow`). Swipe is a touch-only handler on the study card.
2. **Separate phone render functions** chosen by `matchMedia`. Simpler per screen, but every future feature goes in twice, and a resize or rotation must re-render. Rejected: this is how the phone drifts and gets clunky again.
3. **CSS only.** Cannot add tabs or swipe. Rejected.

## The design, screen by screen (phone only)

### Shared

- **Tab bar and top bar, by screen (my call, following the mockups):**
  - **Home, Upcoming and Statistics** keep the bottom tab bar (Decks, Upcoming, Statistics) with the safe-area inset. Their top bar shrinks to a slim line: the greeting or page title on the left, theme and account on the right. The brand is not shown on a phone.
  - **Deck and Study** have neither bar on a phone. They are drill-down screens: back (or ×) on the left, ⋯ on the right, and their own docked bar at the bottom. That leaves the room for cards. Theme and account stay one tap away on Home.
- **Knowing the width in JavaScript (my call):** a single helper, `isPhone()`, wraps `matchMedia('(max-width: 640px)')`, and a change listener calls `render()` when the breakpoint is crossed. Render functions use it only where the content itself differs by width: which cards the deck list shows, and the 16 weeks of activity. Everything else stays in CSS. This is still one render function per screen.
- **Menus as sheets:** every `details.menu` (built by `menu()`) and the account menu open as a bottom sheet on a phone. The sheet is full width and pinned to the bottom, with rows at least 48px tall, a dimmed backdrop, and closing on a backdrop tap or Escape. Desktop keeps its dropdown. One CSS treatment plus the backdrop, not a new component per menu.
- **Touch targets** are at least 44px everywhere on the phone.

### Home (`renderHome`)

- The time-of-day line sits at the top left and the serif headline stays ("117 cards, then you're done.", about 40px).
- The three figures become one muted line under the headline: `0 reviewed today · 0-day streak · 62 tomorrow`. On a phone this replaces the ruled three-column strip.
- **Decks heading** has a **+** icon button on the right. It opens a sheet with "New deck" and "Import from Anki". The two wide buttons are hidden on a phone.
- **Each deck** is one ruled row, not a box:
  - the name, ellipsised to one line;
  - a meta line, `6,551 cards · 53 tomorrow`;
  - on the right, today's due total with a state dot, or "Done" when nothing is due, and a chevron.
  - The whole row opens the deck. The per-deck Study button and New/Learning/Due row are hidden on a phone.
- **Docked start:** "Start review · 117" is a full-width primary button fixed just above the tab bar, with the "Portuguese A1 first, then 3 more decks" line under it. It is shown only when something is due, and the list scrolls beneath it.

### Deck page (`renderDeck`)

- **Header:** a back chevron on the left and the deck's ⋯ on the right, then the deck name and the coloured New / Learning / Due counts. Under them, "53 tomorrow · See the days ahead".
- **Tabs (phone only): Cards · Reserve · Topics.** A segmented control under the header, showing one section at a time.
  - **Cards:** search, a filter-and-sort button, one sideways-scrolling row of state chips, then the list.
    - The search and filter-and-sort button sit on one line. Filter and sort opens what `sortBar(deck)` holds today.
    - The state chips are the existing `CARD_GROUPS` chips.
    - The list holds every card not on reserve. The "On reserve" chip is not shown in this tab.
  - **Reserve:** the reserve bar (`reserveBar`: count, how many, Pull in, and its ⋯ for Pull all, Choose cards and Import to reserve), then the reserve list in pull-in order, where drag and Up/Down reordering keep working. The tab label carries the count ("Reserve 6,058").
  - **Topics:** shown only when the deck has topics or is editable.
    - Three actions: "Choose what to study" (`openTopicPicker`), "Manage topics…" (`openTopicsDialog`), and "Sort this deck into topics" where offered today.
    - Under them, the deck's topics with their card counts, as plain rows. Tapping a row filters the Cards tab to that topic.
  - The chosen tab is kept in module state per deck and resets to Cards when you open another deck.
  - **How the tab picks the list (my call):** on a phone, the tab is applied on top of `filters` when the list is built. Cards leaves out reserved cards, and Reserve shows only reserved cards in pull-in order. The tab never writes into `filters`, so rotating to a wide screen shows the desktop list exactly as the person left it there.
  - **Topic rows** in the Topics tab only filter the Cards list (`filters.topics`) and switch to the Cards tab. They never change what gets studied.
  - **Desktop:** the tabs are hidden and the page shows everything as now.
- **What Study will study (my call):** when the deck has topics, the docked bar shows a small line above "Study 100", such as "Studying: All topics ›". It is today's `topic-pick` button, restyled, and it opens `openTopicPicker`. The Study count and the chosen topics stay visibly linked, as they are in today's header.
- **Docked bar:** a square **+** (Add card, only when the deck is editable) and a full-width "Study 100" primary button, fixed at the bottom. It is hidden while cards are selected (see below). Add card and Study are hidden from the header on a phone.
- **⋯ menu** gains nothing new; it already holds Upcoming, Statistics, Import from Excel, Topics…, Deck settings and Delete deck.

### Select mode (from direction D)

- Ticking a card (its checkbox, which stays at least 44px) switches the page into select mode. A long-press on a row also ticks it.
- In select mode, the docked Study bar is replaced by a **bottom toolbar**: icon over label, one item each. It offers what the inline bulk row offers today:
  - Pull in, on the Reserve tab, or when ticked cards are on reserve;
  - To reserve, for cards not on reserve;
  - Move to topic…;
  - Add reversed copies;
  - Delete, styled danger. It keeps today's confirmation.
- A slim line above the list reads "2 selected · Select all · Cancel".
- Reorder (Up / Down / To top / To bottom) appears in the toolbar on the Reserve tab, folded under a "Move" item that opens a sheet. **This is how you reorder the reserve on a phone (my call).** The existing HTML drag doesn't fire from touch on most phones, and no touch drag is added. Desktop drag keeps working as now. Long-press ticks a row and does not start a drag.
- On desktop the existing inline bulk row stays as it is.

### Study (`renderStudy`)

- **Top bar:** close (×) on the left. In the middle, the deck name (with the topic label when filtered) and "1 of 117", over the progress bar (segmented when 24 or fewer, as now). On the right, a ⋯ that opens a sheet with Edit card, Delete card (danger, confirms first) and Replay audio. The counts pills and the Edit and Delete icons are hidden on a phone.
- **Question side:** the card fills the middle. **Tapping anywhere on the card area reveals**, except on the speak button, links and anything interactive inside the card. "Show answer" is a full-width 56px primary button at the bottom, with "Tap anywhere to show the answer" in muted text above it the first few times. A localStorage counter hides the hint after 5 reveals.
- **Answer side:** the question is set smaller and muted, with the answer large (link colour, as now). The interval ruler sits just above the buttons. The four rating buttons are **one row**, each 72px tall, with Good about 1.35 times wider and showing the interval under each label. This replaces today's two-by-two grid.
- **Swipe to rate (from direction C)**, on touch input only (`pointerType === 'touch'`), once the answer is shown:
  - right = Good, left = Again, up = Easy, down = Hard;
  - the card follows the finger and tilts slightly. Past the threshold, a label stamped on the card shows the rating and its interval ("GOOD · 10d"), and the matching ruler mark is highlighted;
  - releasing past the threshold rates the card. Releasing short of it springs back and nothing happens;
  - the threshold is about 30% of the card's width horizontally and 22% of its height vertically. The dominant axis wins: whichever axis moved more decides the direction, and a mostly horizontal drag never turns into a vertical rating;
  - **What scrolls (my call):** on a phone, the study screen is a fixed top bar, a card area that scrolls on its own, and a fixed answer bar. The rating buttons are always in reach, however long the answer is;
  - **vertical swipes are ignored when the card area scrolls** (it overflows), so scrolling keeps working;
  - **a drag that starts inside something that scrolls sideways** never rates, whatever its direction. That covers a wide equation (`.katex-display`) or a wide image. The element scrolls as it does today. Horizontal swipes elsewhere on the card still rate;
  - with `prefers-reduced-motion`, the card doesn't move or tilt; the stamp still shows past the threshold and the rating happens on release;
  - before reveal, a swipe does nothing (a tap reveals).
  - The buttons stay; swipe is extra.
- The empty states (all caught up, deck empty, topic done) keep their content, with buttons full width at the bottom.

### Statistics (`renderStats`)

- The title sits on the left, with the existing deck select styled as a pill on the right.
- The four figures become a **2×2 grid** of small tiles.
- **Activity** shows only the **last 16 weeks** on a phone, fitting the width with no sideways scroll, and the line under the heading says so. Desktop keeps the full year.
- Forecast, Cards and Answer buttons stack full width as now, keeping their existing range controls.

## Constraints

- Plain HTML, CSS and JavaScript, no build step and no new dependencies (PRODUCT.md).
- Both themes are first-class: every new element uses the existing tokens, and each phone screen is checked in light and dark.
- `prefers-reduced-motion` is respected (see swipe).
- Read-only decks (given by the admin) hide Add, Edit, Delete, Topic and Reserve edits exactly as they do today.
- The phone breakpoint is the existing `max-width: 640px`. The existing 760px tweaks for the home page are folded in or left as they are, as long as 641–760px still looks right.

## Left to the builder

- Exact spacing, sizes and colours within the tokens, matched to the mockups.
- How the tabs and the select toolbar are wired into `renderDeck`'s existing state (`filters`, `selected`, `query`).
- The sheet's markup, as long as the same `menu()` call works on both widths.
- Swipe implementation details (pointer capture, spring-back animation, thresholds within the ranges above).
- Long-press timing (about 450ms) and cancelling it when the finger moves.

## How it will be checked

- `npm test` still passes; no server or store code changes are expected.
- Playwright screenshots at 390×844 (phone) and 1280×800 (desktop), light and dark, of Home, Deck (each tab, and select mode), Study (both sides, and mid-swipe), and Statistics.
- The desktop shots are compared with shots taken from `main` before the change and must match.
- Touch emulation in Playwright for tap-to-reveal and the four swipe directions, including a long answer that scrolls.
