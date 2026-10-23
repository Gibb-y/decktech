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
- **Component library** is a folder of `<id>.json` files (`LibraryComponent` records, default `<workspace>/.decktech/library`). The browser's library lives in IndexedDB and cannot be reached from Node; the two are separate stores. The bytes of the assets an entry reads (`files`, `libs`) are kept next to it in `assets/<sha256>`, shared by all entries and checked against their hash when read (a changed or missing file makes `import_from_library` refuse the entry and add nothing), so a component with vendored libraries travels whole (DT-53). The entry file also records the names the server gave the libraries (`names`, checked on import), so an imported component can be edited by library name.
- Two commands were added to core for this: `AddComponent` (a definition without an element) and `SetDeckTitle`.

## Vendored libraries (DT-53)

An agent can give a code component a library without touching the `.deck` file.

- `add_library_from_package` downloads `https://esm.sh/<name>@<version>[/<subpath>]?bundle` with the editor's `fetchLibrary` (the same name and version checks, 5 MiB limit, JavaScript check, stub following); `add_library_from_file` reads a `.js` / `.mjs` from the workspace folder with the same checks. Both store the module as a `text/javascript` asset of the deck (one undo step, counted against the 256 MiB deck budget) and return the asset id and the name to import it by. The download is made by the server (`cdnFetcher`: the CDN host only, redirects to another host refused, 30 s, body read up to the limit), never by the sandbox, whose `connect-src 'none'` is unchanged. Libraries stay untrusted code: they are listed by the trust dialog of whoever opens the exported deck, and the server never runs them outside previews.
- `libs` on `create_component`, `update_component` and `validate_component` take names (`react`, `react@19.3.1`) or asset ids.
- **Specifier.** The runtime's import map is keyed by the asset id, and that stays. The name is a convenience of the server: on save it replaces the string of an import that names an attached library by its asset id (found with acorn, so strings and comments are untouched). The stored script therefore holds ids, the deck format and the runtime did not change, and nothing is needed to resolve a name when the deck is opened elsewhere. The names live in the session (`DeckSession.libraries`); in a reopened deck only ids can be used. Two libraries with the same name (two versions) need the version or the id.
- **Libraries that build on libraries.** A bundle that imports another package from a CDN path (`/react@19.3.1/es2022/react.mjs`) is pointed at the vendored library of that package (`resolvePeers`, in `vendor.ts` so the editor benefits too), if one is in the deck; the order is therefore `react`, then `react-dom/client`. Without it the library is refused and the message says to add the other one first. This keeps one instance of React; two copies break hooks.
- **Checks.** Static: a script that imports something the sandbox cannot resolve (a library not in `libs`, an asset id that is not attached, a URL, a relative path) gets a warning from `create_component`, `update_component`, `validate_component` and `import_from_library`. With previews, `render_preview` adds `libraryProblems` per code element, because a failed import only reaches the frame as "the component script could not be loaded".
- A library that imports another vendored library (react-dom on react) needs both in `libs`; attaching only one gets a warning, since the import map would not resolve the other.
- No JSX: there is no build step, so React is used with `createElement`.

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
