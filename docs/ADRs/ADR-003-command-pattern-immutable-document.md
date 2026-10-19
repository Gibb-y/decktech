# ADR-003: Command pattern with immutable document and signals

**Status:** Accepted

## Context

The editor needs undo/redo, autosave, fine-grained rendering updates, and a path to collaboration.

## Decision

The deck is an immutable value held in a signal store. Mutations happen only through commands that generate patches and inverse patches.

## Consequences

- (+) Undo/redo and change tracking by construction.
- (+) Fine-grained recomputation through structural sharing.
- (-) Every feature must be expressed as a command (more boilerplate); a few helpers keep this light.
