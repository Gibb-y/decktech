import {
  ID_PATTERN,
  MAX_THEME_NAME,
  PLACEHOLDER_KINDS,
  generateId,
  reflowToLayout,
  validateFill,
  type Deck,
  type Fill,
  type Layout,
  type Placeholder,
  type PlaceholderKind,
  type Slide,
} from '../model';
import { CommandError, deepEqual, resultOf, type Command, type CommandResult } from './command';
import type { GestureOptions } from './commands';

/** At most this many layouts per deck and placeholders per layout; far beyond use, it keeps a hostile import from growing the editor. */
export const MAX_LAYOUTS = 100;
export const MAX_PLACEHOLDERS = 50;

export interface PlaceholderBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A layout name is trimmed and 1 to `MAX_THEME_NAME` characters. */
function checkName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0 || trimmed.length > MAX_THEME_NAME) throw new CommandError(`A layout name has 1 to ${MAX_THEME_NAME} characters`);
  return trimmed;
}

/** A placeholder lies inside the stage and has an area (arc42 §8.7). */
function checkBox(deck: Deck, box: PlaceholderBox): void {
  for (const key of ['x', 'y', 'w', 'h'] as const) {
    if (typeof box[key] !== 'number' || !Number.isFinite(box[key])) throw new CommandError(`${key} must be a finite number`);
  }
  if (box.w <= 0 || box.h <= 0) throw new CommandError('A placeholder needs a width and a height above 0');
  const { width, height } = deck.stage;
  if (box.x < 0 || box.y < 0 || box.x + box.w > width || box.y + box.h > height) {
    throw new CommandError(`A placeholder must lie inside the ${width} x ${height} stage`);
  }
}

function checkKind(kind: unknown): asserts kind is PlaceholderKind {
  if (!(PLACEHOLDER_KINDS as readonly unknown[]).includes(kind)) throw new CommandError(`A placeholder is one of ${PLACEHOLDER_KINDS.join(', ')}`);
}

function checkPlaceholder(deck: Deck, p: Placeholder, taken: ReadonlySet<string>): void {
  if (typeof p.id !== 'string' || !ID_PATTERN.test(p.id)) throw new CommandError('A placeholder id is 1 to 128 letters, digits, "_" or "-"');
  if (taken.has(p.id)) throw new CommandError(`Placeholder "${p.id}" already exists in this layout`);
  checkKind(p.kind);
  checkBox(deck, p);
}

function checkBackground(deck: Deck, fill: Fill): void {
  const checked = validateFill(fill, Object.keys(deck.theme.colors), Object.keys(deck.assets));
  if (!checked.ok) throw new CommandError(`Invalid background: ${checked.error.map((e) => `${e.path} ${e.message}`).join('; ')}`);
}

function layoutIndex(deck: Deck, id: string): number {
  const index = deck.layouts.findIndex((l) => l.id === id);
  if (index < 0) throw new CommandError(`Layout "${id}" does not exist`);
  return index;
}

/** Checks a whole layout (the new one of `AddLayout`). */
function checkLayout(deck: Deck, layout: Layout): Layout {
  if (typeof layout.id !== 'string' || !ID_PATTERN.test(layout.id)) throw new CommandError('A layout id is 1 to 128 letters, digits, "_" or "-"');
  if (deck.layouts.some((l) => l.id === layout.id)) throw new CommandError(`Layout "${layout.id}" already exists`);
  if (deck.layouts.length >= MAX_LAYOUTS) throw new CommandError(`A deck has at most ${MAX_LAYOUTS} layouts`);
  if (!Array.isArray(layout.placeholders)) throw new CommandError('A layout needs a list of placeholders');
  if (layout.placeholders.length > MAX_PLACEHOLDERS) throw new CommandError(`A layout has at most ${MAX_PLACEHOLDERS} placeholders`);
  const ids = new Set<string>();
  for (const p of layout.placeholders) {
    checkPlaceholder(deck, p, ids);
    ids.add(p.id);
  }
  if (layout.background !== undefined) checkBackground(deck, layout.background);
  // Copy only the modelled fields, so nothing unmodelled rides along.
  return {
    id: layout.id,
    name: checkName(layout.name),
    ...(layout.background === undefined ? {} : { background: structuredClone(layout.background) }),
    placeholders: layout.placeholders.map(({ id, kind, x, y, w, h }) => ({ id, kind, x, y, w, h })),
  };
}

/**
 * Replaces one layout and re-flows the slides that use it, so a moved or removed placeholder takes
 * the content bound to it along (the rule of `SetSlideLayout`). Slides on other layouts keep their identity.
 */
function replaceLayout(deck: Deck, index: number, layout: Layout): Deck {
  const layouts = deck.layouts.map((l, i) => (i === index ? layout : l));
  const slides = deck.slides.map((slide) => {
    if (slide.layoutId !== layout.id) return slide;
    const elements = reflowToLayout(slide.elements, layout);
    return elements === slide.elements ? slide : { ...slide, elements: [...elements] };
  });
  return { ...deck, layouts, slides: slides.every((s, i) => s === deck.slides[i]) ? deck.slides : slides };
}

function updateLayout(deck: Deck, id: string, fn: (layout: Layout) => Layout): Deck {
  const index = layoutIndex(deck, id);
  const next = fn(deck.layouts[index]);
  return next === deck.layouts[index] ? deck : replaceLayout(deck, index, next);
}

/** Adds a new layout (at the end, or at `index`). */
export class AddLayout implements Command {
  readonly name = 'AddLayout';

  constructor(
    readonly layout: Layout,
    readonly index?: number,
  ) {}

  do(deck: Deck): CommandResult {
    const index = this.index ?? deck.layouts.length;
    if (!Number.isInteger(index) || index < 0 || index > deck.layouts.length) throw new CommandError(`Layout index ${index} out of range`);
    const layout = checkLayout(deck, this.layout);
    return resultOf(deck, { ...deck, layouts: [...deck.layouts.slice(0, index), layout, ...deck.layouts.slice(index)] });
  }
}

/** Inserts a copy of a layout right after it (same placeholders and background, a new id, "<name> copy"). */
export class DuplicateLayout implements Command {
  readonly name = 'DuplicateLayout';

  constructor(
    readonly layoutId: string,
    /** Id of the copy; fixed up front so callers can select it afterwards. */
    readonly newLayoutId: string = generateId('layout'),
  ) {}

  do(deck: Deck): CommandResult {
    const index = layoutIndex(deck, this.layoutId);
    const original = deck.layouts[index];
    const name = `${original.name} copy`.slice(0, MAX_THEME_NAME);
    const copy = checkLayout(deck, { ...structuredClone(original), id: this.newLayoutId, name });
    return resultOf(deck, { ...deck, layouts: [...deck.layouts.slice(0, index + 1), copy, ...deck.layouts.slice(index + 1)] });
  }
}

export class RenameLayout implements Command {
  readonly name = 'RenameLayout';
  readonly coalesceKey: string;

  constructor(
    readonly layoutId: string,
    readonly newName: string,
  ) {
    this.coalesceKey = `layout-name:${layoutId}`;
  }

  do(deck: Deck): CommandResult {
    const name = checkName(this.newName);
    return resultOf(deck, updateLayout(deck, this.layoutId, (l) => (l.name === name ? l : { ...l, name })));
  }
}

/**
 * Deletes a layout. A deck keeps at least one. Slides that use it must go somewhere: without a
 * `replacementId` the command is refused (naming how many slides use it); with one, those slides
 * move to the replacement and their placeholder content re-flows into it, in the same undo step.
 * So no slide is ever left with a `layoutId` that does not resolve.
 */
export class DeleteLayout implements Command {
  readonly name = 'DeleteLayout';

  constructor(
    readonly layoutId: string,
    readonly replacementId?: string,
  ) {}

  do(deck: Deck): CommandResult {
    const index = layoutIndex(deck, this.layoutId);
    if (deck.layouts.length === 1) throw new CommandError('A deck needs at least one layout');
    const users = deck.slides.filter((s) => s.layoutId === this.layoutId);
    const layouts = deck.layouts.filter((_, i) => i !== index);
    if (users.length === 0) return resultOf(deck, { ...deck, layouts });
    if (this.replacementId === undefined) {
      throw new CommandError(`${users.length === 1 ? '1 slide uses' : `${users.length} slides use`} the layout “${deck.layouts[index].name}”; choose a layout to move them to`);
    }
    if (this.replacementId === this.layoutId) throw new CommandError('The replacement must be another layout');
    const replacement = layouts.find((l) => l.id === this.replacementId);
    if (!replacement) throw new CommandError(`Layout "${this.replacementId}" does not exist`);
    const slides = deck.slides.map((slide): Slide => {
      if (slide.layoutId !== this.layoutId) return slide;
      const elements = reflowToLayout(slide.elements, replacement);
      return { ...slide, layoutId: replacement.id, ...(elements === slide.elements ? {} : { elements: [...elements] }) };
    });
    return resultOf(deck, { ...deck, layouts, slides });
  }
}

/** Sets the background of a layout, or removes it (`undefined`); slides without their own background show it. */
export class SetLayoutBackground implements Command {
  readonly name = 'SetLayoutBackground';
  readonly coalesceKey: string;

  constructor(
    readonly layoutId: string,
    readonly background: Fill | undefined,
  ) {
    this.coalesceKey = `layout-background:${layoutId}`;
  }

  do(deck: Deck): CommandResult {
    const fill = this.background;
    if (fill !== undefined) checkBackground(deck, fill);
    return resultOf(
      deck,
      updateLayout(deck, this.layoutId, (l) => {
        if (fill === undefined) {
          if (l.background === undefined) return l;
          const { background: _old, ...rest } = l;
          return rest;
        }
        return deepEqual(l.background, fill) ? l : { ...l, background: structuredClone(fill) };
      }),
    );
  }
}

/** Adds a placeholder to a layout (on top of the others). Slides on the layout re-flow, so a free bound element can take it. */
export class AddPlaceholder implements Command {
  readonly name = 'AddPlaceholder';

  constructor(
    readonly layoutId: string,
    readonly placeholder: Placeholder,
  ) {}

  do(deck: Deck): CommandResult {
    return resultOf(
      deck,
      updateLayout(deck, this.layoutId, (l) => {
        if (l.placeholders.length >= MAX_PLACEHOLDERS) throw new CommandError(`A layout has at most ${MAX_PLACEHOLDERS} placeholders`);
        checkPlaceholder(deck, this.placeholder, new Set(l.placeholders.map((p) => p.id)));
        const { id, kind, x, y, w, h } = this.placeholder;
        return { ...l, placeholders: [...l.placeholders, { id, kind, x, y, w, h }] };
      }),
    );
  }
}

function updatePlaceholder(deck: Deck, layoutId: string, placeholderId: string, fn: (p: Placeholder) => Placeholder): Deck {
  return updateLayout(deck, layoutId, (l) => {
    const index = l.placeholders.findIndex((p) => p.id === placeholderId);
    if (index < 0) throw new CommandError(`Placeholder "${placeholderId}" does not exist in layout "${layoutId}"`);
    const next = fn(l.placeholders[index]);
    return next === l.placeholders[index] ? l : { ...l, placeholders: l.placeholders.map((p, i) => (i === index ? next : p)) };
  });
}

/** Moves and resizes a placeholder: the rectangle is given in full (stage units, inside the stage). */
export class SetPlaceholderBox implements Command {
  readonly name = 'SetPlaceholderBox';
  readonly coalesceKey?: string;

  constructor(
    readonly layoutId: string,
    readonly placeholderId: string,
    readonly box: PlaceholderBox,
    options: GestureOptions = {},
  ) {
    this.coalesceKey = options.coalesceKey;
  }

  do(deck: Deck): CommandResult {
    checkBox(deck, this.box);
    const { x, y, w, h } = this.box;
    return resultOf(
      deck,
      updatePlaceholder(deck, this.layoutId, this.placeholderId, (p) => (p.x === x && p.y === y && p.w === w && p.h === h ? p : { ...p, x, y, w, h })),
    );
  }
}

/** Changes what a placeholder is for (title, body, image, footer). */
export class SetPlaceholderKind implements Command {
  readonly name = 'SetPlaceholderKind';

  constructor(
    readonly layoutId: string,
    readonly placeholderId: string,
    readonly kind: PlaceholderKind,
  ) {}

  do(deck: Deck): CommandResult {
    checkKind(this.kind);
    return resultOf(deck, updatePlaceholder(deck, this.layoutId, this.placeholderId, (p) => (p.kind === this.kind ? p : { ...p, kind: this.kind })));
  }
}

/** Removes a placeholder. Elements bound to it keep their place and binding (no content is lost, arc42 §8.7). */
export class RemovePlaceholder implements Command {
  readonly name = 'RemovePlaceholder';

  constructor(
    readonly layoutId: string,
    readonly placeholderId: string,
  ) {}

  do(deck: Deck): CommandResult {
    return resultOf(
      deck,
      updateLayout(deck, this.layoutId, (l) => {
        if (!l.placeholders.some((p) => p.id === this.placeholderId)) {
          throw new CommandError(`Placeholder "${this.placeholderId}" does not exist in layout "${this.layoutId}"`);
        }
        return { ...l, placeholders: l.placeholders.filter((p) => p.id !== this.placeholderId) };
      }),
    );
  }
}
