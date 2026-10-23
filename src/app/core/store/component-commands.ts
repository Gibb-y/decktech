import { generateId, propValueProblem, type CodeEl, type ComponentDef, type Deck, type Element } from '../model';
import { CommandError, deepEqual, findElement, resultOf, updateElements, type Command, type CommandResult } from './command';
import { checkComponent, type GestureOptions } from './commands';

const MAX_NAME = 200;

/** The settings of a definition that are not its sources (those are `SetComponentSource`). */
export type ComponentSettings = Partial<Pick<ComponentDef, 'name' | 'propSchema' | 'permissions' | 'files' | 'libs'>>;

function definitionOf(deck: Deck, componentId: string): { def: ComponentDef; index: number } {
  const index = deck.components.findIndex((c) => c.id === componentId);
  if (index < 0) throw new CommandError(`Component "${componentId}" does not exist`);
  return { def: deck.components[index], index };
}

/**
 * Edits the name, prop schema, permissions and asset lists of a definition; omitted settings stay.
 * The result must pass `validateComponent` (prop specs, permissions, `files` and `libs` that exist
 * in the deck), so a bad edit throws and leaves the deck as it was. Every instance of the
 * definition changes with it (ADR-010); instance props are not rewritten, stale ones are ignored
 * by the host (8.1).
 */
export class SetComponentDef implements Command {
  readonly name = 'SetComponentDef';

  constructor(
    readonly componentId: string,
    readonly settings: ComponentSettings,
  ) {}

  do(deck: Deck): CommandResult {
    const { def, index } = definitionOf(deck, this.componentId);
    const s = this.settings;
    const name = s.name === undefined ? def.name : s.name.trim();
    if (name.length === 0 || name.length > MAX_NAME) throw new CommandError(`The component name must be 1 to ${MAX_NAME} characters`);
    const next: ComponentDef = {
      ...def,
      name,
      propSchema: s.propSchema === undefined ? def.propSchema : structuredClone(s.propSchema),
      permissions: s.permissions === undefined ? def.permissions : [...new Set(s.permissions)],
      files: s.files === undefined ? def.files : [...new Set(s.files)],
      libs: s.libs === undefined ? def.libs : [...new Set(s.libs)],
    };
    if (deepEqual(next, def)) return resultOf(deck, deck);
    checkComponent(deck, next);
    return resultOf(deck, { ...deck, components: deck.components.map((c, i) => (i === index ? next : c)) });
  }
}

/**
 * Sets declared props of one code element. Every key must be in the component's `propSchema` and
 * every value must fit its type, range or options (`propValueProblem`), asset props must name an
 * asset of the deck (or be empty); anything else throws and nothing changes. Unlike `SetProps`,
 * which leaves structured values to the editor, this is the checked path for per-instance data.
 */
export class SetCodeProps implements Command {
  readonly name = 'SetCodeProps';
  readonly coalesceKey?: string;

  constructor(
    readonly elementId: string,
    readonly changes: Readonly<Record<string, unknown>>,
    options: GestureOptions = {},
  ) {
    this.coalesceKey = options.coalesceKey;
  }

  do(deck: Deck): CommandResult {
    return resultOf(
      deck,
      updateElements(deck, [this.elementId], (e) => {
        if (e.type !== 'code') throw new CommandError(`Element "${e.id}" is a ${e.type} element, not a code component`);
        const { def } = definitionOf(deck, e.componentId);
        let props: Record<string, unknown> | undefined;
        for (const [key, value] of Object.entries(this.changes)) {
          const spec = def.propSchema.find((p) => p.key === key);
          if (!spec) throw new CommandError(`"${key}" is not a prop of component "${def.name}"`);
          const problem = propValueProblem(spec, value);
          if (problem) throw new CommandError(`"${spec.label}" must be ${problem}`);
          if (spec.type === 'asset' && value !== '' && !Object.hasOwn(deck.assets, value as string)) {
            throw new CommandError(`"${spec.label}" names an asset that is not in the deck`);
          }
          if (Object.hasOwn(e.props, key) && e.props[key] === value) continue;
          props ??= { ...e.props };
          props[key] = value;
        }
        return props ? ({ ...e, props } satisfies CodeEl) : e;
      }),
    );
  }
}

/** How many code elements use `componentId`, in the whole deck. */
export function componentUses(deck: Deck, componentId: string): number {
  let uses = 0;
  for (const slide of deck.slides) for (const e of slide.elements) if (e.type === 'code' && e.componentId === componentId) uses++;
  return uses;
}

/**
 * "Detach": gives one code element its own copy of its definition (fresh id, name suffixed
 * " (copy)", sources and settings equal), so editing either no longer touches the other
 * (ADR-010). The id is made at construction, so replaying the recorded patch is deterministic.
 * Refused when the element is the only user: it is already independent and a copy would only
 * leave an unused definition behind.
 */
export class DetachComponent implements Command {
  readonly name = 'DetachComponent';
  readonly newId = generateId('component');

  constructor(readonly elementId: string) {}

  do(deck: Deck): CommandResult {
    const element: Element | undefined = findElement(deck, this.elementId);
    if (!element) throw new CommandError(`Element "${this.elementId}" does not exist`);
    if (element.type !== 'code') throw new CommandError(`Element "${element.id}" is a ${element.type} element, not a code component`);
    const { def } = definitionOf(deck, element.componentId);
    if (componentUses(deck, def.id) < 2) throw new CommandError('This component is not shared; it is already independent');
    const copy: ComponentDef = { ...structuredClone(def), id: this.newId, name: `${def.name} (copy)`.slice(0, MAX_NAME) };
    const withCopy = { ...deck, components: [...deck.components, copy] };
    return resultOf(deck, updateElements(withCopy, [element.id], (e) => ({ ...(e as CodeEl), componentId: copy.id })));
  }
}

/**
 * Adds a definition to the deck without placing an element (the MCP server creates components
 * before it uses them). An identical definition under the same id is a no-op; a different one is
 * an error, use `SetComponentSource` / `SetComponentDef` to edit it. The definition must validate,
 * so its `files` and `libs` have to be assets of the deck.
 */
export class AddComponent implements Command {
  readonly name = 'AddComponent';

  constructor(readonly component: ComponentDef) {}

  do(deck: Deck): CommandResult {
    const existing = deck.components.find((c) => c.id === this.component.id);
    if (existing) {
      if (!deepEqual(existing, this.component)) throw new CommandError(`Component "${this.component.id}" already exists with a different definition`);
      return resultOf(deck, deck);
    }
    checkComponent(deck, this.component);
    return resultOf(deck, { ...deck, components: [...deck.components, structuredClone(this.component)] });
  }
}
