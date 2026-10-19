import { SCHEMA_VERSION, STAGE_HEIGHT, STAGE_WIDTH } from './constants';
import { generateId } from './ids';
import type { Deck, Element, ElementBase, ElementType, Layout, Slide, Theme } from './types';

type ElementOf<T extends ElementType> = Extract<Element, { type: T }>;
type ElementOverrides<T extends ElementType> = Partial<Omit<ElementOf<T>, 'type' | 'id'>>;

function createTheme(): Theme {
  return {
    colors: { background: '#ffffff', text: '#111111', accent: '#2457d6' },
    fonts: { heading: 'sans-serif', body: 'sans-serif', mono: 'monospace' },
    typeScale: { title: 96, heading: 64, body: 40, caption: 28 },
    spacing: { sm: 16, md: 32, lg: 64 },
  };
}

export function createLayout(name = 'Blank'): Layout {
  return { id: generateId('layout'), name, placeholders: [] };
}

export function createSlide(layoutId: string): Slide {
  return { id: generateId('slide'), layoutId, elements: [], notes: '' };
}

/** A new deck with a blank layout and one empty slide. */
export function createDeck(title = 'Untitled deck'): Deck {
  const layout = createLayout();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: generateId('deck'),
    title,
    theme: createTheme(),
    layouts: [layout],
    slides: [createSlide(layout.id)],
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
  const element = { ...base, ...defaultsFor(type), ...overrides, type };
  return element as unknown as ElementOf<T>;
}

function defaultsFor(type: ElementType): object {
  switch (type) {
    case 'text':
      return { h: 160, text: '', fontSize: 40, color: '#111111', align: 'left' };
    case 'image':
      return { assetId: '', alt: '', fit: 'contain' };
    case 'shape':
      return { shape: 'rect', strokeWidth: 0 };
    case 'line':
      return { h: 0, stroke: '#111111', strokeWidth: 4 };
    case 'table':
      return { rows: [['', ''], ['', '']] };
    case 'video':
      return { assetId: '', autoplay: false, loop: false };
    case 'code':
      return { componentId: '', props: {} };
  }
}
