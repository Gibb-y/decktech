# DeckTech MCP guide for agents

You build slide decks with this server's tools. A deck is a document you edit step by step; `export_deck` writes it to a `.deck` file that a person opens in DeckTech. Read this once, then use `describe_schema` for details (topics: `overview`, `elements`, `layouts`, `themes`, `component-api`, `limits`, `guide`).

## The model in 60 seconds

- A **deck** has **slides**; a slide has **elements** (text, image, shape, line, code) in a list. Everything lives on a fixed **1920 x 1080 stage**; `x`, `y`, `w`, `h` are in those units, origin top-left.
- The **order of elements in a slide** is stacking order (later = in front) *and* reading order for screen readers. Put the title first.
- Ids (`deckId`, `slideId`, `elementId`, `componentId`) come from tool results. Never invent them. `get_deck` lists everything.
- **Colours** are a theme token (`text`, `background`, `muted`, `accent`) or a CSS colour (`#336699`, `rebeccapurple`). Prefer tokens: switching theme restyles them.
- Every tool that changes a deck is **one undo step**; `undo` / `redo` take the `deckId`. A refused call changes nothing, so retry with a fix instead of working around it.
- Decks exist in memory until you call `export_deck`. Closing the server loses unexported work.

## A deck from nothing

1. `describe_schema` with topic `layouts` (and `component-api` if you will write code).
2. `create_deck` with a `title` (and `theme`: `light` or `dark`). It returns the `deckId` and the first slide (Blank layout).
3. For each further slide: `add_slide` with a `layoutId` (`ly_title`, `ly_title-content`, `ly_two-column`, `ly_title-only`, `ly_blank`). Layouts with placeholders give you text elements that already hold **sample text** ("Title", "- First point"). Replace it with `set_text` (use `heading: true` for titles); do not leave sample text behind.
4. Add content: `add_text`, `add_image`, `add_shape`, `add_line`, `add_table`, `add_video`, `insert_code_element`.
5. `set_speaker_notes` per slide, `check_accessibility`, optionally `render_preview`.
6. `export_deck` with a path ending in `.deck`, e.g. `talk.deck`. It refuses to overwrite unless `overwrite: true`.

To change an existing file: `open_deck` (or `import_deck`, the same), edit, `export_deck` with `overwrite: true`.

Restructuring: `set_deck_metadata` (title, theme), `duplicate_slide`, `delete_slide`, `move_slide`, `set_layout` (switches a slide to another layout; placeholder content moves, nothing is deleted) and `delete_element`. Deleting is an undo step like everything else.

## Text

- `add_text` takes plain text. Lines starting with `- ` become a bullet list; each other line is a paragraph.
- `role` sets the size from the theme: `title` 96, `heading` 64, `body` 40, `caption` 28. Titles on a 1920-wide stage need to be big; body text below about 28 is hard to read when projected.
- Keep text inside the stage: `x + w <= 1920`, `y + h <= 1080`. A text box does not grow with its content, so give long text enough `h`.
- `set_text` replaces the text of an existing element (including placeholders).

## Images, shapes, lines

- `add_image` reads a file from the workspace folder (png, jpeg, gif, webp, avif, svg). **Alt text is required**: describe what the image shows or says, not "image". Pass `decorative: true` with an empty alt only for pure decoration. Change it later with `set_alt_text`.
- `add_shape` (`rect`, `ellipse`, `triangle`) defaults to the accent colour.
- `add_line` takes two points. Lines are decoration and invisible to screen readers.
- `move_element` sets position and size; `update_element` sets other properties (`rotation`, `hidden`, `step`, `fontSize`, `align`, `fill`, ...). `set_z_order` moves an element `front` / `back` / `forward` / `backward`.

## Tables and videos

- `add_table` takes `rows` (a rectangle of text cells). The first row is a header row by default (`header: true`), which screen readers announce as column headers; pass `header: false` only when the first row is data. Keep tables small enough to read on a slide.
- `edit_table` changes an existing table with a list of operations applied as one undo step (the `op` field: "set_cell", "set_cell_fill", "add_row", "remove_row", "add_column", "remove_column", "set_column_widths"). Indices start at 0; if one operation is refused, none is applied.
- `add_video` reads an MP4 or WebM file from the workspace folder and embeds it. `label` is required and names the player for screen readers. `poster` is an optional picture. `autoplay` needs `muted: true` and only plays while presenting. Say in the notes what the video shows.

## Accessibility (a hard requirement)

Run `check_accessibility` before exporting. It reports images without alt text, empty text elements and text whose colour has too little contrast (WCAG AA needs 4.5:1) against the slide background. `notChecked` lists what it could not judge (gradient or image backgrounds): look at those yourself. Also: one title per slide, reading order = element order (`set_reading_order` sets the whole order of a slide at once, first read to last), no information carried by colour alone.

## Code components

A code component is a small web page (HTML, CSS, a JavaScript ES module) that runs in a sandboxed frame on the slide: charts, diagrams, animations, interactive demos. The **definition** is shared; each **instance** on a slide has its own `props`.

1. Read `describe_schema` with topic `component-api`. In the script, everything starts in `deck.ready(({ props, theme, mode }) => { ... })`. There is no network, no `localStorage`, no inline `<script>`.
2. `create_component` with `name`, `html`, `css`, `js`, `propSchema` (the settings a person can change) and `permissions` (leave empty unless needed; each one is flagged to whoever opens the deck), and `libs` (vendored libraries, see Libraries below).
3. `insert_code_element` with `slideId`, `componentId`, optional `props` and a position/size. Props are checked against the schema: unknown keys and values of the wrong type or range are refused with the prop's label.
4. `update_code_element_props` changes one instance. `update_component` changes the shared definition and **all instances with it**; the result says how many instances share it and on which slides. To change just one, `detach_component` it first (it gets its own copy).
5. Reuse across decks: `save_to_library`, then `import_from_library` in the other deck.

Write components so they follow the theme and the stage: use `var(--deck-color-text)`, `var(--deck-color-background)`, `var(--deck-font-body)`; size to the frame (it is always 1920 x 1080 scaled), not to `window.innerWidth`; give the root element a `role` and an `aria-label` if it shows information.

### Example component

Create it with `create_component` (add `deckId`):

```json
{
  "name": "Counter",
  "html": "<div id=\"app\" role=\"status\" aria-live=\"polite\"><button id=\"inc\">+</button> <span id=\"n\"></span></div>",
  "css": "#app { font: 96px var(--deck-font-body); color: var(--deck-color-text); display: flex; gap: 32px; align-items: center; justify-content: center; height: 100%; } button { font: inherit; }",
  "js": "deck.ready(({ props }) => {\n  let n = deck.state.get('n') ?? props.start;\n  const out = document.getElementById('n');\n  const render = () => { out.textContent = n; };\n  document.getElementById('inc').onclick = () => { n++; deck.state.set('n', n); render(); };\n  render();\n});",
  "propSchema": [{ "key": "start", "type": "number", "label": "Start value", "default": 0, "min": 0, "max": 100 }],
  "permissions": []
}
```

### Libraries (React, charts, ...)

A component can use a JavaScript library, stored **inside the deck** so it works offline. The sandbox has no network, so you vendor the library first, with a tool, and never edit the `.deck` file.

1. `add_library_from_package` with `package` and an exact `version` (downloads a bundled build from esm.sh, at most 5 MiB; needs a connection) or `add_library_from_file` for a `.js` / `.mjs` file in the workspace folder. Both return the `assetId` and the `name` to import it by. The same content is stored once.
2. Attach it: `libs: ["react"]` on `create_component` / `update_component` (names from step 1, or asset ids). `get_component` and `list_components` show the attached libraries.
3. In the script import it **by that name**: `import React from "react"`. The sandbox only resolves asset ids, so the server replaces the name by the id when it saves the script; what `get_component` returns therefore holds ids. Names are matched exactly (`react-dom/client`), or with the version (`react@19.3.1`). Imports of anything else (a URL, a relative path, a package you did not attach) cannot load; `validate_component` and `render_preview` list them as warnings / `libraryProblems`.
4. A library that builds on another must be added **after** it: `react-dom/client` imports `react`, and when `react` is already in the deck that import is pointed at it, so both share one copy. Two copies of React give "invalid hook call". Add `react` first, then `react-dom/client`, and attach both. A library whose imports cannot be resolved this way is refused.

There is no build step: no JSX and no TypeScript. Use `React.createElement` (or vendor a template library). Start the app inside `deck.ready`:

```js
import React from "react";
import { createRoot } from "react-dom/client";

deck.ready(({ props }) => {
  const h = React.createElement;
  function Counter() {
    const [n, setN] = React.useState(props.start);
    return h("button", { onClick: () => setN(n + 1) }, "Clicked " + n);
  }
  createRoot(document.getElementById("app")).render(h(Counter));
});
```

with `html` `<div id="app"></div>`, `libs: ["react", "react-dom/client"]` and a `start` number prop. Check it with `validate_component` (`run: true`) before inserting it. `save_to_library` keeps a component's libraries with it and `import_from_library` brings them back. Libraries are code like the rest: the trust dialog lists them for whoever opens the deck, so mention them in your reply.

### Checking a component

- `validate_component` (with `deckId` + `componentId`, or the sources inline) is a **static** check: structure, prop schema, JavaScript syntax, likely sandbox mistakes (`warnings`), and what the trust dialog will flag. Passing it does not mean the script works. Inline fields next to `componentId` replace the stored ones, so you can check a revision before `update_component`.
- With previews enabled (see below), `validate_component` with `run: true` runs the component and returns `errors`, `console` output, whether the frame is `running`, and a picture. `render_preview` does the same for a whole slide or one element. Use them in a loop: change, preview, read `errors` and `console`, fix.

## Previews

`render_preview` and `validate_component` with `run: true` run the deck's code in a headless browser, so the person who set up the server must have enabled them (`DECKTECH_PREVIEW=1`). If they are off the tool says so; **do not try to work around it**, and tell the person what you could not verify. Pictures are PNGs (`width` 320 to 1920); `settleMs` is how long components run before the picture is taken (default 1000).

## Trust and files

- Code you write is untrusted. The server does not run it unless previews are enabled, and it never marks anything trusted. When a person opens your `.deck` in DeckTech, a dialog shows every component's code and flags (permissions, `eval`, network use, external addresses) and they decide whether it runs. Write plain, readable code, keep permissions empty, and say in your reply what each component does.
- Files are confined to the workspace folder. Paths are relative to it; paths outside it are refused.
- `open_deck` verifies a file completely and says why it is rejected.

## Reading errors

Errors are sentences meant for you. Common ones:

| Message contains | Do this |
|------------------|---------|
| `No deck "..." is open` | Use the `deckId` from `create_deck` / `open_deck` / `list_decks`. |
| `... does not exist` (slide, element, component, layout) | Ids come from tool results; call `get_deck` or `list_components`. |
| `Invalid component` / `The component is not valid and was not saved` | Read the listed problems (prop defaults out of range, duplicate keys, syntax error with line and column), fix, call again. |
| `"<label>" must be ...` | A prop value does not fit its type, range or options. |
| `not a settable property` | That property does not exist for this element type; see `describe_schema` topic `elements`. |
| `outside the workspace folder` | Use a path inside the workspace. |
| `alt text` | `add_image` needs a description or `decorative: true`. |
| `DECKTECH_PREVIEW=1` | Previews are off; continue without them and say so. |

## Not available

Sections, slide backgrounds and layout editing, importing a deck into another deck. Do not fake them with shapes if a code component or text would do better.
