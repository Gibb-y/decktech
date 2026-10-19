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
