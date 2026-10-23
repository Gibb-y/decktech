import { z } from 'zod';
import {
  generateId,
  resolveProps,
  type CodeEl,
  type ComponentDef,
  type AssetRef,
  type Deck,
  type PropSpec,
} from '../../src/app/core/model';
import { AddAsset, AddCodeElement, SetComponentSource } from '../../src/app/core/store/commands';
import {
  AddComponent,
  DetachComponent,
  SetCodeProps,
  SetComponentDef,
  componentUses,
  type ComponentSettings,
} from '../../src/app/core/store/component-commands';
import { deepEqual, type Command } from '../../src/app/core/store/command';
import { isLibraryName } from '../../src/app/components/editor/vendor';
import { checkComponentDef } from '../component-check';
import { importProblems, resolveSpecifiers, specifierNames } from '../libraries';
import type { DeckSession } from '../workspace';
import { elementOf, elementSummary, slideOf } from '../summary';
import { ToolError, ToolImages, defineTool } from '../tool';
import { previewWidth, runtimeSummary, scratchDeckFor, settleMs } from './preview';
import { deckId } from './deck';
import { assertAssetBudget } from './elements';

const slideId = z.string().describe('Id of a slide (see get_deck).');
const componentId = z
  .string()
  .describe('Id of a component definition of the deck (see list_components).');

const MAX_SOURCE = 1_000_000;
const source = (what: string) => z.string().max(MAX_SOURCE).describe(what);

const propSpec = z.union([
  z.object({
    key: z.string().describe('Name the component reads from props.'),
    type: z.enum(['string', 'number', 'boolean', 'color', 'asset']),
    label: z.string().describe('Label in the properties panel.'),
    default: z.unknown().describe('Default value; must fit the type (and min/max for numbers).'),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    key: z.string(),
    type: z.literal('select'),
    label: z.string(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).min(1),
    default: z.string().describe('One of the option values.'),
  }),
]);

const permission = z.enum(['network', 'storage']);

const libsInput = z
  .array(z.string().min(1).max(300))
  .max(20)
  .describe(
    'Libraries the script may import, by name or assetId, from add_library_from_package / add_library_from_file. In the script import them by that name (import React from "react"); the server stores the asset id in its place, because that is what the sandbox resolves.',
  );

const geometry = {
  x: z.number().optional().describe('Left edge on the 1920x1080 stage.'),
  y: z.number().optional().describe('Top edge on the 1920x1080 stage.'),
  w: z.number().min(0).optional().describe('Width.'),
  h: z.number().min(0).optional().describe('Height.'),
};

const given = <T extends object>(values: T): Partial<T> =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<T>;

function definitionOf(deck: Deck, id: string): ComponentDef {
  const def = deck.components.find((c) => c.id === id);
  if (!def)
    throw new ToolError(
      `Component "${id}" does not exist in this deck. Components: ${deck.components.map((c) => `${c.id} (${c.name})`).join(', ') || 'none'}`,
    );
  return def;
}

/** Slides (ids and 1-based numbers) with code elements that use a definition. */
function usage(deck: Deck, id: string) {
  const slides: { slideId: string; number: number; elementIds: string[] }[] = [];
  deck.slides.forEach((slide, index) => {
    const elementIds = slide.elements
      .filter((e) => e.type === 'code' && e.componentId === id)
      .map((e) => e.id);
    if (elementIds.length > 0) slides.push({ slideId: slide.id, number: index + 1, elementIds });
  });
  return { instances: componentUses(deck, id), slides };
}

/** The libraries of a definition as the agent sees them: asset id, the name to import by (when this session added it) and size. */
const libsOf = (session: DeckSession | undefined, deck: Deck, def: ComponentDef) =>
  def.libs.map((id) => ({
    assetId: id,
    ...(session?.libraries.get(id) ?? {}),
    bytes: Object.hasOwn(deck.assets, id) ? deck.assets[id].size : 0,
  }));

const summaryOf = (deck: Deck, def: ComponentDef, session?: DeckSession) => ({
  id: def.id,
  name: def.name,
  props: def.propSchema.map((p) => p.key),
  permissions: def.permissions,
  libs: libsOf(session, deck, def),
  instances: componentUses(deck, def.id),
});

/**
 * Libraries by the names an agent gives them: an asset id of the deck, or the name or label of a
 * library this session added. Unknown or ambiguous entries are refused with the choices.
 */
function resolveLibs(session: DeckSession, entries: readonly string[]): string[] {
  const { deck } = session;
  const available = [...session.libraries]
    .filter(([id]) => Object.hasOwn(deck.assets, id))
    .map(([id, lib]) => ({ id, ...lib }));
  const choices = available.map((l) => l.label).join(', ') || 'none added yet';
  const ids = entries.map((entry) => {
    if (/^[0-9a-f]{64}$/.test(entry) && Object.hasOwn(deck.assets, entry)) return entry;
    const matches = available.filter((l) => l.name === entry || l.label === entry);
    if (matches.length === 1) return matches[0].id;
    throw new ToolError(
      matches.length > 1
        ? `"${entry}" names more than one library of this deck; use its assetId: ${matches.map((l) => `${l.label} = ${l.id}`).join(', ')}`
        : `"${entry}" is not a library of this deck. Libraries: ${choices}. Add one with add_library_from_package or add_library_from_file.`,
    );
  });
  return [...new Set(ids)];
}

/** Replaces the names of attached libraries in the script by the asset ids the runtime's import map is keyed by. */
const withResolvedImports = (session: DeckSession, js: string, libs: readonly string[]) =>
  resolveSpecifiers(js, specifierNames(session, libs).names).js;

/** A library that imports another vendored library (react-dom on react) needs that one attached too, or the import map cannot resolve it. */
function peerProblems(session: DeckSession, def: ComponentDef): string[] {
  const problems: string[] = [];
  for (const id of def.libs) {
    const bytes = session.assets.get(id);
    if (!bytes) continue;
    const text = new TextDecoder().decode(bytes);
    for (const m of new Set(text.match(/(?<=["'])[0-9a-f]{64}(?=["'])/g) ?? [])) {
      if (m === id || def.libs.includes(m) || !Object.hasOwn(session.deck.assets, m)) continue;
      const name = (id2: string) => session.libraries.get(id2)?.label ?? `${id2.slice(0, 12)}…`;
      problems.push(`The library ${name(id)} imports ${name(m)}, which is not in this component's libs, so the sandbox cannot load it; add ${name(m)} to libs.`);
    }
  }
  return problems;
}

/**
 * Refuses a definition whose script does not parse or that is structurally invalid, with every
 * reason at once. Warnings include scripts that import something the sandbox cannot resolve.
 */
function assertValid(session: DeckSession, def: ComponentDef, incoming: Iterable<string> = []): string[] {
  const assetIds = new Set([...Object.keys(session.deck.assets), ...incoming]);
  const check = checkComponentDef(def, assetIds);
  if (!check.valid)
    throw new ToolError(
      `The component is not valid and was not saved:\n- ${check.errors.join('\n- ')}`,
    );
  return [...check.warnings, ...importProblems(def, session, assetIds), ...peerProblems(session, def)];
}

export const componentTools = [
  defineTool({
    name: 'create_component',
    title: 'Create code component',
    description:
      'Creates a code component definition in the deck (it appears nowhere until insert_code_element). A component is a small web page: html, css and a JavaScript ES module, run in a sandboxed frame on the 1920x1080 stage. Read describe_schema topic "component-api" first. The script must parse; structural problems and syntax errors are returned together. Warnings list likely mistakes and the points the trust dialog will flag. The code is not executed here.',
    input: z.object({
      deckId,
      name: z.string().min(1).max(200),
      html: source('Markup placed in the frame body.').default(''),
      css: source(
        'Stylesheet; theme colours are available as var(--deck-color-NAME), fonts as var(--deck-font-NAME).',
      ).default(''),
      js: source(
        'ES module. Use deck.ready(({ props, theme, mode }) => { ... }) to start.',
      ).default(''),
      propSchema: z
        .array(propSpec)
        .max(100)
        .default([])
        .describe('Properties the author can edit per instance.'),
      permissions: z
        .array(permission)
        .default([])
        .describe('Requested permissions; each is flagged to whoever opens the deck.'),
      libs: libsInput.default([]),
    }),
    run(workspace, { deckId, name, html, css, js, propSchema, permissions, libs }) {
      const session = workspace.get(deckId);
      const attached = resolveLibs(session, libs);
      const def: ComponentDef = {
        id: generateId('component'),
        name: name.trim(),
        html,
        css,
        js: withResolvedImports(session, js, attached),
        propSchema: propSchema as PropSpec[],
        permissions: [...new Set(permissions)],
        files: [],
        libs: attached,
      };
      const warnings = assertValid(session, def);
      const next = session.apply('AddComponent', new AddComponent(def));
      return { ...summaryOf(next, def, session), warnings };
    },
  }),

  defineTool({
    name: 'update_component',
    title: 'Update code component',
    description:
      'Changes the sources, name, property schema or permissions of a component definition. Omitted fields stay. Every instance of the definition changes with it, so the result says how many instances share it and on which slides; call detach_component first on an instance that should keep the old version. Instance props are not rewritten; a prop that no longer fits falls back to its default.',
    input: z.object({
      deckId,
      componentId,
      name: z.string().min(1).max(200).optional(),
      html: source('Replacement markup.').optional(),
      css: source('Replacement stylesheet.').optional(),
      js: source('Replacement ES module.').optional(),
      propSchema: z.array(propSpec).max(100).optional(),
      permissions: z.array(permission).optional(),
      libs: libsInput.optional().describe(`${libsInput.description} Replaces the whole list; omit to keep the current libraries.`),
    }),
    run(workspace, { deckId, componentId, name, html, css, js, propSchema, permissions, libs }) {
      const session = workspace.get(deckId);
      const { deck } = session;
      const current = definitionOf(deck, componentId);
      const attached = libs === undefined ? current.libs : resolveLibs(session, libs);
      const sources = given({
        html,
        css,
        js: js === undefined ? undefined : withResolvedImports(session, js, attached),
      });
      const settings: ComponentSettings = given({
        name,
        propSchema: propSchema as PropSpec[] | undefined,
        permissions,
        libs: libs === undefined ? undefined : attached,
      });
      if (Object.keys(sources).length === 0 && Object.keys(settings).length === 0)
        throw new ToolError('Give at least one field to change');
      const preview: ComponentDef = { ...current, ...sources, ...settings };
      const warnings = assertValid(session, preview);
      const commands: Command[] = [];
      if (Object.keys(sources).length > 0)
        commands.push(new SetComponentSource(componentId, sources));
      if (Object.keys(settings).length > 0)
        commands.push(new SetComponentDef(componentId, settings));
      const next = session.apply('UpdateComponent', ...commands);
      const { instances, slides } = usage(next, componentId);
      return {
        ...summaryOf(next, definitionOf(next, componentId), session),
        shared: instances > 1,
        usedOn: slides,
        warnings,
        ...(instances > 1
          ? {
              note: `${instances} instances share this definition and all changed. detach_component(elementId) gives one instance its own copy.`,
            }
          : {}),
      };
    },
  }),

  defineTool({
    name: 'list_components',
    title: 'List code components',
    description:
      'Lists component definitions of a deck (source "deck", needs deckId) or of the file library (source "library").',
    input: z.object({
      source: z.enum(['deck', 'library']).default('deck'),
      deckId: deckId.optional(),
    }),
    readOnly: true,
    async run(workspace, { source: from, deckId }) {
      if (from === 'library') {
        return (await workspace.library.list()).map((e) => ({
          id: e.def.id,
          name: e.def.name,
          props: e.def.propSchema.map((p) => p.key),
          permissions: e.def.permissions,
          savedAt: new Date(e.savedAt).toISOString(),
        }));
      }
      if (deckId === undefined)
        throw new ToolError('Give a deckId to list the components of a deck');
      const session = workspace.get(deckId);
      return session.deck.components.map((c) => summaryOf(session.deck, c, session));
    },
  }),

  defineTool({
    name: 'get_component',
    title: 'Get code component',
    description:
      'Returns one component definition with its full source, property schema and permissions. For a deck component it also lists where it is used.',
    input: z.object({
      source: z.enum(['deck', 'library']).default('deck'),
      deckId: deckId.optional(),
      componentId,
    }),
    readOnly: true,
    async run(workspace, { source: from, deckId, componentId }) {
      if (from === 'library') {
        const entry = await workspace.library.read(componentId);
        if (!entry)
          throw new ToolError(
            `The library has no component "${componentId}". Use list_components with source "library".`,
          );
        return { source: 'library', ...entry.def };
      }
      if (deckId === undefined) throw new ToolError('Give a deckId to read a component of a deck');
      const session = workspace.get(deckId);
      const { deck } = session;
      const def = definitionOf(deck, componentId);
      return {
        source: 'deck',
        ...def,
        libs: libsOf(session, deck, def),
        ...usage(deck, componentId),
      };
    },
  }),

  defineTool({
    name: 'insert_code_element',
    title: 'Insert code element',
    description:
      'Places an instance of a component on a slide, on top of the other elements. props set per-instance values of the declared properties (checked against the schema); the rest start at the declared defaults. Position and size are on the 1920x1080 stage (default 960x540 at 480,270).',
    input: z.object({
      deckId,
      slideId,
      componentId,
      props: z.record(z.string(), z.unknown()).optional().describe('Values by prop key.'),
      ...geometry,
    }),
    run(workspace, { deckId, slideId, componentId, props, x, y, w, h }) {
      const session = workspace.get(deckId);
      const { deck } = session;
      slideOf(deck, slideId);
      const def = definitionOf(deck, componentId);
      const insert = new AddCodeElement(slideId, def, given({ x, y, w, h }));
      const commands: Command[] = [insert];
      if (props && Object.keys(props).length > 0)
        commands.push(new SetCodeProps(insert.element.id, props));
      const next = session.apply('InsertCodeElement', ...commands);
      const placed = elementOf(next, insert.element.id).element as CodeEl;
      return { ...elementSummary(placed), props: resolveProps(def, placed.props) };
    },
  }),

  defineTool({
    name: 'update_code_element_props',
    title: 'Update code element props',
    description:
      'Sets per-instance props of a code element. Each key must be declared by the component and each value must fit its type, range or options; otherwise nothing changes and the error names the prop.',
    input: z.object({
      deckId,
      elementId: z.string().describe('Id of a code element.'),
      props: z.record(z.string(), z.unknown()),
    }),
    run(workspace, { deckId, elementId, props }) {
      const session = workspace.get(deckId);
      const next = session.apply('SetCodeProps', new SetCodeProps(elementId, props));
      const placed = elementOf(next, elementId).element as CodeEl;
      return {
        elementId,
        props: resolveProps(definitionOf(next, placed.componentId), placed.props),
      };
    },
  }),

  defineTool({
    name: 'detach_component',
    title: 'Detach code element (make unique)',
    description:
      'Gives one code element its own copy of a shared component definition ("<name> (copy)"), so editing either no longer changes the other. Refused if the element is the only user of its definition.',
    input: z.object({
      deckId,
      elementId: z.string().describe('Id of a code element that shares its component.'),
    }),
    run(workspace, { deckId, elementId }) {
      const session = workspace.get(deckId);
      const command = new DetachComponent(elementId);
      const next = session.apply('DetachComponent', command);
      return summaryOf(next, definitionOf(next, command.newId), session);
    },
  }),

  defineTool({
    name: 'validate_component',
    title: 'Validate code component',
    description:
      'Checks a component: structure and limits, property schema, JavaScript syntax (as an ES module), likely sandbox mistakes and what the trust dialog will flag. Give deckId + componentId for a component in a deck (inline fields then replace the stored ones, to check a revision), or the sources inline. By default nothing is executed (executed: false). With run: true, and only if the person who configured the server enabled previews (DECKTECH_PREVIEW=1), the valid component is also run full-stage in the sandbox of DeckTech in a headless browser: you get the errors it raised, what it logged, whether its frame came up, and a picture.',
    input: z.object({
      deckId: deckId.optional(),
      componentId: componentId.optional(),
      html: source('Markup to check (inline).').optional(),
      css: source('Stylesheet to check (inline).').optional(),
      js: source('Script to check (inline).').optional(),
      propSchema: z.array(propSpec).max(100).optional(),
      permissions: z.array(permission).optional(),
      libs: libsInput.optional().describe('Libraries to check with (only together with componentId); default: the stored ones.'),
      run: z
        .boolean()
        .default(false)
        .describe(
          'Also run the component in the sandbox and report errors, console output and a picture (needs previews enabled).',
        ),
      width: previewWidth,
      settleMs,
    }),
    readOnly: true,
    async run(
      workspace,
      { deckId, componentId, html, css, js, propSchema, permissions, libs, run, width, settleMs },
    ) {
      let def: ComponentDef;
      let assetIds: string[] = [];
      let base: Deck | undefined;
      let libraryProblems: string[] = [];
      let assets: ReadonlyMap<string, Uint8Array> = new Map();
      if (componentId !== undefined) {
        if (deckId === undefined)
          throw new ToolError('Give the deckId that contains the component');
        const session = workspace.get(deckId);
        const { deck } = session;
        // Inline fields replace the stored ones, so a revision can be checked before update_component.
        const stored = definitionOf(deck, componentId);
        const attached = libs === undefined ? stored.libs : resolveLibs(session, libs);
        const revised: ComponentDef = {
          ...stored,
          ...given({
            html,
            css,
            js: js === undefined ? undefined : withResolvedImports(session, js, attached),
            propSchema: propSchema as PropSpec[] | undefined,
            permissions,
          }),
          libs: attached,
        };
        def = revised;
        libraryProblems = importProblems(revised, session, new Set(Object.keys(deck.assets)));
        assetIds = Object.keys(deck.assets);
        base = deck;
        assets = workspace.get(deckId).assets;
      } else {
        if (deckId !== undefined)
          throw new ToolError(
            'deckId is only used together with componentId; remove it to check inline sources',
          );
        if (libs !== undefined && libs.length > 0)
          throw new ToolError('libs can only be checked together with deckId and componentId');
        if (html === undefined && css === undefined && js === undefined)
          throw new ToolError('Give deckId + componentId, or at least one of html, css, js');
        def = {
          id: 'cp_inline',
          name: 'Inline check',
          html: html ?? '',
          css: css ?? '',
          js: js ?? '',
          propSchema: (propSchema ?? []) as PropSpec[],
          permissions: [...new Set(permissions ?? [])],
          files: [],
          libs: [],
        };
      }
      const check = checkComponentDef(def, assetIds);
      check.warnings.push(...libraryProblems);
      if (!run) return check;
      if (!check.valid) return { ...check, runtime: 'not run: fix the errors above first' };
      const problem = workspace.previewer.problem();
      if (problem)
        throw new ToolError(
          `${problem} The static result: ${JSON.stringify({ valid: check.valid, warnings: check.warnings })}`,
        );
      const scratch = scratchDeckFor(def, base);
      const result = await workspace.previewer.render({
        deck: scratch.deck,
        slideId: scratch.slideId,
        assets,
        width,
        settleMs,
      });
      const runtime = runtimeSummary(result);
      return new ToolImages(
        {
          ...check,
          executed: true,
          ok: check.valid && runtime.errors.length === 0 && runtime.frames.every((f) => f.running),
          runtime,
        },
        [result.png],
      );
    },
  }),

  defineTool({
    name: 'save_to_library',
    title: 'Save component to library',
    description:
      'Copies a component definition to the file library (a folder of files, by default .decktech/library inside the workspace folder), so other decks can reuse it with import_from_library. Saving an id again replaces the entry. Vendored libraries and asset files the component reads are saved with it, so import_from_library brings them along.',
    input: z.object({ deckId, componentId }),
    async run(workspace, { deckId, componentId }) {
      const session = workspace.get(deckId);
      const def = definitionOf(session.deck, componentId);
      const held = new Map<string, { ref: AssetRef; bytes: Uint8Array }>();
      for (const id of [...def.files, ...def.libs]) {
        const bytes = session.assets.get(id);
        if (Object.hasOwn(session.deck.assets, id) && bytes)
          held.set(id, { ref: session.deck.assets[id], bytes });
      }
      const entry = await workspace.library.save(def, held, session.libraries);
      return {
        id: entry.def.id,
        name: entry.def.name,
        savedAt: new Date(entry.savedAt).toISOString(),
      };
    },
  }),

  defineTool({
    name: 'import_from_library',
    title: 'Import component from library',
    description:
      'Copies a library component into a deck as a new definition. If the deck already has the same id with identical content nothing is added; with different content the copy gets a fresh id (ADR-010). Then use insert_code_element.',
    input: z.object({
      deckId,
      libraryId: z.string().describe('Id from list_components with source "library".'),
    }),
    async run(workspace, { deckId, libraryId }) {
      const session = workspace.get(deckId);
      const entry = await workspace.library.read(libraryId);
      if (!entry)
        throw new ToolError(
          `The library has no component "${libraryId}". Use list_components with source "library".`,
        );
      let def = entry.def;
      const taken = session.deck.components.find((c) => c.id === def.id);
      if (taken && !deepEqual(taken, def)) def = { ...def, id: generateId('component') };
      // The bytes of its libraries and files come from the library folder, checked against their hash.
      const incoming = new Map<string, Uint8Array>();
      for (const id of new Set([...def.files, ...def.libs])) {
        if (Object.hasOwn(session.deck.assets, id) && session.assets.has(id)) continue;
        const bytes = await workspace.library.readAsset(id);
        if (!bytes)
          throw new ToolError(
            `The library entry "${libraryId}" is damaged: the file for its asset ${id} is missing or does not match its hash`,
          );
        incoming.set(id, bytes);
      }
      assertAssetBudget(session, [...incoming.values()].reduce((sum, b) => sum + b.length, 0));
      const adds = [...incoming.keys()].map((id) => new AddAsset(id, entry.assets[id]));
      const warnings = assertValid(session, def, incoming.keys());
      const next = session.apply('ImportComponent', ...adds, new AddComponent(def));
      for (const [id, bytes] of incoming) session.assets.set(id, bytes);
      // The names come from a file anyone can edit: keep only well-formed ones for libraries of this component.
      for (const id of def.libs) {
        const lib = Object.hasOwn(entry.names ?? {}, id) ? entry.names![id] : undefined;
        if (lib && typeof lib.name === 'string' && typeof lib.label === 'string' && lib.label.length <= 300 && isLibraryName(lib.name) && !session.libraries.has(id))
          session.libraries.set(id, { name: lib.name, label: lib.label });
      }
      return { ...summaryOf(next, def, session), warnings };
    },
  }),
];
