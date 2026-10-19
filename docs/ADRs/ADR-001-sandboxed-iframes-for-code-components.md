# ADR-001: Run code components in sandboxed iframes

**Status:** Accepted

## Context

Slides must support full HTML, JS and CSS, and decks are shareable, so the code may be untrusted.

## Decision

Each code component runs in an `<iframe sandbox="allow-scripts" srcdoc>` with an opaque origin, communicating with the host over a `MessageChannel`.

## Alternatives considered

- Inline in the host DOM with Shadow DOM: no JS isolation, rejected.
- Web Worker only: no DOM, so no HTML/CSS, rejected.
- Separate origin hosted by us: stronger isolation but requires a server and breaks offline use; deferred as possible hardening.
- Realms/SES: not DOM-capable and immature.

## Consequences

- (+) Strong isolation.
- (+) Authors get a normal web page environment.
- (-) One browsing context per component: memory and start-up cost, mitigated by lazy creation and the `Preloader`.
- (-) No shared DOM or CSS with the slide, so theming goes through injected CSS variables.
- (-) Pointer events inside frames need the editor overlay (see [building block view](../arc42/05-building-block-view.md#54-level-2-editor)).
