import {
  ELEMENT_BASE_KEYS,
  ELEMENT_SCHEMAS,
  createElement,
  richPlainText,
  validateRichText,
  generateId,
  PLACEHOLDER_KINDS,
  reflowToLayout,
  REQUIRED_COLOR_TOKENS,
  REQUIRED_FONT_KEYS,
  themeRefs,
  validateTheme,
  validateComponent,
  type AssetRef,
  type CodeEl,
  type ComponentDef,
  type Deck,
  type Element,
  type Fill,
  type RichDoc,
  type Slide,
  type TextEl,
  type Theme,
} from '../model';
import {
  CommandError,
  deepEqual,
  findElement,
  replaceSlide,
  resultOf,
  slideIndex,
  updateElements,
  updateSlide,
  type Command,
  type CommandResult,
} from './command';

/** Content-addressed asset ids (8.5): the lowercase hex SHA-256 digest. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_SECTION_NAME = 200;
/** The validator caps short strings, among them the deck title, at this length. */
const MAX_DECK_TITLE = 1_000;

/** Options shared by commands that are issued repeatedly during a gesture. */
export interface GestureOptions {
  /** Same key within the coalescing window = one undo step. */
  coalesceKey?: string;
}

const assertFinite = (value: number, what: string): void => {
  if (!Number.isFinite(value)) throw new CommandError(`${what} must be a finite number`);
};

// ---------------------------------------------------------------- slides

export class AddSlide implements Command {
  readonly name = 'AddSlide';

  /** @param index insert position; appended when omitted. */
  constructor(
    readonly slide: Slide,
    readonly index?: number,
  ) {}

  do(deck: Deck): CommandResult {
    const index = this.index ?? deck.slides.length;
    if (!Number.isInteger(index) || index < 0 || index > deck.slides.length) {
      throw new CommandError(`Slide index ${index} out of range`);
    }
    if (deck.slides.some((s) => s.id === this.slide.id)) throw new CommandError(`Slide "${this.slide.id}" already exists`);
    if (!deck.layouts.some((l) => l.id === this.slide.layoutId)) {
      throw new CommandError(`Layout "${this.slide.layoutId}" does not exist`);
    }
    // Element ids are looked up deck-wide, so a slide must not bring ids that are taken.
    const taken = new Set(deck.slides.flatMap((s) => s.elements.map((e) => e.id)));
    for (const element of this.slide.elements) {
      if (taken.has(element.id)) throw new CommandError(`Element "${element.id}" already exists`);
      taken.add(element.id);
    }
    const slides = [...deck.slides.slice(0, index), this.slide, ...deck.slides.slice(index)];
    return resultOf(deck, { ...deck, slides });
  }
}

export class DeleteSlide implements Command {
  readonly name = 'DeleteSlide';

  constructor(readonly slideId: string) {}

  do(deck: Deck): CommandResult {
    const index = slideIndex(deck, this.slideId);
    if (deck.slides.length === 1) throw new CommandError('A deck needs at least one slide');
    return resultOf(deck, { ...deck, slides: deck.slides.filter((_, i) => i !== index) });
  }
}

/** Inserts a copy (new slide and element ids, no section start) right after the original. */
export class DuplicateSlide implements Command {
  readonly name = 'DuplicateSlide';

  constructor(
    readonly slideId: string,
    /** Id of the copy; fixed up front so callers can select it afterwards. */
    readonly newSlideId: string = generateId('slide'),
  ) {}

  do(deck: Deck): CommandResult {
    const index = slideIndex(deck, this.slideId);
    if (deck.slides.some((s) => s.id === this.newSlideId)) throw new CommandError(`Slide "${this.newSlideId}" already exists`);
    const original = deck.slides[index];
    const { section: _section, ...clone } = structuredClone(original); // a copy continues the section, it does not start one
    const copy: Slide = {
      ...clone,
      id: this.newSlideId,
      elements: clone.elements.map((e) => ({ ...e, id: generateId('element') })),
    };
    const slides = [...deck.slides.slice(0, index + 1), copy, ...deck.slides.slice(index + 1)];
    return resultOf(deck, { ...deck, slides });
  }
}

/**
 * Moves the given slides, keeping their relative order, so that the first of them ends up at
 * `toIndex` of the list that remains once they are taken out.
 */
export class ReorderSlides implements Command {
  readonly name = 'ReorderSlides';

  constructor(
    readonly slideIds: readonly string[],
    readonly toIndex: number,
  ) {}

  do(deck: Deck): CommandResult {
    if (this.slideIds.length === 0) throw new CommandError('No slide ids given');
    this.slideIds.forEach((id) => slideIndex(deck, id));
    const moved = deck.slides.filter((s) => this.slideIds.includes(s.id));
    const rest = deck.slides.filter((s) => !this.slideIds.includes(s.id));
    if (!Number.isInteger(this.toIndex) || this.toIndex < 0 || this.toIndex > rest.length) {
      throw new CommandError(`Slide index ${this.toIndex} out of range`);
    }
    const slides = [...rest.slice(0, this.toIndex), ...moved, ...rest.slice(this.toIndex)];
    return resultOf(deck, slides.every((s, i) => s === deck.slides[i]) ? deck : { ...deck, slides });
  }
}

export class SetNotes implements Command {
  readonly name = 'SetNotes';
  readonly coalesceKey: string;

  constructor(
    readonly slideId: string,
    readonly notes: string,
  ) {
    this.coalesceKey = `notes:${slideId}`;
  }

  do(deck: Deck): CommandResult {
    return resultOf(
      deck,
      updateSlide(deck, this.slideId, (s) => (s.notes === this.notes ? s : { ...s, notes: this.notes })),
    );
  }
}

/** Names the section that starts at a slide; `undefined` (or a blank name) removes the section start. */
export class SetSlideSection implements Command {
  readonly name = 'SetSlideSection';
  readonly coalesceKey: string;
  private readonly section: string | undefined;

  constructor(
    readonly slideId: string,
    section: string | undefined,
  ) {
    this.coalesceKey = `section:${slideId}`;
    this.section = section?.trim() || undefined;
  }

  do(deck: Deck): CommandResult {
    if (this.section !== undefined && this.section.length > MAX_SECTION_NAME) {
      throw new CommandError(`A section name has at most ${MAX_SECTION_NAME} characters`);
    }
    return resultOf(
      deck,
      updateSlide(deck, this.slideId, (s) => {
        if (s.section === this.section) return s;
        const { section: _old, ...rest } = s;
        return this.section === undefined ? rest : { ...rest, section: this.section };
      }),
    );
  }
}

/**
 * Switches the layout of a slide. Elements bound to a placeholder (`Element.placeholder`) move into
 * the new layout's placeholders of the same kind; every other element stays where it is, and no
 * element is ever removed (arc42 §8.7).
 */
export class SetSlideLayout implements Command {
  readonly name = 'SetSlideLayout';

  constructor(
    readonly slideId: string,
    readonly layoutId: string,
  ) {}

  do(deck: Deck): CommandResult {
    if (!deck.layouts.some((l) => l.id === this.layoutId)) throw new CommandError(`Layout "${this.layoutId}" does not exist`);
    return resultOf(
      deck,
      updateSlide(deck, this.slideId, (s) => {
        if (s.layoutId === this.layoutId) return s;
        const layout = deck.layouts.find((l) => l.id === this.layoutId)!;
        const elements = reflowToLayout(s.elements, layout);
        return { ...s, layoutId: this.layoutId, ...(elements === s.elements ? {} : { elements: [...elements] }) };
      }),
    );
  }
}

/** Renames the deck. The title is shown in the library and used for the file name of an export. */
export class SetDeckTitle implements Command {
  readonly name = 'SetDeckTitle';

  constructor(readonly title: string) {}

  do(deck: Deck): CommandResult {
    const title = this.title.trim();
    if (title.length === 0 || title.length > MAX_DECK_TITLE) throw new CommandError(`The deck title must be 1 to ${MAX_DECK_TITLE} characters`);
    return resultOf(deck, title === deck.title ? deck : { ...deck, title });
  }
}

/**
 * Replaces the deck's theme (colours, fonts, type scale, spacing, embedded fonts). Elements refer
 * to the theme by token name, so this restyles every built-in element without touching one. The
 * new theme must be valid, define the tokens the renderer falls back on and every token or font
 * key the deck still uses, and its embedded fonts must be font assets of the deck.
 */
export class SetTheme implements Command {
  readonly name = 'SetTheme';

  constructor(readonly theme: Theme) {}

  do(deck: Deck): CommandResult {
    const checked = validateTheme(this.theme, Object.keys(deck.assets));
    if (!checked.ok) throw new CommandError(`Invalid theme: ${checked.error.map((e) => `${e.path} ${e.message}`).join('; ')}`);
    const theme = structuredClone(this.theme);
    for (const token of REQUIRED_COLOR_TOKENS) {
      if (!Object.hasOwn(theme.colors, token)) throw new CommandError(`A theme needs a "${token}" colour`);
    }
    for (const key of REQUIRED_FONT_KEYS) {
      if (!Object.hasOwn(theme.fonts, key)) throw new CommandError(`A theme needs a "${key}" font`);
    }
    const families = new Set<string>();
    for (const face of theme.fontFaces ?? []) {
      if (!deck.assets[face.assetId].mime.startsWith('font/')) throw new CommandError(`Asset "${face.assetId}" is not a font`);
      if (families.has(face.family)) throw new CommandError(`The font family "${face.family}" is embedded twice`);
      families.add(face.family);
      if (!Object.values(theme.fonts).some((stack) => stack.includes(face.family))) {
        throw new CommandError(`The embedded font "${face.family}" is not used by any font of the theme`);
      }
    }
    const refs = themeRefs(deck);
    for (const token of refs.colors) {
      if (!Object.hasOwn(theme.colors, token)) throw new CommandError(`The deck still uses the colour "${token}", which the theme lacks`);
    }
    for (const font of refs.fonts) {
      if (!Object.hasOwn(theme.fonts, font)) throw new CommandError(`The deck still uses the font "${font}", which the theme lacks`);
    }
    for (const size of refs.sizes) {
      if (!Object.hasOwn(theme.typeScale, size)) throw new CommandError(`The deck still uses the text size "${size}", which the theme lacks`);
    }
    return resultOf(deck, deepEqual(deck.theme, theme) ? deck : { ...deck, theme });
  }
}

/** Sets the background of a slide, or removes it (`undefined`) so the layout's shows through. */
export class SetSlideBackground implements Command {
  readonly name = 'SetSlideBackground';
  readonly coalesceKey: string;

  constructor(
    readonly slideId: string,
    readonly background: Fill | undefined,
  ) {
    this.coalesceKey = `background:${slideId}`;
  }

  do(deck: Deck): CommandResult {
    const fill = this.background;
    if (fill?.kind === 'image' && !Object.hasOwn(deck.assets, fill.assetId)) {
      throw new CommandError(`Asset "${fill.assetId}" does not exist`);
    }
    return resultOf(
      deck,
      updateSlide(deck, this.slideId, (s) => {
        if (fill === undefined) {
          if (s.background === undefined) return s;
          const { background: _old, ...rest } = s;
          return rest;
        }
        return deepEqual(s.background, fill) ? s : { ...s, background: fill };
      }),
    );
  }
}

/**
 * Registers a stored blob in the deck. Asset ids are content hashes, so adding the same content
 * again is a no-op; a different reference under an existing id is an error.
 */
export class AddAsset implements Command {
  readonly name = 'AddAsset';

  constructor(
    readonly assetId: string,
    readonly ref: AssetRef,
  ) {}

  do(deck: Deck): CommandResult {
    if (!SHA256_HEX.test(this.assetId) || this.ref.hash !== this.assetId || this.ref.blobKey !== this.assetId) {
      throw new CommandError('An asset id is the SHA-256 digest of its content, which is also its hash and blob key');
    }
    if (Object.hasOwn(deck.assets, this.assetId)) {
      if (!deepEqual(deck.assets[this.assetId], this.ref)) throw new CommandError(`Asset "${this.assetId}" already exists with different content`);
      return resultOf(deck, deck);
    }
    return resultOf(deck, { ...deck, assets: { ...deck.assets, [this.assetId]: this.ref } });
  }
}

// -------------------------------------------------------------- elements

/** Adds an element to a slide at `index` (z-order; on top when omitted). */
export class AddElement implements Command {
  readonly name = 'AddElement';

  constructor(
    readonly slideId: string,
    readonly element: Element,
    readonly index?: number,
  ) {}

  do(deck: Deck): CommandResult {
    if (findElement(deck, this.element.id)) throw new CommandError(`Element "${this.element.id}" already exists`);
    return resultOf(
      deck,
      updateSlide(deck, this.slideId, (slide) => {
        const index = this.index ?? slide.elements.length;
        if (!Number.isInteger(index) || index < 0 || index > slide.elements.length) {
          throw new CommandError(`Element index ${index} out of range`);
        }
        const elements = [...slide.elements.slice(0, index), this.element, ...slide.elements.slice(index)];
        return { ...slide, elements };
      }),
    );
  }
}

export class DeleteElements implements Command {
  readonly name = 'DeleteElements';

  constructor(readonly ids: readonly string[]) {}

  do(deck: Deck): CommandResult {
    const ids = new Set(this.ids);
    updateElements(deck, this.ids, (e) => e); // validates that every id exists
    const slides = deck.slides.map((slide) =>
      slide.elements.some((e) => ids.has(e.id)) ? { ...slide, elements: slide.elements.filter((e) => !ids.has(e.id)) } : slide,
    );
    return resultOf(deck, { ...deck, slides });
  }
}

export class MoveElements implements Command {
  readonly name = 'MoveElements';
  readonly coalesceKey?: string;

  constructor(
    readonly ids: readonly string[],
    readonly dx: number,
    readonly dy: number,
    options: GestureOptions = {},
  ) {
    this.coalesceKey = options.coalesceKey;
  }

  do(deck: Deck): CommandResult {
    assertFinite(this.dx, 'dx');
    assertFinite(this.dy, 'dy');
    if (this.dx === 0 && this.dy === 0) {
      updateElements(deck, this.ids, (e) => e); // still reports unknown ids
      return resultOf(deck, deck);
    }
    return resultOf(deck, updateElements(deck, this.ids, (e) => ({ ...e, x: e.x + this.dx, y: e.y + this.dy })));
  }
}

export interface ElementGeometry {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Sets absolute geometry; a resize also moves the origin, so the new rectangle is given in full. */
export class ResizeElements implements Command {
  readonly name = 'ResizeElements';
  readonly coalesceKey?: string;

  constructor(
    readonly changes: readonly ElementGeometry[],
    options: GestureOptions = {},
  ) {
    this.coalesceKey = options.coalesceKey;
  }

  do(deck: Deck): CommandResult {
    if (this.changes.length === 0) throw new CommandError('No element changes given');
    const byId = new Map(this.changes.map((c) => [c.id, c]));
    for (const c of this.changes) {
      assertFinite(c.x, 'x');
      assertFinite(c.y, 'y');
      assertFinite(c.w, 'w');
      assertFinite(c.h, 'h');
      if (c.w < 0 || c.h < 0) throw new CommandError('Width and height must not be negative');
    }
    return resultOf(
      deck,
      updateElements(deck, [...byId.keys()], (e) => {
        const c = byId.get(e.id)!;
        return c.x === e.x && c.y === e.y && c.w === e.w && c.h === e.h ? e : { ...e, x: c.x, y: c.y, w: c.w, h: c.h };
      }),
    );
  }
}

/**
 * Sets fields on elements. Only fields that exist for the element's type are accepted (the shared
 * geometry/visibility fields plus its entries in `ELEMENT_SCHEMAS`); `id` and `type` can never
 * change. A value of `undefined` removes an optional field. Scalar values are checked against the
 * field's kind (finite numbers within bounds, strings, booleans, enum members); structured values
 * (colours, fills, tables, code props) are left to the editor and to `validateDeck` on load.
 */
export class SetProps implements Command {
  readonly name = 'SetProps';
  readonly coalesceKey?: string;

  constructor(
    readonly ids: readonly string[],
    readonly changes: Readonly<Record<string, unknown>>,
    options: GestureOptions = {},
  ) {
    this.coalesceKey = options.coalesceKey;
  }

  do(deck: Deck): CommandResult {
    const entries = Object.entries(this.changes);
    return resultOf(
      deck,
      updateElements(deck, this.ids, (e) => {
        const allowed = allowedKeys(e);
        let next: Record<string, unknown> | undefined;
        for (const [key, value] of entries) {
          if (!allowed.has(key)) throw new CommandError(`"${key}" is not a settable property of a ${e.type} element`);
          checkValue(e, key, value);
          if (key === 'sizeToken' && typeof value === 'string' && !Object.hasOwn(deck.theme.typeScale, value)) {
            throw new CommandError(`The theme has no type size "${value}"`);
          }
          if ((e as unknown as Record<string, unknown>)[key] === value) continue;
          next ??= { ...e };
          if (value === undefined) delete next[key];
          else next[key] = value;
        }
        // Different plain text would leave a stale `rich` document that the renderer prefers.
        if (next && e.type === 'text' && next['text'] !== e.text) delete next['rich'];
        // A size typed in by hand replaces the token it came from, else the number would be ignored.
        if (e.type === 'text' && e.sizeToken !== undefined && Object.hasOwn(this.changes, 'fontSize') && !Object.hasOwn(this.changes, 'sizeToken')) {
          next ??= { ...e };
          delete next['sizeToken'];
        }
        return (next as Element | undefined) ?? e;
      }),
    );
  }
}

const BASE_RULES: Record<string, { optional?: boolean; check: (v: unknown) => string | undefined }> = {
  x: { check: (v) => finite(v) },
  y: { check: (v) => finite(v) },
  w: { check: (v) => finite(v, 0) },
  h: { check: (v) => finite(v, 0) },
  rotation: { check: (v) => finite(v) },
  locked: { optional: true, check: (v) => (typeof v === 'boolean' ? undefined : 'a boolean') },
  hidden: { optional: true, check: (v) => (typeof v === 'boolean' ? undefined : 'a boolean') },
  step: { optional: true, check: (v) => (Number.isInteger(v) && (v as number) >= 0 ? undefined : 'a non-negative integer') },
  placeholder: { optional: true, check: (v) => ((PLACEHOLDER_KINDS as readonly unknown[]).includes(v) ? undefined : `one of ${PLACEHOLDER_KINDS.join(', ')}`) },
};

function finite(v: unknown, min?: number, max?: number): string | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'a finite number';
  if (min !== undefined && v < min) return `at least ${min}`;
  if (max !== undefined && v > max) return `at most ${max}`;
  return undefined;
}

function checkValue(element: Element, key: string, value: unknown): void {
  const base = BASE_RULES[key];
  const spec = base ? undefined : ELEMENT_SCHEMAS[element.type].fields[key];
  const optional = base ? base.optional === true : spec?.optional === true;
  if (value === undefined) {
    if (!optional) throw new CommandError(`"${key}" cannot be removed from a ${element.type} element`);
    return;
  }
  let problem: string | undefined;
  if (base) problem = base.check(value);
  else if (spec?.kind === 'number') problem = finite(value, spec.min, spec.max);
  else if (spec?.kind === 'string') problem = typeof value === 'string' ? undefined : 'a string';
  else if (spec?.kind === 'sizeToken') problem = typeof value === 'string' && value.length > 0 ? undefined : 'a non-empty string';
  else if (spec?.kind === 'boolean') problem = typeof value === 'boolean' ? undefined : 'a boolean';
  else if (spec?.kind === 'enum') problem = spec.values.includes(value as string) ? undefined : `one of ${spec.values.join(', ')}`;
  if (problem) throw new CommandError(`"${key}" must be ${problem}`);
}

function allowedKeys(element: Element): Set<string> {
  const keys = new Set<string>([...ELEMENT_BASE_KEYS, ...Object.keys(ELEMENT_SCHEMAS[element.type].fields)]);
  keys.delete('id');
  keys.delete('type');
  keys.delete('rich'); // validated and mirrored into `text` by SetText only
  if (element.type === 'table') for (const key of ['rows', 'columnWidths', 'cellFills']) keys.delete(key); // the table commands keep these in step
  return keys;
}

export type ZOrderMove = 'front' | 'back' | 'forward' | 'backward';

/** Changes z-order (array order) of the given elements within a slide. */
export class ReorderElements implements Command {
  readonly name = 'ReorderElements';

  constructor(
    readonly slideId: string,
    readonly ids: readonly string[],
    readonly move: ZOrderMove,
  ) {}

  do(deck: Deck): CommandResult {
    return resultOf(
      deck,
      updateSlide(deck, this.slideId, (slide) => {
        const selected = new Set(this.ids);
        if (selected.size === 0) throw new CommandError('No element ids given');
        for (const id of selected) {
          if (!slide.elements.some((e) => e.id === id)) throw new CommandError(`Element "${id}" is not on slide "${slide.id}"`);
        }
        const elements = reorder(slide.elements, selected, this.move);
        return elements.every((e, i) => e === slide.elements[i]) ? slide : { ...slide, elements };
      }),
    );
  }
}

function reorder(elements: readonly Element[], selected: ReadonlySet<string>, move: ZOrderMove): Element[] {
  const isSel = (e: Element): boolean => selected.has(e.id);
  switch (move) {
    case 'front':
      return [...elements.filter((e) => !isSel(e)), ...elements.filter(isSel)];
    case 'back':
      return [...elements.filter(isSel), ...elements.filter((e) => !isSel(e))];
    case 'forward': {
      const out = [...elements];
      for (let i = out.length - 2; i >= 0; i--) {
        if (isSel(out[i]) && !isSel(out[i + 1])) [out[i], out[i + 1]] = [out[i + 1], out[i]];
      }
      return out;
    }
    case 'backward': {
      const out = [...elements];
      for (let i = 1; i < out.length; i++) {
        if (isSel(out[i]) && !isSel(out[i - 1])) [out[i], out[i - 1]] = [out[i - 1], out[i]];
      }
      return out;
    }
  }
}

/**
 * Commits edited text of a text element (one command per editing session, arc42 §8.4). Plain
 * text replaces the content and drops any `rich` document; a `RichDoc` is validated against the
 * deck theme (same rules as on load), stored as a copy, and its plain-text mirror becomes `text`.
 */
export class SetText implements Command {
  readonly name = 'SetText';

  constructor(
    readonly elementId: string,
    readonly content: string | RichDoc,
  ) {}

  do(deck: Deck): CommandResult {
    const content = this.content;
    let rich: RichDoc | undefined;
    let text: string;
    if (typeof content === 'string') {
      text = content;
    } else {
      const problems = validateRichText(content, 'rich', { colors: Object.keys(deck.theme.colors), sizes: Object.keys(deck.theme.typeScale) });
      if (problems.length > 0) throw new CommandError(`Invalid rich text: ${problems.map((p) => `${p.path} ${p.message}`).join('; ')}`);
      rich = structuredClone(content);
      text = richPlainText(rich);
    }
    return resultOf(
      deck,
      updateElements(deck, [this.elementId], (e) => {
        if (e.type !== 'text') throw new CommandError(`Element "${e.id}" is a ${e.type} element, not text`);
        if (e.text === text && (rich === undefined ? e.rich === undefined : deepEqual(e.rich, rich))) return e;
        const next: TextEl = { ...e, text };
        if (rich) next.rich = rich;
        else delete next.rich;
        return next;
      }),
    );
  }
}

// ------------------------------------------------------------ components

/** Throws a `CommandError` listing why `def` would not validate in `deck`. */
export function checkComponent(deck: Deck, def: ComponentDef): void {
  const result = validateComponent(def, Object.keys(deck.assets));
  if (!result.ok) throw new CommandError(`Invalid component: ${result.error.map((p) => `${p.path} ${p.message}`).join('; ')}`);
}

/** Edits the sources of a component definition; omitted sources stay as they are. */
export class SetComponentSource implements Command {
  readonly name = 'SetComponentSource';

  constructor(
    readonly componentId: string,
    readonly source: Partial<Pick<ComponentDef, 'html' | 'css' | 'js'>>,
  ) {}

  do(deck: Deck): CommandResult {
    const index = deck.components.findIndex((c) => c.id === this.componentId);
    if (index < 0) throw new CommandError(`Component "${this.componentId}" does not exist`);
    const current = deck.components[index];
    const { html = current.html, css = current.css, js = current.js } = this.source;
    if (html === current.html && css === current.css && js === current.js) return resultOf(deck, deck);
    const next = { ...current, html, css, js };
    // A source past the size limit would make the saved deck fail `validateDeck` on the next load.
    checkComponent(deck, next);
    const components = deck.components.map((c, i) => (i === index ? next : c));
    return resultOf(deck, { ...deck, components });
  }
}

/**
 * Inserts a code element backed by `component`. The definition is added to the deck unless an
 * identical one exists already (then the element simply references it); a different definition
 * under the same id is an error, use `SetComponentSource` to edit a shared definition.
 */
export class AddCodeElement implements Command {
  readonly name = 'AddCodeElement';
  readonly element: CodeEl;

  constructor(
    readonly slideId: string,
    readonly component: ComponentDef,
    geometry: Partial<Pick<CodeEl, 'x' | 'y' | 'w' | 'h'>> = {},
  ) {
    const props: Record<string, unknown> = {};
    for (const spec of component.propSchema) props[spec.key] = structuredClone(spec.default);
    this.element = createElement('code', { ...geometry, componentId: component.id, props });
  }

  do(deck: Deck): CommandResult {
    const index = slideIndex(deck, this.slideId);
    const existing = deck.components.find((c) => c.id === this.component.id);
    if (existing && !deepEqual(existing, this.component)) {
      throw new CommandError(`Component "${this.component.id}" already exists with a different definition`);
    }
    if (!existing) checkComponent(deck, this.component); // e.g. a library entry whose assets this deck lacks
    const withComponent = existing ? deck : { ...deck, components: [...deck.components, this.component] };
    const slide = withComponent.slides[index];
    return resultOf(deck, replaceSlide(withComponent, index, { ...slide, elements: [...slide.elements, this.element] }));
  }
}

/**
 * Runs several commands as one undo step (paste or duplicate of a selection). They run in order,
 * each on the result of the previous one; if any throws, nothing changes. The patches are derived
 * from the start and end deck, so the entry is as small as the net change.
 */
export class Batch implements Command {
  readonly coalesceKey?: string;

  constructor(
    readonly name: string,
    readonly commands: readonly Command[],
    options: GestureOptions = {},
  ) {
    this.coalesceKey = options.coalesceKey;
  }

  do(deck: Deck): CommandResult {
    if (this.commands.length === 0) throw new CommandError('No commands given');
    let current = deck;
    for (const command of this.commands) current = command.do(current).deck;
    return resultOf(deck, current);
  }
}
