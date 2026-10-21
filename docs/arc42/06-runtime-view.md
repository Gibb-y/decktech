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

    U->>C: press on element
    C->>S: beginGesture("drag:n")
    U->>C: drag element
    C->>S: execute(MoveElements{ids, dx, dy}) per pointer move, same coalesceKey
    S->>H: record forward + inverse patch (merged if same coalescing key)
    S-->>R: deck signal changes
    R-->>U: updated DOM (only affected element)
    S-->>P: debounce autosave (500 ms)
    P->>P: write deck JSON to IndexedDB
    U->>S: Ctrl+Z
    S->>H: pop inverse patch and apply
```

Only changed elements re-render because each element renderer reads a `computed` that selects its own element by id. A drag on a 100-element slide therefore re-renders only the dragged element per pointer move (a canvas test counts this with `RENDER_PROBE`), and its history entry stays one patch pair of the net change however long the gesture is. On pointer release the canvas ends the gesture hold; Escape instead undoes the whole gesture.

`AutosaveService` watches `DeckStore.deck()` but only for the deck handed to it by `create(deck)` or `open(id)`: opening a deck never rewrites it (except right after a migration, so the upgrade is stored), and a deck swapped into the store behind its back is ignored. Each change restarts a 500 ms timer; a continuous gesture is written at the latest after 5 s (`maxWaitMs`). Writes are serialised and each one passes the revision of the last stored copy, so a second tab that saved in between turns the write into a `conflict` instead of an overwrite (8.5). `flush()` writes immediately and is awaited before opening another deck, import and other risky operations.

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

Text elements follow the same gesture, with a different editor: clicking the selected text element (or Enter, or typing) starts the in-place ProseMirror editor, which loads its own chunk on first use. Typing changes nothing in the deck; leaving the text (blur, Escape, selecting something else) commits one `SetText` if the content changed, so the whole edit is one undo step (5.4, "Rich text editing").

`Insert → Code component` is `InsertActions.insert('code')`: it adds a starter `ComponentDef` with a fresh id and a code element in one `AddCodeElement` command and selects the element; the code editor itself is a later issue.

Reloading the frame on each change (rather than hot-patching) keeps semantics identical to presentation. Component state that the author wants to keep across reloads can use `deck.state` (see 8.3). In the diagram the "ready" / "init" pair is the handshake of 5.3: the frame posts `ready { apiVersion }`, the supervisor answers with a transferred `MessagePort`, and `init` (props, theme, mode, size, saved state, libraries) goes over that port, which is the only channel from then on.

## 6.2a Quick insert from the keyboard

```mermaid
sequenceDiagram
    actor U as Author
    participant R as ShortcutRegistry
    participant E as EditorShell
    participant M as InsertMenu
    participant A as InsertActions
    participant S as DeckStore
    participant P as PropertiesPanel

    U->>R: "/" (document keydown, not in a text field)
    R->>E: run global.insert-menu
    E->>M: open dialog, focus the filter
    U->>M: type "title", Enter
    M->>E: chosen(title)
    E->>A: insert(title) after the dialog is closed
    A->>S: execute(AddElement) and select it
    A-->>P: focusRequest {field: "text"}
    P-->>U: focus in the text field
    U->>P: type the title
    P->>S: execute(SetProps{text}) (coalesced, one undo step)
```

The dialog is closed before the element is inserted, so the focus trap has already given focus back and the panel's focus request is the last word. A picture takes the same path up to `pickImage()`, then `insertImage(file)` once the file chooser returns.

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
- Frame heartbeat missing for 5 s → the supervisor marks it unresponsive; the author can reload or skip it. Built (DT-11): the runtime beats every second; a frame that never says `ready` within 5 s, navigates away, floods or sends garbage is `failed` and destroyed, a silent one is `unresponsive` and recovers if it beats again; the editor shows the reason with "Reload component", presenting shows "This component is unavailable.", and the slide is never blocked (Q8). Reasons also go to `HostConsole`.
- Autosave failure (quota, IndexedDB error, conflict with another tab) sets `AutosaveService.status` to `error` and shows the persistent `PersistenceBanner` (`role="alert"`) with "Try again" and, once DT-16 provides `DECK_EXPORT_HANDLER`, an immediate `.deck` download. The failed deck stays pending: nothing is marked saved, the next edit or "Try again" retries, and `open(id)` refuses to leave a deck whose changes could not be saved unless forced.
