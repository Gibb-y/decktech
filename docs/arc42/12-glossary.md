# 12. Glossary

| Term | Definition |
|------|------------|
| Deck | A presentation: ordered slides plus theme, layouts, assets and component definitions. Stored as JSON, exported as `.deck`. |
| `.deck` | ZIP archive containing `deck.json`, assets and a manifest. |
| Slide | One page of a deck, with a layout, elements, notes and optional transition. |
| Element | An object on a slide: text, image, shape, line, table, video or code. Positioned in stage units. |
| Stage | The 1920x1080 logical coordinate space of a slide, scaled to the display. |
| Layout / master | A reusable arrangement of placeholders and background applied to slides. |
| Theme | Deck-wide design tokens: colors, fonts, type scale, spacing. |
| Code component | An element backed by user-provided HTML, CSS and JavaScript, running in a sandboxed iframe. |
| Component definition (`ComponentDef`) | The source and metadata of a code component; shared by one or more code elements. |
| Component API (`deck`) | The JavaScript API injected into every code component frame. |
| Prop / property schema | Typed, declared inputs of a code component; generates its form in the properties panel. |
| Host | The DeckTech Angular application, as opposed to the sandboxed frame. |
| Sandbox | An `<iframe sandbox="allow-scripts">` with an opaque origin and restrictive CSP. |
| Bridge | The host-side message handler for a component's `MessagePort`. |
| Step (fragment) | A sub-state of a slide revealed by successive "next" actions. |
| Step engine | Logic that orders steps from elements and components and decides when to change slides. |
| Presenter view | Second-window view with current/next slide, notes and timer. |
| Command | A reversible editing operation producing forward and inverse patches. |
| Coalescing | Merging consecutive commands with the same key issued within a short window (500 ms) into one undo step, e.g. a drag. |
| Trust | The user's decision to allow code components in an imported deck to run; bound to the deck's content hash. |
| Vendored library | A third-party JS/CSS library stored inside the deck so it works offline. |
| arc42 | Template for architecture documentation (https://docs.arc42.org). |
