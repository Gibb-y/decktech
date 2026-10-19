# 11. Risks and Technical Debt

## 11.1 Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|------------|--------|------------|
| R1 | Sandbox escape or misconfiguration lets a component access the host. | Low | Critical | Keep `allow-same-origin` forbidden (lint + test); dedicated security tests; consider hosting the sandbox on a separate origin later (ADR-001c); keep browsers up to date. |
| R2 | Resource exhaustion from a hostile or buggy component (CPU loop, memory, audio). | Medium | Medium | Heartbeat watchdog, ability to kill a frame, trust prompt; browsers offer no hard limits, so residual risk is accepted. |
| R3 | Many iframes make editing slow (thumbnails, multiple components per slide). | Medium | Medium | Lazy frame creation, static snapshots for thumbnails, frame pooling, destroy off-screen frames. Measure early with a stress deck. |
| R4 | Editor complexity (selection, snapping, rotation, text editing in a scaled DOM) takes longer than expected. | High | Medium | Build vertical slice first (text + shape move/resize), reuse proven libraries for text and geometry where possible, defer tables and advanced alignment. |
| R5 | IndexedDB data eviction or loss. | Low–Medium | High | Request persistent storage (built), export bookkeeping for reminders (built, UI pending), rolling backup of the pre-migration version (`BackupSink`, written before a migrated deck is returned, oldest copy always kept), failure banner with retry, simple one-click export (DT-16). |
| R6 | Component API churn breaks existing decks. | Medium | High | Versioned handshake, host supports previous major, API frozen once released, deprecation policy. |
| R7 | Projector/laptop differences (GPU, fonts) change appearance. | Medium | Low | Embed fonts as assets, fixed stage, pre-flight check in presenter. |
| R8 | Later collaboration requirement conflicts with the local-first model. | Medium | Medium | Patch-based commands and stable ids chosen to ease a move to CRDTs (e.g. Yjs). Not committed. |
| R9 | Safari/Firefox differences in sandbox, fullscreen or File System Access API. | Medium | Low–Medium | Feature detection with fallbacks (download/upload); cross-browser e2e. |

## 11.2 Technical debt (accepted for the first release)

| Item | Note |
|------|------|
| No hot-patching of code components | Each edit reloads the frame; state may be lost during authoring. Revisit with HMR-style module swapping. |
| Thumbnails of code components are placeholders unless the component provides a snapshot | A rasterization strategy (e.g. offscreen render by the runtime) can be added. |
| Basic tables and no charts as built-in element | Charts can be written as code components. |
| PDF export of code components is a static snapshot | Print-specific handling not designed. |
| Single-user, single-device | Sync and collaboration deferred. |
| Autosave writes the whole deck | Cost follows deck size (a 1000-slide deck is cloned on every write); blobs are separate and unaffected. Revisit with per-slide records or patch journaling. |
| Unreferenced assets are never collected | `delete(deckId)` and removing an element leave blobs behind. A mark-and-sweep over all decks' `assets` is needed before storage pressure matters. |
| No cross-tab live update | A second tab learns of a change only through a `conflict` on save; a `BroadcastChannel` notification can be added. |

## 11.3 Open questions

1. Should the sandbox be served from a separate origin (stronger, needs hosting) as an option for the hosted variant?
2. Is a TypeScript-in-the-browser option (compiling component TS) worth the bundle cost?
3. Do we want a "block" level between built-in elements and full code (low-code widgets such as quiz or timer)? These could ship as built-in code components in the library.
4. Format for presenter audience interaction (polls, Q&A) which would need a server.
