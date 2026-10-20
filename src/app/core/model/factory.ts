import { SCHEMA_VERSION, STAGE_HEIGHT, STAGE_WIDTH } from './constants';
import { ELEMENT_SCHEMAS } from './element-schema';
import { generateId } from './ids';
import { createBuiltInLayouts } from './layouts';
import { createTheme } from './themes';
import type { Deck, Element, ElementBase, ElementType, Layout, Slide } from './types';

type ElementOf<T extends ElementType> = Extract<Element, { type: T }>;
type ElementOverrides<T extends ElementType> = Partial<Omit<ElementOf<T>, 'type' | 'id'>>;

export function createLayout(name = 'Blank'): Layout {
  return { id: generateId('layout'), name, placeholders: [] };
}

export function createSlide(layoutId: string): Slide {
  return { id: generateId('slide'), layoutId, elements: [], notes: '' };
}

/** A new deck with the built-in theme and layouts and one empty slide on the blank layout. */
export function createDeck(title = 'Untitled deck'): Deck {
  const layouts = createBuiltInLayouts();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: generateId('deck'),
    title,
    stage: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
    theme: createTheme(),
    layouts,
    slides: [createSlide(layouts[0].id)],
    assets: {},
    components: [],
  };
}

/**
 * Creates an element with sensible defaults. Elements that reference an asset or component
 * (`image`, `video`, `code`) start with an empty reference; pass it in `overrides`.
 */
export function createElement<T extends ElementType>(
  type: T,
  overrides: ElementOverrides<T> = {},
): ElementOf<T> {
  const base: ElementBase = {
    id: generateId('element'),
    x: STAGE_WIDTH / 4,
    y: STAGE_HEIGHT / 4,
    w: STAGE_WIDTH / 2,
    h: STAGE_HEIGHT / 2,
    rotation: 0,
  };
  const element = { ...base, ...structuredClone(ELEMENT_SCHEMAS[type].defaults), ...overrides, type };
  return element as unknown as ElementOf<T>;
}
