# ADR-013: MCP server as a standalone Node process on `.deck` files

**Status:** Accepted

## Context

Agents can write code but have no structured way to produce a valid deck; hand-editing the ZIP and JSON of ADR-007 is error prone. The server must give them tools that validate input and return clear errors, share the rules of the editor (ADR-003) and not weaken the trust model for code (ADR-001, ADR-008).

## Decision

- The server is a separate program in `mcp/` (not part of the Angular app, not under `src/app`), started over stdio by the MCP client: `npm run build:mcp` bundles it with esbuild to `dist-mcp/decktech-mcp.mjs`.
- It works on files, not on the running app. A deck is created or opened (`open_deck` reads a `.deck` file with `readArchive`) into an in-memory session and written with `export_deck` (`writeArchive`). It imports the pure parts of the app by relative path: `core/model`, the command classes of `core/store` (never `DeckStore`, `History` or anything Angular), `core/persistence/assets`, `library/archive/{reader,writer,format,sniff}` and `components/trust/analysis`. So the same commands, validation, limits and file format apply as in the UI.
- Every tool that changes a deck runs one command (or a `Batch`) and then `validateDeck` on the result; the session commits only afterwards, so a refusal changes nothing. A session keeps up to 200 earlier documents for `undo`/`redo` (the document is immutable and structurally shared).
- Inputs are `zod` schemas; every refusal is a tool error with a sentence the agent can act on. Nothing is corrected silently (a colour that is not a token or a CSS colour is refused, not replaced).
- **Trust.** Code written by an agent is untrusted. By default the server never executes it: `validate_component` parses the script as an ES module (acorn) and runs `validateComponent` and the trust dialog's heuristic flags, and reports `executed: false`. The server never writes a trust record. An exported deck with component definitions reads back with `hasCode`, so DeckTech's import marks it pending and shows the trust dialog before any code runs (ADR-008). Opened files get the same note.
- **Previews (opt-in).** `render_preview` and `validate_component` with `run: true` are the one exception, and only when the person who configures the server sets `DECKTECH_PREVIEW=1`. They draw a slide with the real app: the server serves the built app (`DECKTECH_APP_DIR`, default `dist/decktech/browser`) on `127.0.0.1`, opens its route `preview` in a headless Chromium (Playwright, loaded only on first use) and hands the deck over through `window.decktechPreview.show` (`src/app/preview-page.ts`). The page uses the ordinary `SlideRenderer`, so a picture shows what DeckTech shows and the component code runs in the same sandboxed frames (ADR-001, ADR-011). Containment: a new browser context per picture (no stored data, no service worker, nothing shared between pictures), every request outside the local app server is refused, one picture at a time, 45 s limit. The page registers no trust record for the deck id, so its code runs as that of a deck made here; this is why the switch is the server owner's and the tool says so when it is off. Errors and console output of the components come from the app's `ErrorService` and `HostConsole`.
- **File access** is confined to one workspace folder (`DECKTECH_WORKSPACE`, default the working directory): paths are resolved with symbolic links followed and must stay inside; an export never overwrites unless asked. The folder and the library location are set in the client's configuration, never by the agent.
- **Component library** is a folder of `<id>.json` files (`LibraryComponent` records, default `<workspace>/.decktech/library`). The browser's library lives in IndexedDB and cannot be reached from Node; the two are separate stores. Entries with asset files or vendored libraries are refused, since their bytes would not travel.
- Two commands were added to core for this: `AddComponent` (a definition without an element) and `SetDeckTitle`.

## Not built (follow-up)

Sections, slide backgrounds and layout editing, and merging a deck file into an open deck.

## Added later

The renderer drew neither tables nor videos when the server was written, so a tool would have created invisible elements. Since DT-20 it draws both, and the server has `add_table`, `edit_table` (the table commands of `table-commands.ts`, a list of operations as one undo step), `add_video` (MP4 or WebM and an optional poster, read from the workspace folder with the same checks as images; `label` is required and autoplay needs `muted`), `set_reading_order` (the whole order of a slide at once, as `ReorderElements` steps in one undo step) and `import_deck`, which is `open_deck` under a second name. `check_accessibility` also reports videos without a label and tables without a header row.

## Alternatives considered

- Driving the running app over a socket: shares the live UI state and undo, but needs the app open and a bridge that must itself be secured.
- Writing the ZIP and JSON directly in the agent's tools: duplicates the validation and drifts from the editor.
- Running the component code in Node (vm) to validate it: not isolation, rejected.

## Consequences

- (+) Headless, scriptable, one set of rules for UI and agents; the app is untouched apart from two commands.
- (+) The trust boundary stays where it is: at import, with a human decision.
- (-) A preview executes agent code (in the sandbox, offline, in a throwaway profile): the residual risk of a sandbox escape (R1) now also applies to the machine running the server, which is why it is opt-in.
- (-) Previews need the built app, `playwright` and a Chromium next to the server; without them the tools explain what is missing.
- (-) New dependencies (dev): `@modelcontextprotocol/server`, `zod`, `acorn`, `@types/node`, `playwright` (external to the bundle).
- (-) The server imports app source by relative path, so a core change that pulls in Angular would break its build (`mcp/bundle.spec.ts` bundles the server and fails if Angular or another unexpected app file gets in).
