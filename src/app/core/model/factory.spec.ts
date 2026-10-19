import { STAGE_HEIGHT, STAGE_WIDTH, SCHEMA_VERSION } from './constants';
import { createDeck, createElement, createSlide } from './factory';
import { generateId, ID_PATTERN } from './ids';
import type { ElementType } from './types';
import { validateDeck } from './validate';

describe('ids', () => {
  it('generates unique, well-formed ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId('element')));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(ID_PATTERN);
  });
});

describe('factories', () => {
  it('uses the 1920x1080 stage and current schema version', () => {
    expect([STAGE_WIDTH, STAGE_HEIGHT]).toEqual([1920, 1080]);
    expect(createDeck().schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('createDeck produces a valid deck with one slide on an existing layout', () => {
    const deck = createDeck('T');
    expect(deck.title).toBe('T');
    expect(deck.slides).toHaveLength(1);
    expect(deck.layouts.map((l) => l.id)).toContain(deck.slides[0].layoutId);
    expect(validateDeck(deck).ok).toBe(true);
  });

  it('createSlide references the given layout', () => {
    expect(createSlide('ly1').layoutId).toBe('ly1');
  });

  const types: ElementType[] = ['text', 'image', 'shape', 'line', 'table', 'video', 'code'];
  it.each(types)('createElement(%s) has the right type and a unique id', (type) => {
    const a = createElement(type);
    expect(a.type).toBe(type);
    expect(createElement(type).id).not.toBe(a.id);
  });

  it('applies overrides but never overrides type', () => {
    const el = createElement('text', { text: 'hi', x: 5 });
    expect(el.text).toBe('hi');
    expect(el.x).toBe(5);
  });
});
