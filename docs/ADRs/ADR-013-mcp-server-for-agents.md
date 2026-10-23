# ADR-013: MCP server as a standalone Node process on `.deck` files

**Status:** Accepted

## Context

Agents can write code but have no structured way to produce a valid deck; hand-editing the ZIP and JSON of ADR-007 is error prone. The server must give them tools that validate input and return clear errors, share the rules of the editor (ADR-003) and not weaken the trust model for code (ADR-001, ADR-008).

## Decision

- The server is a separate program in `mcp/` (not part of the Angular app, not under `src/app`), started over stdio by the MCP client: `npm run build:mcp` bundles it with esbuild to `dist-mcp/decktech-mcp.mjs`.
- It works on files, not on the running app. A deck is created or opened (`open_deck` reads a `.deck` file with `readArchive`) into an in-memory session and written with `export_deck` (`writeArchive`). It imports the pure parts of the app by relative path: `core/model`, the command classes of `core/store` (never `DeckStore`, `History` or anything Angular), `core/persistence/assets`, `library/archive/{reader,writer,format,sniff}` and `components/trust/analysis`. So the same commands, validation, limits and file format apply as in the UI.
- Every tool that changes a deck runs one command (or a `Batch`) and then `validateDeck` on the result; the session commits only afterwards, so a refusal changes nothing. A session keeps up to 200 earlier documents for `undo`/`redo` (the document is immutable and structurally shared).
- Inputs are `zod` schemas; every refusal is a tool error with a sentence the agent can act on. Nothing is corrected silently (a colour that is not a token or a CSS colour is refused, not replaced).
- **Trust.** Code written by an agent is untrusted. The server never executes it: `validate_component` parses the script as an ES module (acorn) and runs `validateComponent` and the trust dialog's heuristic flags, and reports `executed: false`. The server never writes a trust record. An exported deck with component definitions reads back with `hasCode`, so DeckTech's import marks it pending and shows the trust dialog before any code runs (ADR-008). Opened files get the same note.
- **File access** is confined to one workspace folder (`DECKTECH_WORKSPACE`, default the working directory): paths are resolved with symbolic links followed and must stay inside; an export never overwrites unless asked. The folder and the library location are set in the client's configuration, never by the agent.
- **Component library** is a folder of `<id>.json` files (`LibraryComponent` records, default `<workspace>/.decktech/library`). The browser's library lives in IndexedDB and cannot be reached from Node; the two are separate stores. Entries with asset files or vendored libraries are refused, since their bytes would not travel.
- Two commands were added to core for this: `AddComponent` (a definition without an element) and `SetDeckTitle`.

## Not built (follow-up)

`render_preview` and a `validate_component` that runs the code need a browser (for example Playwright driving the sandboxed frame of ADR-011) and are not part of this step; so are `set_reading_order` (the element order is the reading order, `set_z_order` moves elements), tables, video and line elements, and `import_deck` as a second name of `open_deck`.

## Alternatives considered

- Driving the running app over a socket: shares the live UI state and undo, but needs the app open and a bridge that must itself be secured.
- Writing the ZIP and JSON directly in the agent's tools: duplicates the validation and drifts from the editor.
- Running the component code in Node (vm) to validate it: not isolation, rejected.

## Consequences

- (+) Headless, scriptable, one set of rules for UI and agents; the app is untouched apart from two commands.
- (+) The trust boundary stays where it is: at import, with a human decision.
- (-) No visual feedback loop yet; an agent cannot see its slides.
- (-) New dependencies (dev): `@modelcontextprotocol/server`, `zod`, `acorn`, `@types/node`.
- (-) The server imports app source by relative path, so a core change that pulls in Angular would break its build (`mcp/bundle.spec.ts` bundles the server and fails if Angular or another unexpected app file gets in).
