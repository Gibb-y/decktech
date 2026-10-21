# ADR-011: Inject the code element view into the renderer; bootstrap frames over the port

**Status:** Accepted

## Context

Code elements must be drawn by the one `SlideRenderer` (editor, presenter), but the component host depends on the renderer (`components` -> `renderer`, 4.4), so the renderer cannot import it. The frame also has an opaque origin and a strict CSP: it cannot load scripts or libraries from the host, and blob URLs made by the host are not reliably usable inside it.

## Decision

- The renderer defines the token `CODE_ELEMENT_VIEW`, a loader of the view component; the app provides it with `import()` (`provideCodeComponents()`), so the host is a lazy chunk. The deck's `components` and id are inputs of `SlideRenderer`.
- A frame starts with a static document (CSP, theme variables, user CSS and HTML, the inlined `deck-runtime.js`) and everything else follows the handshake: `ready` from the frame, a transferred `MessagePort`, then `init` over it. The user's JavaScript is carried in the document as inert JSON and is run by the runtime as a module through a blob URL created inside the frame, after an import map for the vendored libraries (their bytes arrive in `init`).
- Frames are created imperatively by one function (`createSandboxFrame`), which is also the only place a sandbox attribute is written.

## Alternatives considered

- Renderer imports the host: breaks the dependency rule and puts the sandbox code in the initial bundle.
- User JS as an inline module in the markup: needs escaping, cannot see an import map built from libraries that only exist as bytes, and a source containing a closing script tag would change the document.
- Library and asset blob URLs created by the host: not dependable in a frame with an opaque origin.
- Binding `sandbox` and `srcdoc` in an Angular template: Angular refuses the first and sanitises the second.

## Consequences

- (+) The renderer stays free of the sandbox; nothing is loaded for decks without code.
- (+) One place defines the sandbox flags, so a lint rule can guard them.
- (-) The user module only runs after the handshake (a few milliseconds, one round trip), and `deck.ready` inside it fires at once.
- (-) Every consumer of `SlideRenderer` that wants live code (the presenter, later) must pass `components` and `deckId`.
