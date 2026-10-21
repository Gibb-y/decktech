# 8. Cross-cutting Concepts

## 8.1 Domain model and document lifecycle

The deck document (section 5.2) is the single source of truth. It is immutable from the outside: the store replaces it with a new value on each command, and unchanged slides and elements keep their object identity, so signals and `computed` selectors only recompute what changed.

Document versions are tracked by `schemaVersion`. Every load or import runs the migration chain; unknown *newer* versions are reported as read-only with a reason (no editable deck is produced).

### Migrations

`migrate(raw)` (`src/app/core/migrations/`) is the entry point in front of `validateDeck`. It never throws: anything unexpected (e.g. a stack overflow on absurdly nested input) becomes an `unexpected` error.

- **Chain:** `MIGRATIONS` maps a version to the pure step that upgrades it to the next one. The runner applies the steps in order and stamps `schemaVersion` itself after each, so a step only transforms content. Bumping `SCHEMA_VERSION` requires adding the step from the previous version (a spec checks the registry is contiguous) and a frozen fixture for the new version (`fixtures.ts`). v0 → v1 is synthetic: no released app wrote v0; it exists to exercise the chain.
- **Atomicity:** an older document is deep-cloned once and the steps run on the clone, so a throwing or in-place-mutating step cannot change the caller's data. A step that throws, returns a non-object, or leaves a gap in the chain gives an error result (`migration-failed`, `no-path`), carrying the starting `fromVersion` and the failing `step`; a migrated deck that does not validate gives `invalid-deck` with the validation paths. A document already at the current version is validated as is, without a copy.
- **Newer versions:** the outcome is `{ readOnly: true, reason, fromVersion, supportedVersion }`. It deliberately carries no deck: the strict validator rejects unknown fields, so a newer document rarely validates, and handing out a `Deck` with a future `schemaVersion` would make read-only a convention. The caller keeps the stored original untouched, shows the `reason`, and must not save over it. A read-only viewer would need its own tolerant reader. A missing, fractional, negative or non-numeric `schemaVersion` is an `invalid-version` error.
- **Backup:** `migrateStored(raw, sink)` is for decks loaded from storage. Only when an upgrade actually happened (and succeeded) it awaits `sink.backup({ raw, fromVersion, toVersion })` with a copy of the untouched original (so an asynchronous sink never sees later changes), and only then returns the migrated deck. If the backup fails the result is a `backup-failed` error, so the caller keeps the stored original and never overwrites it with an un-backed-up migration. Failed migrations and read-only decks need no backup, because nothing is overwritten. The sink is implemented by the repositories (8.5): a rolling store that always keeps the oldest copy.

### Validation

`validateDeck(unknown)` is the single entry point for untrusted documents (import, storage). It returns `Result<Deck, ValidationError[]>`; every error carries a path (e.g. `slides[2].elements[0].w`) and all problems are collected rather than stopping at the first. It enforces:

- **Types and enums:** every field has the expected type; element, fill, transition, permission and prop types are closed sets, so unknown element types are rejected. `Slide.section`, when present, is a non-empty string; it was added as an optional field without a `schemaVersion` bump (nothing was released with the previous shape), so an older build that validates strictly rejects a deck that uses it.
- **Unknown fields:** every object only accepts the fields the model defines, so nothing unmodelled can ride along. In particular a `CodeEl` cannot carry its own `html` / `css` / `js`; code lives only in `ComponentDef`.
- **Numbers:** finite only (no `NaN` / `Infinity`), with range limits on geometry, rotation and `step`.
- **Limits** (`ValidationOptions`, overridable per call): string length, array length, slides, elements per slide, components, assets, table cells, and nesting depth of `CodeEl.props`. Defaults live in `DEFAULT_VALIDATION_OPTIONS`.
- **Identity:** ids match `^[A-Za-z0-9_-]{1,128}$`; slide, layout and component ids are unique, placeholder ids are unique within their layout, and element ids are unique across the whole deck.
- **Stage:** `Deck.stage` has integer sides and must keep a width of 1920 or a height of 1080.
- **Referential integrity:** `Slide.layoutId`, `CodeEl.componentId`, every asset reference (image, video, fills, `ComponentDef.files` / `libs`) must resolve; an empty reference is dangling.
- **Assets (import hardening, 8.2):** `mime` must be on a configurable allow-list (`allowedMimeTypes`), and `hash` must be a lowercase hex SHA-256 digest.
- **Placeholders and fonts:** `Element.placeholder`, when present, is one of the placeholder kinds; `Theme.fontFaces` entries have a plain family name (`^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$`) and an `assetId` that resolves in `Deck.assets`. Both were added as optional fields without a `schemaVersion` bump, like `Slide.section`, so an older strict build rejects a deck that uses them.
- **Rich text:** `TextEl.rich`, when present, is checked by `validateRichText` (5.4, "Rich text editing"): a closed grammar of nodes and marks, link addresses limited to `http(s):` and `mailto:`, colour and size marks naming theme tokens that must exist in `Theme.colors` / `Theme.typeScale`, a nesting depth of 8 for lists, at most 20,000 nodes and 200,000 characters, and no field the grammar does not name (so `__proto__` or `onclick` are errors). It is the same check `SetText` applies, and the renderer additionally ignores anything outside the grammar instead of failing.
- **Theme references:** colours are validated literals (hex, `rgb()`, `hsl()` or a keyword, so no arbitrary CSS can be smuggled in) or `{ token }` references that must exist in `Theme.colors`; `TextEl.font` must exist in `Theme.fonts`.
- **Prop specs:** a default must match the declared type, lie within `min` / `max` for numbers (and `min <= max`), and be one of the option values for selects.
- **Hostile keys:** `__proto__`, `constructor` and `prototype` are rejected as keys in props, theme maps and prop specs. `CodeEl.props` must be plain JSON.

`CodeEl.props` are deliberately not checked against the component's `propSchema`: schemas evolve, and a stale prop must not make a deck unloadable; the renderer ignores undeclared props and applies defaults. Only the current `schemaVersion` is accepted (opening newer versions read-only belongs to `migrate`, not to validation); the migration chain runs before validation. Validation checks structure, not code: the content of `ComponentDef.html/css/js` is opaque here and handled by the sandbox (8.2) and trust prompt (6.4).

### Stage and units

- Logical stage: **1920 x 1080** (16:9; other ratios configurable per deck, keeping a 1080 height or 1920 width).
- Elements use stage units. The renderer wraps the stage in an element with `transform: scale(k)` where `k = containerWidth / stageWidth` (5.7).
- Text is sized in stage units too, so it scales proportionally.

## 8.2 Security model for code components

Threat: a `.deck` file contains JavaScript. If it ran in the host origin it could read every deck in IndexedDB, exfiltrate data, or modify the app.

Defence in depth:

| Layer | Measure |
|-------|---------|
| Process/origin isolation | `<iframe sandbox="allow-scripts">` **without** `allow-same-origin`, so the frame has an opaque origin: no access to host DOM, storage, cookies or IndexedDB. |
| Network | Frame document carries a CSP meta tag: `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: ...; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'none'`. Network is blocked unless the component declares and the user grants the `network` permission, in which case `connect-src`/`img-src` are widened to the listed origins only. |
| Capability API | The only way out of the frame is a `MessagePort` whose handler validates a closed set of message types. No generic eval, no DOM access. |
| Feature policy | `allow=""` on the frame: no camera, microphone, geolocation, fullscreen, etc. unless a permission is explicitly granted. |
| Navigation | `sandbox` omits `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals`; links are intercepted by the runtime and opened through the host after confirmation. |
| Resource limits | Message size cap, message rate limit, heartbeat watchdog, memory not enforceable by browsers (documented as residual risk). |
| Consent | Foreign decks open with code disabled until the user trusts them (6.4). Trust is bound to a content hash, so a changed deck prompts again. |
| Import hardening | ZIP bomb limits, path normalization, schema validation, allow-list of mime types for assets. |

Residual risks (CPU/memory exhaustion, side-channel timing, audio nuisance) are listed in section 11.

## 8.3 Code component API

Authors write ordinary web code. The runtime script injected into every frame exposes a global `deck` object. The protocol version is `apiVersion` (semver major in the handshake); the host supports the current and previous major.

```html
<!-- HTML -->
<div id="app"><button id="inc">+</button> <span id="n"></span></div>
```

```css
/* CSS */
#app { font: 64px var(--deck-font-body); color: var(--deck-color-text); }
```

```js
// JS (ES module)
deck.ready(({ props, theme, mode }) => {
  let n = deck.state.get('n') ?? props.start;
  const render = () => (document.getElementById('n').textContent = n);
  document.getElementById('inc').onclick = () => { n++; deck.state.set('n', n); render(); };
  render();
});
deck.onProps(p => { /* props changed in editor */ });
deck.steps(3);                   // this component has 3 internal steps
deck.onStep(i => { /* show step i */ });
```

| API | Description |
|-----|-------------|
| `deck.ready(cb)` | Called after handshake with `{ props, theme, mode: 'edit' \| 'present' \| 'thumbnail', size }`. |
| `deck.onProps(cb)` | Property values changed from the properties panel. |
| `deck.steps(n)` / `deck.onStep(cb)` | Participate in the presenter's step engine. |
| `deck.state.get/set` | Small persisted key/value state per component instance (JSON, size-capped). |
| `deck.navigate.next() / prev() / goTo(slideId)` | Request navigation. Honoured only in presentation mode. |
| `deck.assets.url(name)` | Resolves a deck asset to a `blob:` URL available inside the frame. |
| `deck.log(...)` | Forwarded to the editor console panel. |
| `deck.fetch(url, init)` | Present only if the `network` permission is granted. Proxied through the host to enforce the origin allow-list. |
| CSS variables | `--deck-color-*`, `--deck-font-*` injected so components follow the deck theme. |

Property schema (drives the generated properties-panel form):

```ts
type PropSpec =
  | { key: string; type: 'string'|'number'|'boolean'|'color'|'asset'; label: string; default: unknown; min?: number; max?: number }
  | { key: string; type: 'select'; label: string; options: { value: string; label: string }[]; default: string };
```

`mode` lets a component simplify itself for thumbnails (e.g. render a static frame, skip animation). Thumbnails are produced by rendering the component in `thumbnail` mode and rasterizing the host-side snapshot supplied by the component (`deck.snapshot(blob)`); components that do not provide one get a labelled placeholder.

## 8.4 Editing interactions and undo/redo

- All state changes pass through commands; there is no direct mutation. Commands produce forward and inverse JSON patches, which also serve as the basis for a future collaboration/CRDT adaptation.
- Gestures (drag, resize, rotate, typing bursts) are coalesced into a single history entry using a coalescing key and a time window. Pointer gestures additionally hold their key open (`DeckStore.beginGesture`) so a pause does not end them; keyboard bursts (a held arrow key) rely on the window alone. Operations that touch several elements in different ways (duplicate, paste, rotating a selection) are one `Batch` command.
- Selection and viewport (zoom, scroll) are UI state, not part of history.
- Patches are a subset of RFC 6902 (`add`, `replace`, `remove`, JSON-pointer paths) applied immutably, so undo keeps the identity of untouched slides and elements. `applyPatch` refuses `__proto__`, `constructor` and `prototype` keys and out-of-range paths (`PatchError`); `diff` therefore replaces an object that has such a key as a whole instead of descending into it, and treats inherited names such as `toString` as absent.
- The coalescing window slides: each merged command extends it by 500 ms. Gestures should supply a key per gesture (e.g. `drag:<ids>`); `SetNotes` coalesces per slide by default.
- Command-level rules (DT-02): a deck always keeps at least one slide (`DeleteSlide` of the last one throws); `SetProps` accepts only the shared element fields and the fields of that element type in `ELEMENT_SCHEMAS`, never `id` or `type`; `SetProps` checks scalar values against the field kind (finite numbers within the schema bounds, strings, booleans, enum members, non-negative integer `step`) and rejects removing required fields, while structured values (colours, fills, tables, code props) are left to the editor and `validateDeck` on load; `ResizeElements`, `MoveElements` and `SetProps` all reject non-finite numbers and unknown ids, even for a zero move; locked elements are not enforced by commands, that is the editor's concern; `DuplicateSlide` creates fresh ids for the slide and its elements; `AddSlide` rejects element ids that already exist in the deck (element ids are resolved deck-wide); `AddCodeElement` adds the `ComponentDef` only if its id is not in the deck yet, reuses an identical existing definition, and rejects a different one under the same id (edit shared definitions with `SetComponentSource`). `SetSlideSection` trims the name, treats a blank one as removal and caps it at 200 characters (it coalesces per slide like `SetNotes`); `SetSlideLayout` requires an existing layout and re-flows placeholder content (8.7), never adding or removing an element; `SetTheme` validates the theme with `validateTheme` (same rules as on load) and refuses one that lacks the `background` / `text` colours or the `body` font the renderer falls back on, a colour token or font key that slides, layouts or elements still use, or a font face whose asset is missing or not a `font/*` asset, a family embedded twice, or an embedded family that no font stack names, and stores a copy of its argument; `SetSlideBackground` requires an existing asset for an image fill and removes the field for `undefined`; `AddAsset` accepts only an id that is the lower-case hex SHA-256 digest and equals both `hash` and `blobKey` of the reference (so `__proto__` and similar ids never become keys), is a no-op for an identical reference and rejects a different one under the same id; `DuplicateSlide` does not copy the section start. If the current slide is removed, the store selects the slide now at the same position (or the last one).
- Text editing inside an element uses ProseMirror's own history while focused; on blur (or Escape, or when the selection moves away) its changes are committed as one `SetText` command, and only if the content differs from what the edit started from, so opening and leaving a text leaves no history entry. A commit that is refused (the element was deleted meanwhile, a theme token it names has gone) is announced and the typed text is lost: the editor is already closed by then, which is accepted because the editor's schema only produces documents `validateRichText` accepts.

## 8.5 Persistence

- `DeckRepository` (abstract class, 5.6): `list()`, `load(id)`, `save(deck, expectedRevision)`, `delete(id)`, `putAsset(blob)`, `getAsset(id)`. Implementation: IndexedDB (`idb`) with stores `decks`, `assets`, `components` (reserved), `meta` and `backups`; an in-memory implementation serves tests. Both are checked by one contract suite. Methods return `Result<T, PersistenceError>` and never reject.
- **Autosave** is debounced (500 ms, at most 5 s under a continuous gesture) and writes the deck JSON only, as one transaction over `decks` and `meta`. Whole-deck writes are accepted for now: cost follows deck size, not the size of the change. `save` does not run `validateDeck` (it would add a second full pass and could turn a bug into lost work); `load` validates, so an invalid stored deck is reported as `invalid-deck`.
- **Assets** are content-addressed: the id is the lower-case hex SHA-256 of the bytes, which is also `AssetRef.blobKey` and `AssetRef.hash`. Identical content is stored once (`created: false` on a repeat; the first mime type wins so refs and blob agree), saving a deck never touches the `assets` store, and bytes are stored as `ArrayBuffer` rather than `Blob`. `putAsset` applies the mime allow-list of 8.1 (exact match, no parameters). Assets are shared between decks, so `delete(deckId)` leaves them; garbage collection of unreferenced blobs is not built.
- **Concurrent tabs:** every deck has a `revision` (in the small `summary:<id>` record in `meta`, so the check reads no deck body), incremented on each save. `save` takes the revision the deck was loaded with (`null` for a new deck) and fails with `conflict` if the stored state differs, inside the same transaction. This also covers two tabs that both migrate an old deck: the first save wins, the second gets a `conflict`, and the backups of both loads exist. No Web Lock is used.
- **Read-only decks:** a stored deck whose `schemaVersion` is newer is never overwritten (`save` answers `read-only`), and `AutosaveService.open` returns the read-only outcome without touching the open deck.
- **Backups:** `IndexedDbDeckRepository` is the `BackupSink` of `migrateStored`. Each entry is `{ seq, deckId, fromVersion, toVersion, createdAt, raw }`. At most 5 are kept per deck: the oldest is never evicted, so a later migration cannot remove the only genuine pre-migration copy; beyond that the newest win. `delete(deckId)` removes the deck's backups. A migrated deck is stored only on the next save; loading an old deck again adds another backup, which retention bounds.
- **Failure:** an exception inside a transaction aborts it, so a partly queued save commits nothing. `QuotaExceededError` becomes `quota`, anything else `storage`; `AutosaveService` shows these through `PersistenceBanner` (6.5).
- **Eviction and reminders:** the app initializer calls `navigator.storage.persist()` (`AutosaveService.requestPersistence`). Each save records `unexported:<id>` with the time of the first save since the last export; `listUnexported()` / `markExported(id, revision?)` are the data for the export reminder (7.4), whose UI comes with the library.
- `.deck` format: ZIP containing `deck.json`, `assets/<hash>.<ext>`, optional `thumbnail.png`, `manifest.json` (format version, app version, content hash).

## 8.6 Offline and dependencies

Code components can include libraries (e.g. D3, Three.js, Chart.js). To keep decks working offline and reproducible, libraries are **vendored into the deck** as assets and exposed through an import map. The editor offers "Add library" (from file, or fetch-and-vendor from npm via a CDN once while online). Direct CDN links are possible only with the `network` permission and are flagged as an offline risk in the editor.

## 8.7 Theming

Theme tokens (colors, font families, type scale, spacing) are defined once per deck and referenced by built-in elements by token name. They are injected into code components as CSS variables, so a restyled deck restyles its components too. Layouts define placeholder positions.

- **Themes.** Elements store colour tokens (`{ token }`) and font keys, never the resolved value, so `SetTheme` restyles every built-in element by replacing `Deck.theme` alone; the renderer turns the tokens into `--deck-*` custom properties on the stage (shared with code components, 8.3). Two themes ship, `light` and `dark` (`BUILT_IN_THEMES`), with the same token names (`background`, `text`, `muted`, `accent`; fonts `heading`, `body`, `mono`) so switching never leaves a dangling reference; their text, muted and accent colours reach 4.5:1 on the background, which `themes.spec.ts` checks with `contrastRatio`. The theme picker swaps colours, type scale and spacing and keeps the deck's own fonts and font files; colour tokens the built-in theme lacks are kept. A theme counts as built-in when it has all of that theme's colours and exactly its type scale and spacing, else the picker shows "Custom"; if a change is refused the select goes back to what the deck has. Rich text size marks name `typeScale` keys, so `SetTheme` refuses a theme that lacks one that is in use (the built-in themes share their keys, so the picker never hits this). Font size is a number on the element, not a token, so a theme's type scale applies to new elements (new slides, inserted titles) but does not resize existing ones.
- **Layouts and placeholders.** A built-in layout has fixed ids (`ly_blank`, `ly_title`, `ly_title-content`, `ly_two-column`, `ly_title-only`) and placeholder ids unique within it; every deck stores its own copies. An element is *bound* to a placeholder kind by `Element.placeholder` (`title`, `body`, `image`, `footer`). A new slide made from a layout (`instantiateLayout`) gets a bound text element for each title, body and footer placeholder, styled from the theme (heading font and size for titles, body size, caption size for footers); image placeholders create no element because a picture needs a file. `SetSlideLayout` re-flows with `reflowToLayout`: per kind, the n-th bound element in z-order takes the n-th placeholder of that kind in the new layout (position, size, rotation reset to 0). Unbound elements, locked ones (which still use up their slot, so nothing is moved onto them) and bound ones with no placeholder left keep their geometry and binding, so no content is lost and switching back picks them up again; the command is reversible by undo like any other. The layout's `background` shows through where the slide has none.
- **Embedded fonts.** `Theme.fontFaces` lists `{ family, assetId }` pairs; the asset is a `font/woff2|woff|ttf|otf` blob in `Deck.assets` (content-addressed like pictures, 8.5). The renderer's `FontFaces` service registers them with `FontFace` (blob URL) so the deck does not depend on installed fonts (risk R7); faces the current theme no longer lists are removed again, so a stale file never wins a family name. Family names match `^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$`, so they are safe inside a CSS font stack, and "Add font…" derives the family from the file name (a name equal to an existing theme font such as `body` is refused), stores the file, and in one undo step adds the asset, the face and a `Theme.fonts` entry (`"Family", sans-serif`) that the Font field of a text element then offers.

## 8.8 Accessibility

- The editor UI is keyboard-operable: every canvas action (select next element, nudge, resize, reorder) and every sorter action (select, add, move, duplicate, delete) has a shortcut, declared through `ShortcutRegistry`, which refuses conflicting combinations and feeds the `?` help; focus order and visible focus rings are maintained; panels use proper roles and labels; colors meet AA contrast. Dragging (slides in the sorter) has a single-pointer alternative (Move up / Move down buttons, WCAG 2.5.7). Modal dialogs (insert menu, shortcut help) trap focus, close on Escape and return focus to what opened them.
- The in-place text editor is a labelled `role="textbox"` (`aria-multiline`) that is focused when an edit starts, announces "Editing text. Press Escape to finish." and "Text updated", and hands focus back to the canvas on Escape; its format controls are native buttons (`aria-pressed`) and selects with labels, reachable by Tab without ending the edit, and Tab inside the text is not captured (indent is Ctrl+]), so it is no keyboard trap. Rich text renders as `h1`-`h3`, `p`, `ul` / `ol` / `li`, `strong`, `em`, `u`, `code` and `a`.
- Slides render as semantic HTML (headings, lists, `alt` text for images); elements that are hidden or not yet reached by the step are not in the DOM when presenting, and thumbnails are `aria-hidden` and `inert` (5.7). The "reading order" panel (5.4) lets authors fix tab order: a slide's element array is z-order, DOM order and reading order at once, so moving an element earlier also sends it further back; there is no separate reading order yet.
- Presentation mode honours `prefers-reduced-motion` (transitions off) and exposes an ARIA live region announcing slide changes.
- Code components receive `prefers-reduced-motion` and contrast information through the runtime; the app cannot guarantee their content is accessible and shows a checklist in the code editor.
- App-wide pieces live in `shared/` (5.8): a skip link as the first focusable element, a `main` landmark, one polite live region (`LiveAnnouncer`) for status messages, and a `FocusTrap` for dialogs. Controls that are briefly unavailable use `aria-disabled` instead of `disabled`, and built-in templates set text colours that reach AA on their backgrounds. Interactive controls are native elements; actions on repeated rows carry the row's title in their accessible name.
- Automated AXE checks run in CI against the library today and against the editor and presentation views as they are built (jsdom has no layout, so colour contrast is not checked by AXE there; the built-in themes' text, muted and accent colours are checked against their background with `contrastRatio` in unit tests instead; other colours are chosen by hand).

## 8.9 Error handling and logging

- A central `ErrorService` collects host errors and component errors (tagged by component id). The editor shows component errors in the console panel; there is no remote telemetry.
- Failures never lose data: `AutosaveService.flush()` runs before risky operations (opening another deck; import will use it too) and migrations keep the previous version in a rolling backup store (`BackupSink`, see 8.1 and 8.5). A failed write keeps the changes pending and visible in the banner (6.5).

## 8.10 Testing strategy

| Level | Approach |
|-------|----------|
| Unit | Commands, history, migrations, step engine, schema validation, bridge message validation (including hostile payloads). |
| Component | Element renderers and properties panel with Angular testing utilities. |
| End-to-end | Playwright: create deck, add slides, insert code component, present, export/import round trip. |
| Security | Dedicated tests with malicious components attempting to access `parent`, `localStorage`, `indexedDB`, network, top navigation; all must fail. |
| Accessibility | AXE in e2e; manual keyboard-only run-through per release. |
| Visual regression | Screenshot comparison of reference slides across element types. |
