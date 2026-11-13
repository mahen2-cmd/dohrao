# Kalman Filters Flashcard Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `decks/kalman-filters.apkg`, a Dohrao deck of about 70–80 understanding-first cards from the Kalman filter and EKF lectures.

**Architecture:** Throwaway Python scripts in the session scratchpad do the work and are not committed.
- A card list (`cards.py`) holds the content.
- A builder (`build.py`) writes a minimal Anki collection with the same schema as `decks/robotics-for-fajar.apkg`, plus a media map, and zips it.
- A Node checker (`check.mjs`) reads the package with the app's own `readAnkiPackage` from `anki.js` and renders every maths snippet with the bundled KaTeX.

**Tech Stack:** Python 3 (`sqlite3`, `zipfile`), ImageMagick and poppler (`pdftoppm`, `convert`) for figures, Node 22 for the checker.

**Spec:** `docs/superpowers/specs/2026-11-13-kalman-flashcards-design.md`

## Global Constraints

- **Deck name:** `Kalman Filters`.
- **IDs:**
  - deck id `1763300000001`
  - model id `1763300000002`
  - note and card ids `1763300100000 + i`, with the note id equal to its card id
  - must not overlap the prefixes 17615, 17623, 17629, 17630, 17631, 17632
- **Note type:** Basic. Fields `Front` and `Back` are joined by `\x1f`. The template is `{{Front}}` / `{{FrontSide}}<hr id=answer>{{Back}}`, copied from the Fajar deck's `col.models`.
- **Maths:** `\( … \)` inline and `\[ … \]` display. Line breaks are `<br>`. A literal `<` or `&` in text or maths is written `&lt;` / `&amp;`.
- **Source line:** every answer ends with `<br>(KF lecture: <section>)` or `<br>(EKF lecture: <section>)`.
- **Notation is the slides':**
  - Q is motion noise and R is measurement noise.
  - Bar = predicted: `\bar\mu_t`, `\bar\Sigma_t`.
  - A, B, C (linear model); g, h (nonlinear models); G, H, V (Jacobians).
  - (r, φ) for range and bearing.
- **Content:** nothing beyond the two PDFs.

## Review Focus

1. **Maths that KaTeX cannot parse** (a typo, `\operatorname` misuse) shows as raw red text on the card. The checker renders every snippet with `throwOnError: true` and fails on any error.
2. **`<` inside maths** (e.g. `0 < K < 1`) gets eaten by the importer's HTML handling. The checker fails if any field holds a bare `<` that does not start a tag the deck uses (`<br>`, `<img`, `<b>`, `</b>`, `<i>`, `</i>`).
3. **An image named on a card but missing from the media map** makes the card import without its figure. The checker asserts that every `<img src>` came back as a stored image from `readAnkiPackage`.
4. **Display equations too wide for a phone** scroll sideways. Keep any `\[ … \]` at 60 characters of LaTeX or fewer; longer ones go on two lines or inline. The checker warns over 60 characters.
5. **ID clash with an existing deck**, so the import says "nothing new". The checker scans every other `decks/*.apkg` and fails on any shared deck, note or card id.

---

### Task 1: Builder and checker, proven on three sample cards

**Files (scratchpad, not committed):**
- Create: `$S/kalman/cards.py`
- Create: `$S/kalman/build.py`
- Create: `$S/kalman/check.mjs`

Here `$S` is the session scratchpad.

**Interfaces:**
- Produces: `cards.py` defines `CARDS: list[tuple[str, str]]` (front, back, raw strings, back already ending in the source line) and `IMAGES: list[str]` (file names under `$S/kalman/img/`).
- Produces: `python3 -I build.py <out.apkg>` writes the package.
- Produces: `node check.mjs <out.apkg> <expected-count>` exits 0 with `OK <n> cards`, or non-zero with each problem listed.

- [ ] **Step 1:** Write `check.mjs` with the five Review Focus checks, plus these:
  - the package has exactly one deck, named `Kalman Filters`
  - the card count equals the expected count
  - every card has a non-empty front and back

  It imports `readAnkiPackage` from the repo's `anki.js`, passing a `saveImage` that returns a fake name. It loads `vendor/katex/katex.min.js` through `createRequire`.
- [ ] **Step 2:** Run `node check.mjs missing.apkg 3`. Expected: non-zero exit (the file is missing).
- [ ] **Step 3:** Write `build.py`.
  - It creates the tables `col`, `notes`, `cards`, `revlog` and `graves` with the Fajar deck's columns.
  - `col.decks` and `col.models` are as in the constraints; `col.dconf` is copied from the Fajar deck.
  - Each card row is `(id, nid=id, did, ord 0, mod, type 0, queue 0, due i+1, …zeros, '{}')`.
  - `media` is JSON `{"0": "<name>", …}`, and each image file is zipped under its index.
- [ ] **Step 4:** Put three sample cards in `cards.py`: one inline maths, one display maths, one image. Run the builder, then `node check.mjs` with 3. Expected: `OK 3 cards`.

### Task 2: Figures

**Files:** Create `$S/kalman/img/*.png`.

- [ ] **Step 1:** Render the source pages at 150 dpi with `pdftoppm` and crop them with `convert -crop` to these five files:
  - `kf-1d-correction.png`: KF p.13, the three curves
  - `kf-1d-prediction.png`: KF p.14, the curves
  - `ekf-nonlinear.png`: EKF p.6, the non-Gaussian result
  - `ekf-q-prediction.png`: EKF p.22, the four panels
  - `ekf-localization-sequence.png`: EKF p.26, both panels with labels
- [ ] **Step 2:** View each crop. It shows the whole figure, with no slide title and no cut-off axis labels.

### Task 3: The cards

**Files:** Modify `$S/kalman/cards.py`.

- [ ] **Step 1:** Replace the samples with the full set, in lecture order. Aim for these counts:

  | Section | Cards |
  |---|---|
  | KF lecture: Bayes filter | 4 |
  | KF lecture: Gaussians | 10 |
  | KF lecture: linear Gaussian model | 9 |
  | KF lecture: 1D updates | 9 |
  | KF lecture: KF algorithm | 8 |
  | KF lecture: summary | 5 |
  | EKF lecture: nonlinear systems | 5 |
  | EKF lecture: linearization & Jacobian | 8 |
  | EKF lecture: EKF algorithm | 6 |
  | EKF lecture: EKF localization | 10 |
  | EKF lecture: summary | 5 |

  That totals about 79. Each idea gets a "what" and, where the slide supports it, a "why". The algorithm-writing cards go a few lines per card, and each answer names what every term does.
- [ ] **Step 2:** Build and run the checker with the final count. Expected: `OK <n> cards` and no width warnings. Fix and rerun until it is clean.

### Task 4: Ship

**Files:**
- Create: `decks/kalman-filters.apkg`
- Commit: the spec, this plan and the deck

- [ ] **Step 1:** `git switch -c kalman-flashcards`. Untracked `new_cards_*.csv` files stay untracked.
- [ ] **Step 2:** Build to `decks/kalman-filters.apkg` and run the checker on it. Expected: `OK`.
- [ ] **Step 3:** Run the repo's tests with `node --test`. Expected: all pass (nothing in the app changed).
- [ ] **Step 4:** Commit only these three files, with the message "Add the Kalman Filters deck".
