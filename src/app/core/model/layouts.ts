import type { Layout, Placeholder, PlaceholderKind } from './types';

type Box = readonly [x: number, y: number, w: number, h: number];

const TITLE: Box = [120, 80, 1680, 140];
const placeholders = (items: [PlaceholderKind, Box][]): Placeholder[] =>
  items.map(([kind, [x, y, w, h]], i) => ({ id: `ph_${kind}${items.filter(([k], j) => k === kind && j <= i).length}`, kind, x, y, w, h }));

/**
 * The layouts every new deck starts with (arc42 §8.7), on the default 1920x1080 stage. Ids are
 * fixed so two decks that use the same built-in layout agree on its id. `Blank` comes first: it is
 * the layout of the first slide of a new deck.
 */
export const BUILT_IN_LAYOUTS: readonly Layout[] = [
  { id: 'ly_blank', name: 'Blank', placeholders: [] },
  {
    id: 'ly_title',
    name: 'Title slide',
    placeholders: placeholders([['title', [240, 340, 1440, 200]], ['body', [240, 580, 1440, 140]]]),
  },
  { id: 'ly_title-content', name: 'Title and content', placeholders: placeholders([['title', TITLE], ['body', [120, 260, 1680, 700]]]) },
  {
    id: 'ly_two-column',
    name: 'Two columns',
    placeholders: placeholders([['title', TITLE], ['body', [120, 260, 810, 700]], ['body', [990, 260, 810, 700]]]),
  },
  { id: 'ly_title-only', name: 'Title only', placeholders: placeholders([['title', TITLE]]) },
];

/** Fresh copies of the built-in layouts (decks own their layouts). */
export const createBuiltInLayouts = (): Layout[] => structuredClone([...BUILT_IN_LAYOUTS]) as Layout[];
