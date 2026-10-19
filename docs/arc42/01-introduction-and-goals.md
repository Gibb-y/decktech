# 1. Introduction and Goals

## 1.1 Requirements Overview

DeckTech is an application for creating and giving presentations. Its distinguishing feature is that it combines a familiar WYSIWYG slide editor with the full power of the web platform inside slides.

### Essential features

| ID | Feature | Description |
|----|---------|-------------|
| F1 | Visual slide editor | Slide list/sorter, canvas with drag, resize, rotate, snap and align; properties panel; undo/redo; copy/paste; duplicate. Familiar, conventional slide-editor interaction model. |
| F2 | Quick slide creation | Layouts and a theme system so new slides are one click; keyboard-first workflow (e.g. Enter to add a slide, `/` to insert an element). |
| F3 | Built-in elements | Rich text, images, shapes, lines, tables, embedded video. |
| F4 | **Code components** | An element whose content is arbitrary HTML, CSS and JavaScript. Edited in an in-app code editor with live preview. Supports configurable properties exposed in the properties panel. |
| F5 | Reusable code components | A component can be saved to a library and reused across slides and decks, with per-instance property values. |
| F6 | Presenter mode | Full-screen presentation, keyboard/clicker navigation, step-wise animations ("fragments"), presenter view with notes, next slide and timer on a second screen. |
| F7 | Themes and masters | Deck-wide fonts, colors and master layouts. |
| F8 | Persistence and portability | Autosave locally; import/export a single `.deck` file; export to PDF/PNG for static slides. |
| F9 | Offline use | Works without network; installable as a PWA. |

### Out of scope (initial versions)

- Real-time multi-user collaboration (see [risks](11-risks-and-technical-debt.md); the data model is chosen to make it possible later).
- Importing/exporting other presentation file formats.
- A hosted marketplace for components.

## 1.2 Quality Goals

Ordered by priority:

| Priority | Quality goal | Motivation |
|----------|--------------|------------|
| 1 | **Ease of authoring** | Adding and editing slides must be fast and intuitive. This is the stated primary concern. |
| 2 | **Expressiveness** | Code components must be able to do anything a web page can: canvas, WebGL, fetch, libraries, custom UI. |
| 3 | **Security** | Opening a deck from someone else must not let its code read the user's other decks, files or credentials. Required because of goal 2. |
| 4 | **Presentation reliability** | A talk must not fail live: no network dependency, no jank, no data loss. |
| 5 | **Portability** | A deck is a self-contained file that can be shared and archived. |

## 1.3 Stakeholders

| Role | Expectation |
|------|-------------|
| Presenter / author (primary user) | Fast editor, reliable presenting, power to build interactive demos. |
| Developer-presenter | Write components in real HTML/JS/CSS with good editor support (highlighting, completion, errors, live reload). |
| Audience | Smooth, readable, accessible slides. Content works on projector and when screen-shared. |
| Deck recipient | Can open a shared `.deck` safely. |
| Maintainers | Small, understandable codebase; clear extension points (element types, themes, component API). |
