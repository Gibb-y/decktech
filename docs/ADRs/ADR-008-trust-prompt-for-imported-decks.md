# ADR-008: Trust prompt with code inspection for imported decks

**Status:** Accepted

## Context

Imported decks may contain arbitrary JavaScript in code components. The target audience is developers, who can judge code themselves. A bare "trust this deck?" dialog asks them to decide blind, so the prompt must let them read what they are about to run.

## Decision

Imported decks open with code disabled until the user decides. The decision is made in a **trust dialog** that includes a **code inspector**. Trust is bound to the deck's content hash.

### Trust dialog

- Lists every code component with: name, slides it appears on, requested permissions (e.g. `network` with its origin allow-list), vendored libraries and asset files, and size.
- Flags things worth a closer look: requested permissions, use of `eval`/`new Function`, dynamic `import()`, references to external URLs, and minified or very long single-line files.
- Offers per-component choices (*Run* / *Keep disabled*) as well as *Trust whole deck*, *Open with all code disabled* and *Cancel*. Disabled components appear as placeholders.

### Code inspector

- Opens from each component in the dialog: a **read-only** CodeMirror view (the same lazily loaded editor as in ADR-005) with tabs for HTML, CSS, JS, the property schema, and each vendored library or text asset.
- **Never executes anything.** The inspector shows source as text only: no live preview, no frame is created for an untrusted component. Rendering is by CodeMirror text nodes, not `innerHTML`.
- Search, line numbers and syntax highlighting. Long or minified lines are soft-wrapped, with a "Format" action (pretty-print copy, view only) to make minified libraries readable.
- Vendored libraries show name, size and SHA-256. If the hash matches a known library release bundled with the app or a previously trusted deck, it is marked as *known*, which lets the reader skip large unmodified libraries.
- When a deck has been trusted before and its content hash changed, the inspector opens a **diff view** against the last trusted version, per component, so only the changes need reviewing.
- A trusted deck stays inspectable at any time from the component's "Edit code" action, which is the same viewer in editable form.

## Alternatives considered

- Plain yes/no prompt: fast but uninformed; not appropriate for developers.
- Static analysis/automatic verdicts ("safe"/"unsafe"): unreliable for JavaScript and gives false assurance. We only surface flags and leave the decision to the user.
- Running the component in a preview inside the dialog: executes untrusted code before consent, rejected.

## Consequences

- (+) Informed consent: developers can read and verify code before it runs.
- (+) Diff view makes re-trusting after a change cheap.
- (+) Reuses the CodeMirror dependency; no new library.
- (-) More UI to build and maintain (dialog, read-only viewer, diff, flagging heuristics).
- (-) Reading large or minified libraries remains tedious; the *known library* hash check and per-component choices mitigate this.
- (-) Heuristic flags can be bypassed by obfuscated code, so they are hints and not a security boundary. The sandbox (ADR-001) remains the actual defence.
