# ADR-009: Fixed logical stage with CSS scaling

**Status:** Accepted

## Context

Slides must look the same on any display, and code components need a deterministic layout size.

## Decision

Slides use a 1920x1080 logical stage scaled via a CSS transform.

## Consequences

- (+) Deterministic layout for code components at any display size.
- (-) Fractional scaling can blur 1px lines; mitigated with non-scaling strokes where needed.
