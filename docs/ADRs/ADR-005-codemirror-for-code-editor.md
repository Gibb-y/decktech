# ADR-005: CodeMirror 6 for the code editor

**Status:** Accepted

## Context

Authors need to edit HTML, CSS and JS for code components inside the app, including offline.

## Decision

Use CodeMirror 6, lazy loaded on first "Edit code".

## Alternatives considered

- Monaco: better IntelliSense but roughly 5-10x the payload and an awkward worker/offline setup.

## Consequences

- (+) Small, modular, offline friendly.
- (-) Less built-in language intelligence; can be extended with language-server-like plugins later.
