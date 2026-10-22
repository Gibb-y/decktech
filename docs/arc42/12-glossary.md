# 12. Glossary

| Term | Definition |
|------|------------|
| Deck | A presentation: ordered slides plus theme, layouts, assets and component definitions. Stored as JSON, exported as `.deck`. |
| `.deck` | ZIP archive containing `deck.json`, assets and a manifest. |
| Slide | One page of a deck, with a layout, elements, notes and optional transition. |
| Element | An object on a slide: text, image, shape, line, table, video or code. Positioned in stage units. |
| Stage | The 1920x1080 logical coordinate space of a slide, scaled to the display. |
| Layout / master | A reusable arrangement of placeholders and background applied to slides. Switching a slide's layout re-flows the elements bound to placeholders. |
| Placeholder | A named slot of a layout (`title`, `body`, `image`, `footer`) with a position and size. An element that has `placeholder` set to that kind fills it. |
| Theme | Deck-wide design tokens: colors, fonts, type scale, spacing, plus embedded font files and an optional name. Elements refer to tokens by name (a text's `sizeToken` names a type scale entry), so replacing the theme restyles them. |
| Code component | An element backed by user-provided HTML, CSS and JavaScript, running in a sandboxed iframe. |
| Component definition (`ComponentDef`) | The source and metadata of a code component; shared by one or more code elements. |
| Component API (`deck`) | The JavaScript API injected into every code component frame. |
| Detach | `DetachComponent`: gives one code element its own copy of a shared component definition (fresh id, name "<name> (copy)") so that editing either no longer touches the other. |
| Component library | The built-in example components plus the components the author saved (store `components`, `ComponentLibrary`), reusable across decks; inserting copies the definition into the deck. |
| Vendored library | A JavaScript module stored as an asset of the deck, listed in a definition's `libs` and imported by its asset id through the frame's import map, so the component works offline. |
| Prop / property schema | Typed, declared inputs of a code component; generates its form in the properties panel. |
| Host | The DeckTech Angular application, as opposed to the sandboxed frame. |
| Sandbox | An `<iframe sandbox="allow-scripts">` with an opaque origin and restrictive CSP. |
| Bridge | The host-side message handler for a component's `MessagePort` (`HostBridge`): parses each message into a closed set of types, enforces size and rate limits and cuts off a frame that floods or sends garbage. |
| Supervisor | `SandboxSupervisor`: the lifecycle of one frame (handshake, port, `init`, heartbeat watchdog, navigation check). |
| Component state | `deck.state` of one code element: a small JSON key/value store kept by the host per deck and element, not part of the deck. |
| Runtime (`deck-runtime.js`) | The static script inlined into every frame that defines `deck` and talks to the bridge. |
| Step (fragment) | A sub-state of a slide revealed by successive "next" actions. |
| Step engine | `StepEngine`: logic that orders steps from elements (one per distinct `step` value) and then from the internal steps of components, and decides when to change slides. |
| Preloader | The rule `slidesToMount`: which slides the presentation keeps in the page so the next slide's code components are already running. |
| Presentation view | `PresentationView`: the fullscreen audience view, as opposed to the presenter view. |
| Presenter view | `PresenterView`: second-window view with current/next slide, notes, step indicator and timer, kept in sync with the presentation view over a `BroadcastChannel`. |
| Command | A reversible editing operation producing forward and inverse patches. |
| Migration | A pure function upgrading a deck document from schema version N to N+1; chained by `migrate` before validation. |
| Read-only deck | A deck with a newer `schemaVersion` than the app supports; reported with a reason, never edited or saved back. |
| Backup sink | Interface through which the pre-migration version of a stored deck is handed to persistence for the rolling backup. |
| `DeckRepository` | Storage abstraction for decks and assets; implemented on IndexedDB and in memory. |
| Revision | Counter stored with each deck and incremented on every save; `save` must present the revision it loaded, so concurrent writers are detected. |
| Library | The home screen (`library/`) listing stored decks; creates, renames, duplicates and deletes them through `DeckRepository`. |
| Template | A built-in deck JSON from which the library creates a new deck with a fresh id. |
| Autosave | Debounced writing of the open deck to the repository by `AutosaveService`; reports `saved`, `saving` or `error`. |
| Asset id | Lower-case hex SHA-256 of an asset's bytes; also its `blobKey`. Identical content is stored once. |
| Gesture | One continuous pointer action on the canvas (drag, resize, rotate). It issues many commands with one `coalesceKey`, holds the key open with `beginGesture`, and so is one undo step. |
| Batch | A command that runs several commands in order as one undo step. |
| Rich text | The formatted content of a text element, `TextEl.rich`: a restricted ProseMirror JSON document (headings, lists, bold / italic / underline / code, links, theme colour and size). `TextEl.text` keeps its plain-text mirror. Edited in place by the lazy ProseMirror chunk and drawn by the renderer without it. |
| Interact mode | Canvas mode in which the overlay lets the pointer through to the one selected code element instead of selecting and dragging it. |
| Section | A named group of slides: `Slide.section` on a slide starts it, and it runs to the next slide that has one. Shown in the slide sorter. |
| Reading order | The order in which assistive technology and the Tab key visit a slide's elements: the element array, which is also the z-order. Fixed in the reading-order panel. |
| Shortcut registry | `ShortcutRegistry`: the single table of keyboard shortcuts (id, scope, key combination, handler) with conflict detection; the source of the shortcut help. |
| Quick insert | Opening the insert menu with `/` and choosing an element by typing part of its name. |
| Properties panel | The contextual panel for the selected element (or the slide), built from `ELEMENT_SCHEMAS`; its scalar fields are a Signal Form whose edits become `SetProps` commands. |
| Snapping guide | A line drawn while a dragged edge or centre is aligned with the slide or another element. |
| Coalescing | Merging consecutive commands with the same key issued within a short window (500 ms) into one undo step, e.g. a drag. |
| Trust | The user's decision to allow code components in an imported deck to run; bound to the deck's content hash. |
| Vendored library | A third-party JS/CSS library stored inside the deck so it works offline. |
| arc42 | Template for architecture documentation (https://docs.arc42.org). |
