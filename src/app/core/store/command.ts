import type { Deck, Element, Slide } from '../model';
import { diff, type Patch } from './patch';

export interface CommandResult {
  /** The new document; unchanged slides and elements are the same objects as before. */
  deck: Deck;
  /** Transforms the old deck into `deck`. */
  patch: Patch;
  /** Transforms `deck` back into the old deck. */
  inverse: Patch;
}

/**
 * A single, atomic edit. `do` must be pure: it never mutates its input and returns the same
 * `Deck` object when nothing changes. Ids must be fixed at construction or generated in `do`;
 * the store never re-runs `do` for redo, it replays the recorded patch.
 */
export interface Command {
  readonly name: string;
  /** Commands with the same key issued within the coalescing window share one history entry. */
  readonly coalesceKey?: string;
  do(deck: Deck): CommandResult;
}

/** Thrown by a command whose target does not exist or whose arguments are invalid. The deck is untouched. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

/** Builds a result from the old and new deck; the patches are derived from their structural difference. */
export function resultOf(before: Deck, after: Deck): CommandResult {
  if (before === after) return { deck: before, patch: [], inverse: [] };
  return { deck: after, patch: diff(before, after), inverse: diff(after, before) };
}

export function slideIndex(deck: Deck, slideId: string): number {
  const index = deck.slides.findIndex((s) => s.id === slideId);
  if (index < 0) throw new CommandError(`Slide "${slideId}" does not exist`);
  return index;
}

export function replaceSlide(deck: Deck, index: number, slide: Slide): Deck {
  if (deck.slides[index] === slide) return deck;
  return { ...deck, slides: deck.slides.map((s, i) => (i === index ? slide : s)) };
}

/** Applies `fn` to one slide, leaving every other slide untouched. */
export function updateSlide(deck: Deck, slideId: string, fn: (slide: Slide) => Slide): Deck {
  const index = slideIndex(deck, slideId);
  return replaceSlide(deck, index, fn(deck.slides[index]));
}

/**
 * Applies `fn` to the elements with the given ids (wherever they are in the deck). Elements that
 * `fn` returns unchanged, and all other elements and slides, keep their identity.
 * Throws if any id is not found.
 */
export function updateElements(deck: Deck, ids: readonly string[], fn: (element: Element) => Element): Deck {
  const wanted = new Set(ids);
  if (wanted.size === 0) throw new CommandError('No element ids given');
  const found = new Set<string>();
  const slides = deck.slides.map((slide) => {
    if (!slide.elements.some((e) => wanted.has(e.id))) return slide;
    const elements = slide.elements.map((e) => {
      if (!wanted.has(e.id)) return e;
      found.add(e.id);
      return fn(e);
    });
    return elements.every((e, i) => e === slide.elements[i]) ? slide : { ...slide, elements };
  });
  for (const id of wanted) {
    if (!found.has(id)) throw new CommandError(`Element "${id}" does not exist`);
  }
  return slides.every((s, i) => s === deck.slides[i]) ? deck : { ...deck, slides };
}

/** Structural equality for JSON-like values (key order does not matter). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every(
    (k) => Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

export function findElement(deck: Deck, id: string): Element | undefined {
  for (const slide of deck.slides) {
    const element = slide.elements.find((e) => e.id === id);
    if (element) return element;
  }
  return undefined;
}
