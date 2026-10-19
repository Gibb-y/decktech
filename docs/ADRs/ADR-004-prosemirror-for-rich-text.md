# ADR-004: ProseMirror for rich text elements

**Status:** Accepted

## Context

Text elements need rich formatting (headings, lists, marks, links) stored as structured, validatable data.

## Decision

Text elements store a ProseMirror JSON document restricted by a schema (headings, lists, marks, links). The editor is built directly on the ProseMirror libraries (`prosemirror-model`, `-state`, `-view`, `-transform`, `-commands`, `-history`, `-keymap`, `-schema-list`), wrapped in a small Angular component.

## Alternatives considered

- Tiptap (ProseMirror wrapper): saves some UI code, but it is open-core. The core is MIT, while cloud features and some extensions require a paid subscription, and the vendor's free/paid boundary has changed before. Since the stored format is plain ProseMirror JSON either way, starting directly on ProseMirror avoids a later migration and any commercial dependency.
- Lexical, Slate: different document models and less mature schema/transform tooling for our needs.

## Consequences

- (+) Mature editing, structured content, accessible.
- (+) All dependencies are MIT-licensed with no commercial vendor; collaboration can later be added with Yjs (`y-prosemirror`) if needed.
- (-) We write the toolbar, menus and Angular integration ourselves (more code than with Tiptap).
- (-) Additional dependency weight; mitigated by lazy loading with the editor feature.
