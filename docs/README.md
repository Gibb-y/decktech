# DeckTech Documentation

DeckTech is a slide deck app with a visual editor and first-class **code components**: slide elements written in full HTML, CSS and JavaScript for interactive presentations.

The architecture is documented with [arc42](https://docs.arc42.org/home/). Diagrams use [Mermaid](https://mermaid.js.org/) and render on GitHub and in most Markdown viewers.

| # | Section | File |
|---|---------|------|
| 1 | Introduction and Goals | [01-introduction-and-goals.md](arc42/01-introduction-and-goals.md) |
| 2 | Architecture Constraints | [02-architecture-constraints.md](arc42/02-architecture-constraints.md) |
| 3 | Context and Scope | [03-context-and-scope.md](arc42/03-context-and-scope.md) |
| 4 | Solution Strategy | [04-solution-strategy.md](arc42/04-solution-strategy.md) |
| 5 | Building Block View | [05-building-block-view.md](arc42/05-building-block-view.md) |
| 6 | Runtime View | [06-runtime-view.md](arc42/06-runtime-view.md) |
| 7 | Deployment View | [07-deployment-view.md](arc42/07-deployment-view.md) |
| 8 | Cross-cutting Concepts | [08-crosscutting-concepts.md](arc42/08-crosscutting-concepts.md) |
| 9 | Architecture Decisions | [09-architecture-decisions.md](arc42/09-architecture-decisions.md) |
| 10 | Quality Requirements | [10-quality-requirements.md](arc42/10-quality-requirements.md) |
| 11 | Risks and Technical Debt | [11-risks-and-technical-debt.md](arc42/11-risks-and-technical-debt.md) |
| 12 | Glossary | [12-glossary.md](arc42/12-glossary.md) |

## Design in one paragraph

DeckTech is a local-first Angular single-page app (PWA). A deck is a versioned JSON document: slides contain absolutely positioned elements on a fixed 1920x1080 stage. Built-in elements (text, image, shape) are edited visually; **code components** are elements backed by an HTML/CSS/JS source that runs inside a sandboxed iframe and talks to the host over a small, versioned `postMessage` API. Editing, thumbnails and presenting all use the same renderer, so what you edit is what you present. Decks live in IndexedDB and export to a portable `.deck` archive, so there is no server to run.
