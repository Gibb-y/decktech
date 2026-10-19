import {
  ELEMENT_BASE_KEYS,
  ELEMENT_SCHEMAS,
  createElement,
  generateId,
  type CodeEl,
  type ComponentDef,
  type Deck,
  type Element,
  type Slide,
} from '../model';
import {
  CommandError,
  findElement,
  replaceSlide,
  resultOf,
  slideIndex,
  updateElements,
  updateSlide,
  type Command,
  type CommandResult,
} from './command';

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

/** Inserts a copy (new slide and element ids) right after the original. */
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
    const copy: Slide = {
      ...structuredClone(original),
      id: this.newSlideId,
      elements: structuredClone(original.elements).map((e) => ({ ...e, id: generateId('element') })),
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
    if (this.dx === 0 && this.dy === 0) return resultOf(deck, deck);
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
 * change. A value of `undefined` removes an optional field. Value types are not checked here:
 * the editor produces them from the schema, and `validateDeck` guards anything loaded from outside.
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
          if ((e as unknown as Record<string, unknown>)[key] === value) continue;
          next ??= { ...e };
          if (value === undefined) delete next[key];
          else next[key] = value;
        }
        return (next as Element | undefined) ?? e;
      }),
    );
  }
}

function allowedKeys(element: Element): Set<string> {
  const keys = new Set<string>([...ELEMENT_BASE_KEYS, ...Object.keys(ELEMENT_SCHEMAS[element.type].fields)]);
  keys.delete('id');
  keys.delete('type');
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

/** Commits edited text of a text element (one command per editing session, arc42 §8.4). */
export class SetText implements Command {
  readonly name = 'SetText';

  constructor(
    readonly elementId: string,
    readonly text: string,
  ) {}

  do(deck: Deck): CommandResult {
    return resultOf(
      deck,
      updateElements(deck, [this.elementId], (e) => {
        if (e.type !== 'text') throw new CommandError(`Element "${e.id}" is a ${e.type} element, not text`);
        return e.text === this.text ? e : { ...e, text: this.text };
      }),
    );
  }
}

// ------------------------------------------------------------ components

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
    const components = deck.components.map((c, i) => (i === index ? { ...c, html, css, js } : c));
    return resultOf(deck, { ...deck, components });
  }
}

/**
 * Inserts a code element backed by `component`. The definition is added to the deck unless one
 * with that id exists already (then the element simply references it).
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
    const withComponent = deck.components.some((c) => c.id === this.component.id)
      ? deck
      : { ...deck, components: [...deck.components, this.component] };
    const slide = withComponent.slides[index];
    return resultOf(deck, replaceSlide(withComponent, index, { ...slide, elements: [...slide.elements, this.element] }));
  }
}
