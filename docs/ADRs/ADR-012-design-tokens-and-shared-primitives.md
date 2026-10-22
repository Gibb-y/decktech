# ADR-012: Design tokens and shared primitives, no UI library

**Status:** Accepted

## Context

Every screen and dialog carried its own colours, spacing and button styles (the same `#0b3d91` / `#c3c6cc` literals copied across component files and `tools-dialog.css`), so the app looked unfinished, had no dark mode and gave no hierarchy between actions. The editor needs a compact, calm look with one accent, and it must keep WCAG AA, `forced-colors` and `prefers-reduced-motion` working. The app has few runtime dependencies on purpose (bundle budget, offline use, security review), and the initial bundle may grow by less than 15 kB gzip for this work.

## Decision

- One set of **CSS custom properties** (colour roles, type, spacing, radii, elevation, motion) in `src/styles.css`, with a light and a dark set chosen by `prefers-color-scheme` or a stored manual choice (`data-theme` on `<html>`).
- A small set of **shared primitives** in `shared/` (CSS classes plus thin standalone components or directives; one inline-SVG icon set) that screens use instead of their own styles. They live in `shared/` so that `editor`, `library`, `presenter` and `components` can all use them without importing each other (4.4).
- **No UI component library** (Angular Material, PrimeNG and similar), no icon font, no network.
- Chrome tokens and deck `Theme` tokens are separate namespaces; neither reads the other.
- Enforcement by script rather than by convention: `npm run lint:tokens` fails on new colour literals outside `styles.css` and the deck / slide code, and on a token pair below AA. Legacy literals are listed in a baseline that can only shrink.
- The work is delivered in slices (tokens and base layer, primitives, then screen by screen), so each review stays readable.

## Consequences

- (+) One place to change the look; dark mode and high contrast are properties of the tokens, not of each screen.
- (+) No dependency to update or audit and almost no bundle growth (CSS custom properties and a few classes).
- (+) The contrast of the whole palette is checked by a test, not by eye.
- (-) We write and maintain the primitives (focus handling in menus, tabs and dialogs) ourselves; they need their own accessibility tests.
- (-) The dark set must be written twice in plain CSS; the check keeps the copies equal.
- (-) Until the last screen is migrated the app is light only by default, and the baseline lists the debt.
