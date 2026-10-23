import { z } from 'zod';
import { generateId, resolveProps, type CodeEl, type ComponentDef, type Deck, type PropSpec } from '../../src/app/core/model';
import { AddCodeElement, SetComponentSource } from '../../src/app/core/store/commands';
import { AddComponent, DetachComponent, SetCodeProps, SetComponentDef, componentUses, type ComponentSettings } from '../../src/app/core/store/component-commands';
import { deepEqual, type Command } from '../../src/app/core/store/command';
import { checkComponentDef } from '../component-check';
import { elementOf, elementSummary, slideOf } from '../summary';
import { ToolError, defineTool } from '../tool';
import { deckId } from './deck';

const slideId = z.string().describe('Id of a slide (see get_deck).');
const componentId = z.string().describe('Id of a component definition of the deck (see list_components).');

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

const geometry = {
  x: z.number().optional().describe('Left edge on the 1920x1080 stage.'),
  y: z.number().optional().describe('Top edge on the 1920x1080 stage.'),
  w: z.number().min(0).optional().describe('Width.'),
  h: z.number().min(0).optional().describe('Height.'),
};

const given = <T extends object>(values: T): Partial<T> => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<T>;

function definitionOf(deck: Deck, id: string): ComponentDef {
  const def = deck.components.find((c) => c.id === id);
  if (!def) throw new ToolError(`Component "${id}" does not exist in this deck. Components: ${deck.components.map((c) => `${c.id} (${c.name})`).join(', ') || 'none'}`);
  return def;
}

/** Slides (ids and 1-based numbers) with code elements that use a definition. */
function usage(deck: Deck, id: string) {
  const slides: { slideId: string; number: number; elementIds: string[] }[] = [];
  deck.slides.forEach((slide, index) => {
    const elementIds = slide.elements.filter((e) => e.type === 'code' && e.componentId === id).map((e) => e.id);
    if (elementIds.length > 0) slides.push({ slideId: slide.id, number: index + 1, elementIds });
  });
  return { instances: componentUses(deck, id), slides };
}

const summaryOf = (deck: Deck, def: ComponentDef) => ({
  id: def.id,
  name: def.name,
  props: def.propSchema.map((p) => p.key),
  permissions: def.permissions,
  instances: componentUses(deck, def.id),
});

/** Refuses a definition whose script does not parse or that is structurally invalid, with every reason at once. */
function assertValid(deck: Deck, def: ComponentDef): string[] {
  const check = checkComponentDef(def, Object.keys(deck.assets));
  if (!check.valid) throw new ToolError(`The component is not valid and was not saved:\n- ${check.errors.join('\n- ')}`);
  return check.warnings;
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
      css: source('Stylesheet; theme colours are available as var(--deck-color-NAME), fonts as var(--deck-font-NAME).').default(''),
      js: source('ES module. Use deck.ready(({ props, theme, mode }) => { ... }) to start.').default(''),
      propSchema: z.array(propSpec).max(100).default([]).describe('Properties the author can edit per instance.'),
      permissions: z.array(permission).default([]).describe('Requested permissions; each is flagged to whoever opens the deck.'),
    }),
    run(workspace, { deckId, name, html, css, js, propSchema, permissions }) {
      const session = workspace.get(deckId);
      const def: ComponentDef = {
        id: generateId('component'),
        name: name.trim(),
        html,
        css,
        js,
        propSchema: propSchema as PropSpec[],
        permissions: [...new Set(permissions)],
        files: [],
        libs: [],
      };
      const warnings = assertValid(session.deck, def);
      const next = session.apply('AddComponent', new AddComponent(def));
      return { ...summaryOf(next, def), warnings };
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
    }),
    run(workspace, { deckId, componentId, name, html, css, js, propSchema, permissions }) {
      const session = workspace.get(deckId);
      const { deck } = session;
      const current = definitionOf(deck, componentId);
      const sources = given({ html, css, js });
      const settings: ComponentSettings = given({ name, propSchema: propSchema as PropSpec[] | undefined, permissions });
      if (Object.keys(sources).length === 0 && Object.keys(settings).length === 0) throw new ToolError('Give at least one field to change');
      const preview: ComponentDef = { ...current, ...sources, ...settings };
      const warnings = assertValid(deck, preview);
      const commands: Command[] = [];
      if (Object.keys(sources).length > 0) commands.push(new SetComponentSource(componentId, sources));
      if (Object.keys(settings).length > 0) commands.push(new SetComponentDef(componentId, settings));
      const next = session.apply('UpdateComponent', ...commands);
      const { instances, slides } = usage(next, componentId);
      return {
        ...summaryOf(next, definitionOf(next, componentId)),
        shared: instances > 1,
        usedOn: slides,
        warnings,
        ...(instances > 1 ? { note: `${instances} instances share this definition and all changed. detach_component(elementId) gives one instance its own copy.` } : {}),
      };
    },
  }),

  defineTool({
    name: 'list_components',
    title: 'List code components',
    description: 'Lists component definitions of a deck (source "deck", needs deckId) or of the file library (source "library").',
    input: z.object({ source: z.enum(['deck', 'library']).default('deck'), deckId: deckId.optional() }),
    readOnly: true,
    async run(workspace, { source: from, deckId }) {
      if (from === 'library') {
        return (await workspace.library.list()).map((e) => ({ id: e.def.id, name: e.def.name, props: e.def.propSchema.map((p) => p.key), permissions: e.def.permissions, savedAt: new Date(e.savedAt).toISOString() }));
      }
      if (deckId === undefined) throw new ToolError('Give a deckId to list the components of a deck');
      const { deck } = workspace.get(deckId);
      return deck.components.map((c) => summaryOf(deck, c));
    },
  }),

  defineTool({
    name: 'get_component',
    title: 'Get code component',
    description: 'Returns one component definition with its full source, property schema and permissions. For a deck component it also lists where it is used.',
    input: z.object({ source: z.enum(['deck', 'library']).default('deck'), deckId: deckId.optional(), componentId }),
    readOnly: true,
    async run(workspace, { source: from, deckId, componentId }) {
      if (from === 'library') {
        const entry = await workspace.library.read(componentId);
        if (!entry) throw new ToolError(`The library has no component "${componentId}". Use list_components with source "library".`);
        return { source: 'library', ...entry.def };
      }
      if (deckId === undefined) throw new ToolError('Give a deckId to read a component of a deck');
      const { deck } = workspace.get(deckId);
      return { source: 'deck', ...definitionOf(deck, componentId), ...usage(deck, componentId) };
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
      if (props && Object.keys(props).length > 0) commands.push(new SetCodeProps(insert.element.id, props));
      const next = session.apply('InsertCodeElement', ...commands);
      const placed = elementOf(next, insert.element.id).element as CodeEl;
      return { ...elementSummary(placed), props: resolveProps(def, placed.props) };
    },
  }),

  defineTool({
    name: 'update_code_element_props',
    title: 'Update code element props',
    description: 'Sets per-instance props of a code element. Each key must be declared by the component and each value must fit its type, range or options; otherwise nothing changes and the error names the prop.',
    input: z.object({ deckId, elementId: z.string().describe('Id of a code element.'), props: z.record(z.string(), z.unknown()) }),
    run(workspace, { deckId, elementId, props }) {
      const session = workspace.get(deckId);
      const next = session.apply('SetCodeProps', new SetCodeProps(elementId, props));
      const placed = elementOf(next, elementId).element as CodeEl;
      return { elementId, props: resolveProps(definitionOf(next, placed.componentId), placed.props) };
    },
  }),

  defineTool({
    name: 'detach_component',
    title: 'Detach code element (make unique)',
    description: 'Gives one code element its own copy of a shared component definition ("<name> (copy)"), so editing either no longer changes the other. Refused if the element is the only user of its definition.',
    input: z.object({ deckId, elementId: z.string().describe('Id of a code element that shares its component.') }),
    run(workspace, { deckId, elementId }) {
      const session = workspace.get(deckId);
      const command = new DetachComponent(elementId);
      const next = session.apply('DetachComponent', command);
      return summaryOf(next, definitionOf(next, command.newId));
    },
  }),

  defineTool({
    name: 'validate_component',
    title: 'Validate code component',
    description:
      'Checks a component without running it: structure and limits, property schema, JavaScript syntax (as an ES module), likely sandbox mistakes and what the trust dialog will flag. Give deckId + componentId for a component in a deck, or the sources inline. It does not execute the code, so runtime errors, console output and rendering are not covered (executed is always false).',
    input: z.object({
      deckId: deckId.optional(),
      componentId: componentId.optional(),
      html: source('Markup to check (inline).').optional(),
      css: source('Stylesheet to check (inline).').optional(),
      js: source('Script to check (inline).').optional(),
      propSchema: z.array(propSpec).max(100).optional(),
      permissions: z.array(permission).optional(),
    }),
    readOnly: true,
    run(workspace, { deckId, componentId, html, css, js, propSchema, permissions }) {
      if (componentId !== undefined) {
        if (deckId === undefined) throw new ToolError('Give the deckId that contains the component');
        const { deck } = workspace.get(deckId);
        return checkComponentDef(definitionOf(deck, componentId), Object.keys(deck.assets));
      }
      if (html === undefined && css === undefined && js === undefined) throw new ToolError('Give deckId + componentId, or at least one of html, css, js');
      const def: ComponentDef = {
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
      return checkComponentDef(def, []);
    },
  }),

  defineTool({
    name: 'save_to_library',
    title: 'Save component to library',
    description: 'Copies a component definition to the file library (a folder next to the workspace), so other decks can reuse it with import_from_library. Saving an id again replaces the entry. Components with asset files or vendored libraries are refused.',
    input: z.object({ deckId, componentId }),
    async run(workspace, { deckId, componentId }) {
      const def = definitionOf(workspace.get(deckId).deck, componentId);
      const entry = await workspace.library.save(def);
      return { id: entry.def.id, name: entry.def.name, savedAt: new Date(entry.savedAt).toISOString() };
    },
  }),

  defineTool({
    name: 'import_from_library',
    title: 'Import component from library',
    description:
      'Copies a library component into a deck as a new definition. If the deck already has the same id with identical content nothing is added; with different content the copy gets a fresh id (ADR-010). Then use insert_code_element.',
    input: z.object({ deckId, libraryId: z.string().describe('Id from list_components with source "library".') }),
    async run(workspace, { deckId, libraryId }) {
      const session = workspace.get(deckId);
      const entry = await workspace.library.read(libraryId);
      if (!entry) throw new ToolError(`The library has no component "${libraryId}". Use list_components with source "library".`);
      let def = entry.def;
      const taken = session.deck.components.find((c) => c.id === def.id);
      if (taken && !deepEqual(taken, def)) def = { ...def, id: generateId('component') };
      const warnings = assertValid(session.deck, def);
      const next = session.apply('ImportComponent', new AddComponent(def));
      return { ...summaryOf(next, def), warnings };
    },
  }),
];
