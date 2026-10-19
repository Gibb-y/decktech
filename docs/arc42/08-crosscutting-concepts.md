# 8. Cross-cutting Concepts

## 8.1 Domain model and document lifecycle

The deck document (section 5.2) is the single source of truth. It is immutable from the outside: the store replaces it with a new value on each command, and unchanged slides and elements keep their object identity, so signals and `computed` selectors only recompute what changed.

Document versions are tracked by `schemaVersion`. Every load or import runs the migration chain; unknown *newer* versions open read-only with a warning.

### Migrations

`migrate(raw)` (`src/app/core/migrations/`) is the entry point in front of `validateDeck` and never throws:

- **Chain:** `MIGRATIONS` maps a version to the pure step that upgrades it to the next one. The runner applies the steps in order and stamps `schemaVersion` itself after each, so a step only transforms content. Bumping `SCHEMA_VERSION` requires adding the step from the previous version (a spec checks the registry is contiguous) and a frozen fixture for the new version (`fixtures.ts`). v0 → v1 is synthetic: no released app wrote v0; it exists to exercise the chain.
- **Atomicity:** an older document is deep-cloned once and the steps run on the clone, so a throwing or in-place-mutating step cannot change the caller's data. A step that throws, returns a non-object, or leaves a gap in the chain gives an error result (`migration-failed`, `no-path`); a migrated deck that does not validate gives `invalid-deck` with the validation paths. A document already at the current version is validated as is, without a copy.
- **Newer versions:** the outcome is `{ readOnly: true, reason, fromVersion, supportedVersion, deck }`. `deck` is best effort: set only if the document still validates against the current schema (with `schemaVersion` kept at the original value), otherwise `null`. The caller must not edit or save a read-only deck. A missing, fractional, negative or non-numeric `schemaVersion` is an `invalid-version` error.
- **Backup:** `migrateStored(raw, sink)` is for decks loaded from storage. Only when an upgrade actually happened (and succeeded) it awaits `sink.backup({ raw, fromVersion, toVersion })` with the untouched original, and only then returns the migrated deck. If the backup fails the result is a `backup-failed` error, so the caller keeps the stored original and never overwrites it with an un-backed-up migration. Failed migrations and read-only decks need no backup, because nothing is overwritten. The sink (rolling store, retention) is part of persistence (`DeckRepository`).

### Validation

`validateDeck(unknown)` is the single entry point for untrusted documents (import, storage). It returns `Result<Deck, ValidationError[]>`; every error carries a path (e.g. `slides[2].elements[0].w`) and all problems are collected rather than stopping at the first. It enforces:

- **Types and enums:** every field has the expected type; element, fill, transition, permission and prop types are closed sets, so unknown element types are rejected.
- **Unknown fields:** every object only accepts the fields the model defines, so nothing unmodelled can ride along. In particular a `CodeEl` cannot carry its own `html` / `css` / `js`; code lives only in `ComponentDef`.
- **Numbers:** finite only (no `NaN` / `Infinity`), with range limits on geometry, rotation and `step`.
- **Limits** (`ValidationOptions`, overridable per call): string length, array length, slides, elements per slide, components, assets, table cells, and nesting depth of `CodeEl.props`. Defaults live in `DEFAULT_VALIDATION_OPTIONS`.
- **Identity:** ids match `^[A-Za-z0-9_-]{1,128}$`; slide, layout and component ids are unique, placeholder ids are unique within their layout, and element ids are unique across the whole deck.
- **Stage:** `Deck.stage` has integer sides and must keep a width of 1920 or a height of 1080.
- **Referential integrity:** `Slide.layoutId`, `CodeEl.componentId`, every asset reference (image, video, fills, `ComponentDef.files` / `libs`) must resolve; an empty reference is dangling.
- **Assets (import hardening, 8.2):** `mime` must be on a configurable allow-list (`allowedMimeTypes`), and `hash` must be a lowercase hex SHA-256 digest.
- **Theme references:** colours are validated literals (hex, `rgb()`, `hsl()` or a keyword, so no arbitrary CSS can be smuggled in) or `{ token }` references that must exist in `Theme.colors`; `TextEl.font` must exist in `Theme.fonts`.
- **Prop specs:** a default must match the declared type, lie within `min` / `max` for numbers (and `min <= max`), and be one of the option values for selects.
- **Hostile keys:** `__proto__`, `constructor` and `prototype` are rejected as keys in props, theme maps and prop specs. `CodeEl.props` must be plain JSON.

`CodeEl.props` are deliberately not checked against the component's `propSchema`: schemas evolve, and a stale prop must not make a deck unloadable; the renderer ignores undeclared props and applies defaults. Only the current `schemaVersion` is accepted (opening newer versions read-only belongs to `migrate`, not to validation); the migration chain runs before validation. Validation checks structure, not code: the content of `ComponentDef.html/css/js` is opaque here and handled by the sandbox (8.2) and trust prompt (6.4).

### Stage and units

- Logical stage: **1920 x 1080** (16:9; other ratios configurable per deck, keeping a 1080 height or 1920 width).
- Elements use stage units. The renderer wraps the stage in an element with `transform: scale(k)` where `k = containerWidth / stageWidth`.
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
- Gestures (drag, resize, typing bursts) are coalesced into a single history entry using a coalescing key and a time window.
- Selection and viewport (zoom, scroll) are UI state, not part of history.
- Text editing inside an element uses ProseMirror's own history while focused; on blur its changes are committed as one `SetText` command.

## 8.5 Persistence

- `DeckRepository` (interface): `list()`, `load(id)`, `save(deck)`, `delete(id)`, `putAsset(blob)`, `getAsset(id)`. Implementation: IndexedDB with stores `decks`, `assets`, `components`, `meta`.
- Autosave is debounced and writes the deck JSON only. Assets are content-addressed (SHA-256), so duplicates are stored once and saving never rewrites large blobs.
- `.deck` format: ZIP containing `deck.json`, `assets/<hash>.<ext>`, optional `thumbnail.png`, `manifest.json` (format version, app version, content hash).

## 8.6 Offline and dependencies

Code components can include libraries (e.g. D3, Three.js, Chart.js). To keep decks working offline and reproducible, libraries are **vendored into the deck** as assets and exposed through an import map. The editor offers "Add library" (from file, or fetch-and-vendor from npm via a CDN once while online). Direct CDN links are possible only with the `network` permission and are flagged as an offline risk in the editor.

## 8.7 Theming

Theme tokens (colors, font families, type scale, spacing) are defined once per deck and referenced by built-in elements by token name. They are injected into code components as CSS variables, so a restyled deck restyles its components too. Layouts define placeholder positions; changing a slide's layout re-flows placeholder content.

## 8.8 Accessibility

- The editor UI is keyboard-operable: every canvas action (select next element, nudge, resize, reorder) has a shortcut; focus order and visible focus rings are maintained; panels use proper roles and labels; colors meet AA contrast.
- Slides render as semantic HTML (headings, lists, `alt` text for images). A "reading order" panel lets authors fix tab order.
- Presentation mode honours `prefers-reduced-motion` (transitions off) and exposes an ARIA live region announcing slide changes.
- Code components receive `prefers-reduced-motion` and contrast information through the runtime; the app cannot guarantee their content is accessible and shows a checklist in the code editor.
- Automated AXE checks run in CI against the editor and presentation views.

## 8.9 Error handling and logging

- A central `ErrorService` collects host errors and component errors (tagged by component id). The editor shows component errors in the console panel; there is no remote telemetry.
- Failures never lose data: autosave runs before risky operations (import, migration) and migrations keep the previous version in a rolling backup store (`BackupSink`, see 8.1; the store itself belongs to persistence).

## 8.10 Testing strategy

| Level | Approach |
|-------|----------|
| Unit | Commands, history, migrations, step engine, schema validation, bridge message validation (including hostile payloads). |
| Component | Element renderers and properties panel with Angular testing utilities. |
| End-to-end | Playwright: create deck, add slides, insert code component, present, export/import round trip. |
| Security | Dedicated tests with malicious components attempting to access `parent`, `localStorage`, `indexedDB`, network, top navigation; all must fail. |
| Accessibility | AXE in e2e; manual keyboard-only run-through per release. |
| Visual regression | Screenshot comparison of reference slides across element types. |
