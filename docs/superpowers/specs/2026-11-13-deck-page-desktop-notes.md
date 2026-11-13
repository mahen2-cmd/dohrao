# Desktop deck page redesign — brainstorm in progress

Status: **brainstorming, not yet a design.** Nothing built. Paused 2026-11-13 at the question below.

## What we're doing

The desktop deck page (what you see after opening a deck; `renderDeck` in `js/app.js`) feels cluttered. Today it stacks, top to bottom: the header (name, from, New/Learning/Due counts, "N tomorrow · See the days ahead", then ⋯ menu, Add card, topic picker and Study N), the "Sort into topics" line (`sortBar`), the reserve bar (`reserveBar`: icon, two lines of explanation, topic select, number, Pull in, Pull all, Choose cards, Import to reserve), search and count, the group chips and "Filter and sort" with its dropdown row, the select-all/reorder bar, then the card rows. That's roughly 20 controls before the first card. The phone already splits this into Cards / Reserve / Topics tabs with a docked Study button.

## What the user said

- The main job on this page is **pulling cards in from the reserve**.
- We built 20 mockups (`.superpowers/brainstorm/8410-1794596933/content/deck-page-20.html`, not in git). The user picked **#2: reserve and studying side by side**: the reserve queue on the left (count, next in line, amount + Pull in), the cards being studied on the right (search, list).

## Proposed fit of today's controls into #2 (Claude's proposal, not yet confirmed)

- **Header:** name, due count, Add card, ⋯ and Study. Upcoming, Statistics, Import, Topics, Settings, Delete and the "Sort into topics" line move into ⋯.
- **Left column, the reserve:** the queue in pull-in order, with the amount, topic and Pull in at its foot. Pull all and Import to reserve go in a small ⋯ inside the column.
- **Right column, studying:** search plus one Filter button. The group chips go behind Filter, and the bulk actions appear only once a card is ticked.
- **Narrow windows:** below about 900px wide, fall back to the phone's Cards / Reserve tabs.

## Open question (resume here)

How much does the left column do?

- **A. The whole reserve, workable in place.** All reserve cards scroll in the column, can be dragged to reorder, and can be ticked and pulled in. This replaces the "Choose cards" mode. Claude recommends A.
- **B. A short preview.** The next 5–8 cards plus Pull in, and "Open queue" switches to the full reserve for reordering or picking.

## Still to cover after that

The topics view on desktop, an empty reserve, a deck given by someone else (read-only), what the right column's Filter holds, then the approaches, the design doc, the user's approval, and finally the writing-plans skill.
