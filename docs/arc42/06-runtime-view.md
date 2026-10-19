# 6. Runtime View

## 6.1 Editing a slide (command flow)

```mermaid
sequenceDiagram
    actor U as Author
    participant C as Canvas overlay
    participant S as DeckStore
    participant H as History
    participant R as Renderer
    participant P as Persistence

    U->>C: drag element
    C->>S: execute(MoveElements{ids, dx, dy}) (coalesced while dragging)
    S->>H: record forward + inverse patch (merged if same coalescing key)
    S-->>R: deck signal changes
    R-->>U: updated DOM (only affected element)
    S-->>P: debounce autosave (500 ms)
    P->>P: write deck JSON to IndexedDB
    U->>S: Ctrl+Z
    S->>H: pop inverse patch and apply
```

Only changed elements re-render because each element renderer reads a `computed` that selects its own element by id.

## 6.2 Creating and editing a code component

```mermaid
sequenceDiagram
    actor U as Author
    participant I as InsertMenu
    participant S as DeckStore
    participant D as CodeEditorDialog
    participant B as DocumentBuilder
    participant F as Sandboxed iframe
    participant HB as HostBridge

    U->>I: Insert → Code component
    I->>S: execute(AddCodeElement{template})
    U->>D: double-click element
    D->>B: build(def)
    B-->>F: srcdoc (CSP + runtime + user code)
    F->>HB: ready {apiVersion}
    HB-->>F: init {props, theme, mode:"edit"}
    U->>D: type code
    D->>D: debounce 300 ms
    D->>B: rebuild
    B-->>F: replace srcdoc (fresh frame)
    F-->>D: console / error messages
    U->>D: Done
    D->>S: execute(SetComponentSource{id, html, css, js})
```

Reloading the frame on each change (rather than hot-patching) keeps semantics identical to presentation. Component state that the author wants to keep across reloads can use `deck.state` (see 8.3).

## 6.3 Presenting

```mermaid
sequenceDiagram
    actor P as Presenter
    participant PV as PresenterView window
    participant V as PresentationView
    participant SE as StepEngine
    participant F as Code component frame

    P->>V: Start presentation (F5)
    V->>V: enter fullscreen, build slide 1
    V->>PV: BroadcastChannel: state{slide, step}
    P->>V: → (next)
    V->>SE: next()
    alt component has remaining internal steps
        SE->>F: step {index}
        F-->>SE: ack / stepCount
    else
        SE->>V: advance to next slide
        V->>PV: state{slide, step}
    end
```

The `Preloader` creates the next slide's frames while the current slide is shown, so advancing is instant. Frames of slides more than one away are destroyed.

## 6.4 Opening a foreign deck

```mermaid
flowchart TD
    A[Import .deck] --> B[Unzip with size / entry limits]
    B --> C[`migrate`: run migrations, validate with `validateDeck`;<br/>newer schema opens read-only]
    C --> D{Contains code components<br/>or requests permissions?}
    D -- no --> G[Open normally]
    D -- yes --> E[Trust dialog: components, slides,<br/>permissions, libraries, flags]
    E --> I[Code inspector: read-only source,<br/>diff if previously trusted]
    I --> E
    E --> F{User choice}
    F -- Open with code disabled --> H[Code elements shown as placeholders]
    F -- Run selected components --> J[Open; only chosen components run]
    F -- Trust whole deck --> G
    F -- Cancel --> X[Abort]
```

Locally authored decks are trusted by default; decks imported from files are untrusted until the user decides. Trust is recorded per deck id + content hash (see [ADR-008](../ADRs/ADR-008-trust-prompt-for-imported-decks.md)).

The inspector shows source as text only. No frame is created for an untrusted component, so reading the code never runs it. If a previously trusted deck is re-imported with a different hash, the inspector opens on a per-component diff against the last trusted version.

## 6.5 Error handling at runtime

- A component that throws or hangs shows an error overlay (in edit mode) or is replaced by a neutral placeholder (in presentation mode) so one broken component never stops the talk.
- Frame heartbeat missing for 5 s → the supervisor marks it unresponsive; the author can reload or skip it.
- Autosave failure (quota, IndexedDB error) shows a persistent banner and offers immediate `.deck` download.
