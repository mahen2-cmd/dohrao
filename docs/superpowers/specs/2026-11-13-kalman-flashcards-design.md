# Kalman Filters flashcard deck: design

## Intent

The owner is revising for a robotics exam and needs to *understand* the Kalman filter and the Extended Kalman filter, not just recognise the formulas. The deck will also be given to Fajar, who already studies **Robotics for Fajar** (same course, Lec 3–18).

Source: the two lecture PDFs in `Kalman Filters/`: `10-kalman-1.pdf` (Bayes filter → Kalman filter, 27 pages) and `11-ekf-1.pdf` (Extended Kalman filter, 27 pages).

## Goals

- One new deck, **Kalman Filters**, delivered as `decks/kalman-filters.apkg`. It is imported through the admin account and then given to Fajar.
- Cards mainly ask *why* and *what it means*, for example why the correction is a weighted mean, why a nonlinear function breaks the Gaussian, or what Vₜ does in EKF localization.
- A smaller set of cards for writing the algorithms out (KF lines 2–6, EKF lines 2–6, EKF localization lines 2–13), a few lines per card. Each answer says what every term does.
- Covers everything in the two lectures, in order:
  - the Bayes filter recap
  - Gaussians and their linear-map and product properties
  - the linear Gaussian model and its matrices and noise
  - the 1D correction and prediction steps
  - the KF algorithm and the prediction–correction cycle
  - the KF summary: efficiency, optimality, limits
  - nonlinearity, Taylor linearization, the Jacobian
  - the EKF algorithm compared with the KF
  - EKF localization with landmarks: prediction, correction, the effect of Q, the odometry-vs-EKF figure
  - the EKF summary

## Non-goals and anti-goals

- No change to the app's code and no deploy. The deck goes in through the existing Anki import.
- **Robotics for Fajar** is not touched.
- No material beyond the slides (no UKF or particle filter details beyond the slide's one-line mention). Exam revision must match what was taught.
- Failure even if it "works": cards that only ask for a formula with nothing on its meaning; answers too long to review in one go; notation different from the lecture's; IDs that clash with another deck, so the import skips or merges cards.

## Approaches considered

- **A. Add the cards to Robotics for Fajar.** Fajar would get them automatically and the whole course would sit in one deck, but they would share that deck's daily limit. *Not chosen.*
- **B. A separate Kalman Filters deck.** It has its own daily limit and stats and can be studied on its own. It has to be given to Fajar on the Admin screen. **Chosen by the owner.**

## Decisions

- **Format:** the same as the existing hand-built decks (e.g. `robotics-for-fajar.apkg`, `modern-robotics-ch2.apkg`):
  - Anki Basic notes, Front/Back.
  - Maths in LaTeX as `\( … \)` (inline) and `\[ … \]` (display), which Dohrao typesets with KaTeX.
  - Line breaks are `<br>`.
  - The answer ends with a source line: `(KF lecture: <section>)` or `(EKF lecture: <section>)`.
- **Notation follows the slides:**
  - Q is the motion noise covariance and R the measurement noise covariance.
  - A bar marks a predicted quantity (μ̄, Σ̄).
  - A, B, C are the linear model; g, h are the nonlinear models; G, H, V are their Jacobians.
  - EKF localization uses (r, φ) range–bearing measurements.
- **IDs:** deck id `1763300000001`; note and card ids from `1763300100000` upward. Checked against every deck in `decks/`, which use the prefixes 17615, 17623, 17629, 17630, 17631 and 17632.
- **Figures:** a few images cropped from the PDFs where a picture carries the point:
  - the 1D prediction/measurement/correction curves
  - the linear-vs-nonlinear function figure
  - an EKF linearization plot
  - the EKF prediction-step ellipses for different Q
  - the odometry-only vs EKF-corrected localization sequence

  Stored in the `.apkg` media like `modern-robotics-ch2.apkg`.

## Left to the builder (my calls)

- **Size:** about 70–80 cards. It is enough to cover each idea from a "what" and a "why" angle without padding.
- Exact wording, which ideas get two cards, and the exact crop of each figure.
- **The build script:** a throwaway generator in the scratchpad, not committed. Only the `.apkg` and this spec go in the repo.
- **Checks before handover:**
  - the `.apkg` opens and has the expected note and card counts
  - every id is unique and outside the other decks' ranges
  - every LaTeX snippet is balanced and renders with the bundled KaTeX
  - every referenced image is in the media

## Handover

The owner imports `decks/kalman-filters.apkg` on Dohrao (admin account, Import from Anki), then uses **Give to…** on the Admin screen to give it to Fajar.
