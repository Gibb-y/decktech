# ADR-010: Component definitions separate from element instances

**Status:** Accepted

## Context

The same code component may be used on many slides and across decks, with different data per use.

## Decision

Code lives in `ComponentDef`; slides reference it with `CodeEl.componentId` and per-instance `props`.

## Consequences

- (+) Reuse and single-place edits; a library across decks.
- (-) Requires a "make unique" operation and clear UI when editing a shared component affects several slides.
