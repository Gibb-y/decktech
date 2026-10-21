# ADR-005: CodeMirror 6 for the code editor

**Status:** Accepted

## Context

Authors need to edit HTML, CSS and JS for code components inside the app, including offline.

## Decision

Use CodeMirror 6, lazy loaded on first "Edit code".

Built in DT-13: `components/editor/code-mirror.ts` is the only file that imports CodeMirror, and the code editor dialog, the component library dialog and CodeMirror form one lazy chunk (`component-tools`), loaded through the `COMPONENT_TOOLS` token on first use. `npm run lint:boundaries` enforces both rules. The read-only `CodeInspector` of ADR-008 is to use the same `CodeMirror` component, so it adds no second copy.

## Alternatives considered

- Monaco: better IntelliSense but roughly 5-10x the payload and an awkward worker/offline setup.

## Consequences

- (+) Small, modular, offline friendly.
- (-) Less built-in language intelligence; can be extended with language-server-like plugins later.
