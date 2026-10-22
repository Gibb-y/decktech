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

## As built (DT-16)

- Layout: `deck.json`, `assets/<sha256>.<ext>`, optional `thumbnail.png`, `manifest.json` with `contentHash` = SHA-256 of `deck.json`. The writer is deterministic. The reader accepts nothing else (an allow-list of entry names), checks limits before inflating, and verifies hashes, mime types and content before anything is stored (arc42 8.2, 8.5).
- `fflate` (no dependencies) does the ZIP work; `unzipSync` is used because its filter sees the central directory before any entry is inflated.
- An import never replaces an existing deck: a taken deck id is replaced by a new one.
- "Export all" is one ZIP of `.deck` files; it is a backup format and is not read back as one file.
- The content hash is an integrity check, not a signature. Trust in a deck's code is a separate decision (ADR-008).
