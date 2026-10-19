# ADR-007: ZIP-based `.deck` file format

**Status:** Accepted

## Context

Decks must be portable, self-contained and shareable, including vendored libraries and assets.

## Decision

`.deck` is a ZIP archive with `deck.json` and content-addressed assets.

## Consequences

- (+) Self-contained, inspectable, diff-friendly JSON.
- (+) Vendored libraries travel with the deck.
- (-) Needs import hardening (size limits, path normalization, validation).
