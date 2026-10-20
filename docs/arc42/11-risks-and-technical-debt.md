# 11. Risks and Technical Debt

## 11.1 Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|------------|--------|------------|
| R1 | Sandbox escape or misconfiguration lets a component access the host. | Low | Critical | Keep `allow-same-origin` forbidden (lint + test); dedicated security tests; consider hosting the sandbox on a separate origin later (ADR-001c); keep browsers up to date. |
| R2 | Resource exhaustion from a hostile or buggy component (CPU loop, memory, audio). | Medium | Medium | Heartbeat watchdog, ability to kill a frame, trust prompt; browsers offer no hard limits, so residual risk is accepted. |
| R3 | Many iframes make editing slow (thumbnails, multiple components per slide). | Medium | Medium | Lazy frame creation, static snapshots for thumbnails, frame pooling, destroy off-screen frames. Measure early with a stress deck. |
| R4 | Editor complexity (selection, snapping, rotation, text editing in a scaled DOM) takes longer than expected. | High | Medium | Build vertical slice first (text + shape move/resize), reuse proven libraries for text and geometry where possible, defer tables and advanced alignment. Built (DT-07): selection, move, resize, rotate, snapping, align / distribute and zoom on the canvas, with pure geometry functions tested on their own; in-place text editing is still open (DT-08). |
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
| Library thumbnails are placeholders | `library` may not import `renderer` (4.4), so the home screen shows the title's initial. Slide thumbnails there need a rule change or a thumbnail provider in `shared`. Also unbuilt: import/export in the library and the export reminder UI. |
| Library list is paged, not windowed | 60 decks at a time plus `content-visibility`, which meets Q11 for placeholder thumbnails. Revisit with real thumbnails. Renaming or deleting a deck that another tab has open surfaces as a `conflict` or as a failed save there. |
| Canvas limits | Group resize and rotation need unrotated members (no shear); the group has no rotate handle; resizing never flips; snapping covers unrotated boxes and move only (no distance guides); the marquee selects by intersection of bounds. Moves send incremental deltas, so very long drags can leave floating-point noise (about 1e-13) in coordinates. Q9 is measured by hand, not in CI (10.3): tests only check that a move re-renders one element and keeps one history entry. Code components are not rendered yet, so the measured deck has none; repeat the profile with them in DT-12. Hit targets are one div per element, redrawn from the slide on each change. |
| No cross-tab live update | A second tab learns of a change only through a `conflict` on save; a `BroadcastChannel` notification can be added. |

## 11.3 Open questions

1. Should the sandbox be served from a separate origin (stronger, needs hosting) as an option for the hosted variant?
2. Is a TypeScript-in-the-browser option (compiling component TS) worth the bundle cost?
3. Do we want a "block" level between built-in elements and full code (low-code widgets such as quiz or timer)? These could ship as built-in code components in the library.
4. Format for presenter audience interaction (polls, Q&A) which would need a server.
