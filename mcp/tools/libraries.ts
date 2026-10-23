import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import {
  MAX_LIBRARY_BYTES,
  checkLibraryText,
  fetchLibrary,
  isLibraryName,
} from '../../src/app/components/editor/vendor';
import { assetRef, sha256Hex } from '../../src/app/core/persistence/assets';
import { AddAsset } from '../../src/app/core/store/commands';
import { resolveInside } from '../paths';
import { ToolError, defineTool } from '../tool';
import type { DeckSession, VendoredLibrary } from '../workspace';
import { deckId } from './deck';
import { assertAssetBudget } from './elements';

const JAVASCRIPT = 'text/javascript';

/** Libraries of the session that the deck still holds, by the name a later library may build on (`react`). */
function peersOf(session: DeckSession): Map<string, string> {
  const peers = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [id, lib] of session.libraries) {
    if (!Object.hasOwn(session.deck.assets, id)) continue;
    if (peers.has(lib.name) && peers.get(lib.name) !== id) ambiguous.add(lib.name);
    peers.set(lib.name, id);
  }
  for (const name of ambiguous) peers.delete(name);
  return peers;
}

/** Stores the bytes as an asset of the deck (once: the id is the content hash) and remembers the name. */
async function store(session: DeckSession, bytes: Uint8Array, lib: VendoredLibrary): Promise<string> {
  if (bytes.length > MAX_LIBRARY_BYTES) throw new ToolError('The library is larger than 5 MiB');
  const id = await sha256Hex(bytes as BufferSource);
  if (!(Object.hasOwn(session.deck.assets, id) && session.assets.has(id)))
    assertAssetBudget(session, bytes.length);
  session.apply('AddLibrary', new AddAsset(id, assetRef(id, JAVASCRIPT, bytes.length)));
  // Bytes are kept only once the deck accepted the asset, so a refused change leaves nothing behind.
  session.assets.set(id, bytes);
  session.libraries.set(id, lib);
  return id;
}

const reply = (id: string, lib: VendoredLibrary, bytes: number, shared: string[]) => ({
  assetId: id,
  name: lib.name,
  label: lib.label,
  bytes,
  importAs: lib.name,
  ...(shared.length > 0 ? { sharesInstanceWith: shared } : {}),
  next: `Attach it with libs: ["${lib.name}"] on create_component or update_component, then write import ... from "${lib.name}" in the component script (the server replaces the name with the asset id when it saves the component).`,
});

export const libraryTools = [
  defineTool({
    name: 'add_library_from_package',
    title: 'Add a library from an npm package',
    description:
      'Downloads a self-contained ES module build of an npm package (esm.sh, bundled, at most 5 MiB) and stores it in the deck, so a code component can import it offline. The download happens here, not in the sandbox, and needs a network connection. Returns the assetId and the name to import it by. The library is not attached to a component until you list it in libs of create_component / update_component. If the package builds on another one (react-dom builds on react), add that other one FIRST: its import is then pointed at the vendored copy so both share one instance (two copies of React break hooks). A subpath such as "react-dom/client" is allowed. Libraries are untrusted code: whoever opens the exported deck sees them in the trust dialog.',
    input: z.object({
      deckId,
      package: z
        .string()
        .min(1)
        .max(300)
        .describe('npm package name, optionally with a subpath: "react", "react-dom/client", "@observablehq/plot".'),
      version: z
        .string()
        .max(64)
        .default('latest')
        .describe('Exact version, e.g. "19.3.1". Prefer an exact version over "latest" so the deck is reproducible.'),
    }),
    async run(workspace, { deckId, package: pkg, version }) {
      const session = workspace.get(deckId);
      const fetched = await fetchLibrary(pkg, version, workspace.fetcher, peersOf(session));
      if (!fetched.ok) throw new ToolError(fetched.error);
      const bytes = new Uint8Array(await fetched.value.blob.arrayBuffer());
      const lib = { name: pkg.trim(), label: fetched.value.label };
      const id = await store(session, bytes, lib);
      return reply(id, lib, bytes.length, fetched.value.shared);
    },
  }),

  defineTool({
    name: 'add_library_from_file',
    title: 'Add a library from a file',
    description:
      'Stores a JavaScript module file from the workspace folder (.js or .mjs, at most 5 MiB, self-contained: no imports from the network) in the deck as a library for code components. name is what components import it by. Use this when the package download is not possible (offline, or a custom build). Imports of a library already added with this server are resolved to it like in add_library_from_package. Returns the assetId; attach it with libs on create_component / update_component.',
    input: z.object({
      deckId,
      path: z.string().min(1).describe('Module file, relative to the workspace folder.'),
      name: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe('Name to import the library by (an npm-style name such as "htm" or "my-lib"). Default: the file name without its extension.'),
    }),
    async run(workspace, { deckId, path, name }) {
      const session = workspace.get(deckId);
      if (!/^\.m?js$/i.test(extname(path)))
        throw new ToolError(`"${path}" is not a JavaScript module; use a .js or .mjs file`);
      const libName = (name ?? basename(path, extname(path))).trim();
      if (!isLibraryName(libName))
        throw new ToolError(
          `"${libName}" cannot be used as a library name: use an npm-style name (lower-case letters, digits, "-", "_" or ".", optionally scoped or with a subpath)`,
        );
      const full = resolveInside(workspace.root, path);
      let size: number;
      try {
        size = (await stat(full)).size;
      } catch {
        throw new ToolError(`The file "${path}" does not exist`);
      }
      if (size > MAX_LIBRARY_BYTES) throw new ToolError('The file is larger than 5 MiB');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(full));
      } catch {
        throw new ToolError(`"${path}" is not UTF-8 text`);
      }
      const checked = checkLibraryText(text, peersOf(session));
      if (!checked.ok) throw new ToolError(checked.error);
      const bytes = new TextEncoder().encode(checked.value);
      const lib = { name: libName, label: libName };
      const id = await store(session, bytes, lib);
      return reply(id, lib, bytes.length, []);
    },
  }),
];
