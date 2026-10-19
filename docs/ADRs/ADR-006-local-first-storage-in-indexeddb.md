# ADR-006: Local-first storage in IndexedDB; no backend initially

**Status:** Accepted

## Context

The app must work offline, with minimal operational overhead, and keep user data private by default.

## Decision

Persist decks and assets in IndexedDB behind a `DeckRepository` interface.

## Consequences

- (+) Works offline, zero ops, private by default.
- (-) No cross-device sync or sharing link; users exchange `.deck` files. The interface permits adding a cloud repository later.
- (-) Browser storage can be evicted; mitigated by requesting persistent storage and backup reminders.

## Implementation notes (DT-04)

- IndexedDB is used through `idb`; a second, in-memory implementation exists for tests and both run the same contract suite.
- Several tabs can write the same database. Instead of locks, each deck carries a revision that `save` must present (optimistic concurrency inside one transaction); a stale writer gets a `conflict` and the banner, never a silent overwrite.
- Blobs are stored as bytes under their SHA-256, in their own store, so saving a deck never rewrites them.
- Per-deck summaries live in `meta` so listing the library does not read deck bodies.
