# Decktech

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.2.3.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## MCP server for AI agents

`mcp/` holds a Model Context Protocol server that lets an agent build a deck: create it, add slides, text, images, shapes and **code components**, and export a `.deck` file that DeckTech opens. It works on files in one workspace folder (no running app needed). Design and limits: [ADR-013](docs/ADRs/ADR-013-mcp-server-for-agents.md), [arc42 5.9](docs/arc42/05-building-block-view.md).

```bash
npm install
npm run build:mcp        # writes dist-mcp/decktech-mcp.mjs (Node 20+)
npm run test:mcp         # tests of the server
```

Settings, given as environment variables in the client's configuration (the agent cannot change them):

| Variable | Meaning | Default |
|----------|---------|---------|
| `DECKTECH_WORKSPACE` | The only folder the server reads from and writes to (decks, images). | working directory |
| `DECKTECH_LIBRARY` | Folder of the component library (`<id>.json` files). | `<workspace>/.decktech/library` |

### Claude Code

```bash
claude mcp add decktech --env DECKTECH_WORKSPACE=/path/to/decks -- node /path/to/decktech/dist-mcp/decktech-mcp.mjs
```

or in a project `.mcp.json`:

```json
{
  "mcpServers": {
    "decktech": {
      "command": "node",
      "args": ["dist-mcp/decktech-mcp.mjs"],
      "env": { "DECKTECH_WORKSPACE": "decks" }
    }
  }
}
```

### Other clients

Any client that starts a stdio server works with the same `command`, `args` and `env`: Claude Desktop (`claude_desktop_config.json`, key `mcpServers`), VS Code (`.vscode/mcp.json`, key `servers`), Cursor (`.cursor/mcp.json`, key `mcpServers`).

### Tools

Start with `describe_schema` (topic `component-api` before writing a code component), then `create_deck`.

- Deck: `create_deck`, `open_deck`, `list_decks`, `close_deck`, `get_deck`, `set_deck_metadata`, `export_deck`, `undo`, `redo`
- Slides: `add_slide`, `duplicate_slide`, `delete_slide`, `move_slide`, `set_layout`, `set_speaker_notes`
- Elements: `add_text`, `set_text`, `add_image`, `add_shape`, `update_element`, `move_element`, `delete_element`, `set_z_order`, `set_alt_text`, `check_accessibility`
- Code components: `create_component`, `update_component`, `list_components`, `get_component`, `insert_code_element`, `update_code_element_props`, `detach_component`, `validate_component`, `save_to_library`, `import_from_library`

Code written by an agent is untrusted. The server only parses it and never runs it, so `validate_component` reports syntax and structure problems but not runtime errors, and there is no `render_preview` yet. A deck with code shows DeckTech's trust dialog when it is imported; review the code there before running it.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
