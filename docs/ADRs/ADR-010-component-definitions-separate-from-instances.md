# ADR-010: Component definitions separate from element instances

**Status:** Accepted

## Context

The same code component may be used on many slides and across decks, with different data per use.

## Decision

Code lives in `ComponentDef`; slides reference it with `CodeEl.componentId` and per-instance `props`.

## Consequences

- (+) Reuse and single-place edits; a library across decks.
- (-) Requires a "make unique" operation and clear UI when editing a shared component affects several slides.

Built in DT-13: `DetachComponent` is the "make unique" operation (properties panel: "Detach (make unique)", shown when the definition has more than one instance); the properties panel and the code editor both say how many elements share a definition; the component library stores copies, and inserting one into a deck copies the definition (a deck with a different definition under the same id gets the entry under a fresh id).
