# 4. Solution Strategy

## 4.1 Core ideas

1. **Deck as data.** A deck is a plain, versioned JSON document (slides → elements). All editing is a transformation of that document. Rendering, thumbnails, presenting and export are pure functions of it. This keeps the editor simple and makes undo/redo, persistence and future collaboration tractable.
2. **One renderer for everything.** The same `SlideRenderer` draws the editing canvas, the thumbnails, the presenter output and PDF export. WYSIWYG is a structural guarantee, not something we test our way toward.
3. **Fixed logical stage, scaled to fit.** Slides are authored on a 1920x1080 coordinate space and scaled with a CSS transform. Positions and sizes are resolution independent; code components always see a 1920x1080 viewport (scaled), so their layout is deterministic.
4. **Code components are sandboxed web pages.** Each is an `<iframe sandbox srcdoc>` with an opaque origin, talking to the host through a small, versioned message API. Authors have full HTML/CSS/JS; the host stays safe.
5. **A familiar slide-editor mental model, plus a code editor.** Code components are just another element: they have position, size, z-order, and properties in the same panel. Opening the code editor is an explicit action (double-click / "Edit code").
6. **Local-first, no backend.** IndexedDB for working storage, `.deck` ZIP for portability, service worker for offline.

## 4.2 Quality goal → approach

| Quality goal | Approach |
|--------------|----------|
| Ease of authoring | Layouts + themes + templates; command-based editor with undo/redo; keyboard shortcuts; slide sorter drag/drop; autosave; instant live preview of code components. |
| Expressiveness | Components are real HTML/CSS/JS documents; permitted to use ES modules, canvas, WebGL, Web Audio; deck-scoped asset files can be read by asset id (`deck.assets.url`); optional vendored libraries. |
| Security | `sandbox` without `allow-same-origin`, strict CSP on the iframe document, no network by default, capability-based host API, trust prompt on opening foreign decks. |
| Presentation reliability | No runtime network dependency; thumbnails and components are pre-initialised for next slide; debounced autosave with pre-migration backups; presenter mode uses the already-loaded state. |
| Portability | Self-contained `.deck` archive with `deck.json` + assets + vendored libs; schema versioning with migrations. |

## 4.3 Key technology choices

| Concern | Choice | Reason (see [ADRs](09-architecture-decisions.md)) |
|---------|--------|----------------------------------------------------|
| UI framework | Angular, standalone, signals, zoneless | Project constraint. |
| Slide canvas | DOM + CSS transforms (not `<canvas>`) | Accessible, selectable text, crisp, natural fit for HTML code components. ADR-002 |
| Rich text | ProseMirror-based text element editor | Mature, structured JSON content, schema-controlled. ADR-004 |
| Code editor | CodeMirror 6, lazy loaded | Light, modular, good mobile/a11y story; Monaco is much heavier. ADR-005 |
| Code isolation | Sandboxed iframe + MessageChannel | Only mechanism that gives real isolation of JS in a browser. ADR-001 |
| State | Signal-based store + command pattern | Undo/redo and patch generation for free. ADR-003 |
| Persistence | IndexedDB (via `idb`) | Large binary assets, transactional. ADR-006 |
| Archive format | ZIP (`fflate`) | Inspectable, tooling-friendly. ADR-007 |

## 4.4 Organisation of the code

Feature-sliced, lazy-loaded Angular routes:

```
src/app/
  core/          document model, commands, store, persistence, schema migrations
  renderer/      SlideRenderer, element renderers, scaling, asset URLs (thumbnails are its `thumbnail` mode)
  editor/        canvas, selection, slide sorter, insert menu and toolbar, properties panel, notes, reading order, shortcut registry
  components/    code component host (sandbox, bridge), library, code editor (lazy)
  presenter/     presentation view, presenter view, step engine, timer
  library/       deck list (home), templates, import/export
  shared/        UI primitives, a11y utilities
```

Dependency rule: `core` depends on nothing; `renderer` depends on `core`; `editor`, `presenter`, `components` depend on `renderer`, `core` and `shared`; `library` depends on `core` and `shared`; `shared` depends on nothing; features never depend on one another directly.

The rule is enforced by `scripts/check-boundaries.mjs` (`npm run lint:boundaries`), a dependency-free script that reads every relative import under `src/app` and fails on an import the table in the script does not allow (and on an unknown top-level folder). The same script guards the sandbox of code components (8.2): it fails on a dangerous sandbox flag (`allow-same-origin`, `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals`, ...) in any source or template, and on a frame created anywhere but `components/host/sandbox.ts`. There is no CI pipeline yet, so run it (and the tests) locally before opening a PR. It stands in for an ESLint boundaries plugin so that the project needs no linter yet; the allowed-imports table is the single place to change when the rule changes. Files directly in `src/app` (`app.ts`, routes, config) wire the features together and are not restricted.

Every route in `app.routes.ts` is lazy (`loadComponent`), so the initial bundle holds only the shell, the persistence banner and the shared a11y pieces; a test asserts that no route uses an eager `component`.
