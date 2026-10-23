import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { BUILT_IN_THEMES, createDeck, createTheme } from '../../src/app/core/model';
import type { Command } from '../../src/app/core/store/command';
import { SetDeckTitle, SetTheme } from '../../src/app/core/store/commands';
import { DEFAULT_ARCHIVE_LIMITS } from '../../src/app/library/archive/format';
import { readArchive } from '../../src/app/library/archive/reader';
import { writeArchive } from '../../src/app/library/archive/writer';
import { resolveInside } from '../paths';
import { deckOutline } from '../summary';
import { ToolError, defineTool } from '../tool';

export const deckId = z.string().describe('Id of an open deck (from create_deck, open_deck or list_decks).');
const themeIds = BUILT_IN_THEMES.map((t) => t.id) as [string, ...string[]];

/** What an agent must know about a deck that came from a file. */
const UNTRUSTED_NOTE =
  'This deck came from a file and has code components. The server only reads their source and never runs it. Whoever opens an exported copy in DeckTech is asked to review the code first (trust prompt).';

export const deckTools = [
  defineTool({
    name: 'create_deck',
    title: 'Create deck',
    description: 'Creates a new deck with one empty slide on the Blank layout and opens it. Returns the deck id to pass to every other tool.',
    input: z.object({
      title: z.string().min(1).max(1000).optional().describe('Deck title; "Untitled deck" when omitted.'),
      theme: z.enum(themeIds).optional().describe('Built-in theme; "light" when omitted.'),
    }),
    run(workspace, { title, theme }) {
      const deck = createDeck(title?.trim() || undefined);
      const { deck: stored } = workspace.add(theme ? { ...deck, theme: createTheme(theme) } : deck);
      return deckOutline(stored);
    },
  }),

  defineTool({
    name: 'open_deck',
    title: 'Open deck file',
    description:
      'Reads a .deck file from the workspace folder and opens it for editing. The file is verified completely (size limits, hashes, schema) and a rejected file is reported with the reason. A deck with code components is flagged: its code is untrusted and is never run by this server.',
    input: z.object({ path: z.string().min(1).describe('Path of the .deck file, relative to the workspace folder.') }),
    async run(workspace, { path }) {
      const full = resolveInside(workspace.root, path);
      let size: number;
      try {
        size = (await stat(full)).size;
      } catch {
        throw new ToolError(`The file "${path}" does not exist`);
      }
      if (size > DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes) {
        throw new ToolError(`The file is too large to open (limit ${DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes / 1024 / 1024} MiB)`);
      }
      const read = await readArchive(new Uint8Array(await readFile(full)));
      if (!read.ok) throw new ToolError(`This file cannot be opened. ${read.error.message}`);
      const { deck, assets, hasCode, migrated } = read.value;
      const bytes = new Map([...assets].map(([id, a]) => [id, a.bytes]));
      const added = workspace.add(deck, bytes);
      return { ...deckOutline(added.deck), hasCode, migrated, ...(hasCode ? { note: UNTRUSTED_NOTE } : {}) };
    },
  }),

  defineTool({
    name: 'list_decks',
    title: 'List open decks',
    description: 'Lists the decks open in this server.',
    input: z.object({}),
    readOnly: true,
    run(workspace) {
      return workspace.list().map((s) => ({ deckId: s.deck.id, title: s.deck.title, slides: s.deck.slides.length, canUndo: s.canUndo, canRedo: s.canRedo }));
    },
  }),

  defineTool({
    name: 'close_deck',
    title: 'Close deck',
    description: 'Closes an open deck and frees its memory. Unexported changes are lost.',
    input: z.object({ deckId }),
    run(workspace, { deckId }) {
      workspace.close(deckId);
      return { closed: deckId };
    },
  }),

  defineTool({
    name: 'get_deck',
    title: 'Get deck',
    description:
      'Reads a deck. detail "outline" (default) lists slides with their elements (id, type, geometry, a one-line summary), components with their instance counts and layouts. detail "full" returns the whole document as JSON, including component source code.',
    input: z.object({ deckId, detail: z.enum(['outline', 'full']).default('outline') }),
    readOnly: true,
    run(workspace, { deckId, detail }) {
      const { deck } = workspace.get(deckId);
      return detail === 'full' ? deck : deckOutline(deck);
    },
  }),

  defineTool({
    name: 'set_deck_metadata',
    title: 'Set deck title and theme',
    description:
      'Renames the deck and/or switches it to a built-in theme. Switching the theme restyles every element that uses theme colour tokens; custom colours stay. Give at least one field.',
    input: z.object({ deckId, title: z.string().min(1).max(1000).optional(), theme: z.enum(themeIds).optional() }),
    run(workspace, { deckId, title, theme }) {
      if (title === undefined && theme === undefined) throw new ToolError('Give a title, a theme or both');
      const session = workspace.get(deckId);
      const commands: Command[] = [];
      if (title !== undefined) commands.push(new SetDeckTitle(title));
      if (theme !== undefined) {
        // Colour tokens that a custom theme added stay, as in the theme picker.
        const next = createTheme(theme);
        const kept = Object.fromEntries(Object.entries(session.deck.theme.colors).filter(([k]) => !Object.hasOwn(next.colors, k)));
        const fonts = session.deck.theme.fontFaces ? { fonts: session.deck.theme.fonts, fontFaces: session.deck.theme.fontFaces } : {};
        commands.push(new SetTheme({ ...next, colors: { ...next.colors, ...kept }, ...fonts }));
      }
      const deck = session.apply('SetDeckMetadata', ...commands);
      return { deckId, title: deck.title, theme: theme ?? 'unchanged' };
    },
  }),

  defineTool({
    name: 'export_deck',
    title: 'Export deck file',
    description:
      'Writes the deck as a .deck file (a ZIP, ADR-007) inside the workspace folder. DeckTech opens it with its import: a deck with code components shows the trust prompt before any code runs. Refuses to overwrite an existing file unless overwrite is true.',
    input: z.object({
      deckId,
      path: z.string().min(1).regex(/\.deck$/i, 'must end in .deck').describe('Target path relative to the workspace folder, e.g. "talk.deck".'),
      overwrite: z.boolean().default(false),
    }),
    async run(workspace, { deckId, path, overwrite }) {
      const session = workspace.get(deckId);
      const full = resolveInside(workspace.root, path);
      const packed = await writeArchive(session.deck, session.assets);
      if (!packed.ok) throw new ToolError(`The deck cannot be exported. ${packed.error.message}`);
      await mkdir(dirname(full), { recursive: true });
      try {
        await writeFile(full, packed.value, { flag: overwrite ? 'w' : 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ToolError(`"${path}" exists already; choose another name or pass overwrite: true`);
        throw e;
      }
      const components = session.deck.components.length;
      return { path, bytes: packed.value.length, slides: session.deck.slides.length, components, hasCode: components > 0 };
    },
  }),

  defineTool({
    name: 'undo',
    title: 'Undo',
    description: 'Undoes the last change to a deck (every tool call that changes a deck is one step, 200 steps are kept).',
    input: z.object({ deckId }),
    run(workspace, { deckId }) {
      const session = workspace.get(deckId);
      return { undone: session.undo(), canUndo: session.canUndo, canRedo: session.canRedo };
    },
  }),

  defineTool({
    name: 'redo',
    title: 'Redo',
    description: 'Redoes the last undone change.',
    input: z.object({ deckId }),
    run(workspace, { deckId }) {
      const session = workspace.get(deckId);
      return { redone: session.redo(), canUndo: session.canUndo, canRedo: session.canRedo };
    },
  }),
];
