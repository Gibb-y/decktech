# ADR-002: DOM-based slide canvas instead of `<canvas>`

**Status:** Accepted

## Context

The editor needs rich text, selection and accessibility, and must host iframes.

## Decision

Slides are rendered as absolutely positioned DOM elements in a scaled stage; an overlay handles selection and manipulation.

## Consequences

- (+) Native text rendering and selection, accessibility, CSS styling, direct iframe embedding.
- (+) The same renderer can be used for export via print/CSS.
- (-) Pixel-perfect cross-browser consistency is harder than with canvas; accepted.
- (-) Very large slides (hundreds of elements) rely on the browser; acceptable for presentation use.
