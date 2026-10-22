import { TestBed } from '@angular/core/testing';
import { createDeck, createElement, createSlide, instantiateLayout, validateDeck, type Deck, type Layout, type Placeholder, type TextEl } from '../model';
import { CommandError } from './command';
import { SetProps, SetTheme } from './commands';
import { DeckStore } from './deck-store';
import {
  AddLayout,
  AddPlaceholder,
  DeleteLayout,
  DuplicateLayout,
  MAX_LAYOUTS,
  MAX_PLACEHOLDERS,
  RemovePlaceholder,
  RenameLayout,
  SetLayoutBackground,
  SetPlaceholderBox,
  SetPlaceholderKind,
} from './layout-commands';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const ph = (id: string, kind: Placeholder['kind'] = 'body', box: Partial<Placeholder> = {}): Placeholder => ({ id, kind, x: 100, y: 100, w: 400, h: 300, ...box });
const layoutOf = (deck: Deck, id: string): Layout => deck.layouts.find((l) => l.id === id)!;
const throwsWith = (fn: () => unknown, message: string | RegExp): void => {
  expect(fn).toThrow(CommandError);
  expect(fn).toThrow(message);
};

/** A deck with two slides on "Title and content" (title + body bound to placeholders) and one on "Blank". */
function sample() {
  const deck = createDeck('T');
  const content = layoutOf(deck, 'ly_title-content');
  const a = instantiateLayout(createSlide(content.id), content, deck.theme);
  const b = instantiateLayout(createSlide(content.id), content, deck.theme);
  deck.slides = [a, b, createSlide('ly_blank')];
  return deepFreeze(deck);
}

describe('AddLayout', () => {
  const layout = (): Layout => ({ id: 'ly_new', name: 'Mine', placeholders: [ph('p1', 'title', { x: 0, y: 0, w: 1920, h: 200 })] });

  it('appends a layout that validates with the deck, and keeps the slides as they are', () => {
    const deck = sample();
    const next = new AddLayout(layout()).do(deck).deck;
    expect(next.layouts.at(-1)).toEqual(layout());
    expect(next.slides).toBe(deck.slides);
    expect(validateDeck(next).ok).toBe(true);
  });

  it('inserts at an index and refuses a bad one', () => {
    const deck = sample();
    expect(new AddLayout(layout(), 1).do(deck).deck.layouts[1].id).toBe('ly_new');
    throwsWith(() => new AddLayout(layout(), 99).do(deck), 'out of range');
    throwsWith(() => new AddLayout(layout(), 1.5).do(deck), 'out of range');
  });

  it.each([
    ['a duplicate layout id', { id: 'ly_blank' }, 'already exists'],
    ['an id with a slash', { id: 'a/b' }, 'layout id'],
    ['an inherited-looking id that is not an id', { id: '' }, 'layout id'],
    ['a blank name', { name: '   ' }, 'layout name'],
    ['a name that is too long', { name: 'x'.repeat(101) }, 'layout name'],
    ['duplicate placeholder ids', { placeholders: [ph('p'), ph('p')] }, 'already exists in this layout'],
    ['an unknown placeholder kind', { placeholders: [ph('p', 'video' as never)] }, 'title, body, image, footer'],
    ['a placeholder outside the stage', { placeholders: [ph('p', 'body', { x: 1800, w: 400 })] }, 'inside the 1920 x 1080 stage'],
    ['a negative origin', { placeholders: [ph('p', 'body', { x: -1 })] }, 'inside'],
    ['an empty placeholder', { placeholders: [ph('p', 'body', { w: 0 })] }, 'above 0'],
    ['NaN geometry', { placeholders: [ph('p', 'body', { h: NaN })] }, 'finite'],
    ['placeholders that are not a list', { placeholders: 'x' as never }, 'list of placeholders'],
    ['a background token the theme lacks', { background: { kind: 'solid', color: { token: 'nope' } } }, 'unknown theme color'],
    ['a background image that is not in the deck', { background: { kind: 'image', assetId: 'a'.repeat(64), fit: 'cover' } }, 'unknown asset'],
  ] as [string, Partial<Layout>, string][])('refuses %s', (_name, change, message) => {
    const deck = sample();
    throwsWith(() => new AddLayout({ ...layout(), ...change }).do(deck), message);
  });

  it('refuses more than MAX_LAYOUTS and MAX_PLACEHOLDERS', () => {
    const deck = createDeck();
    deck.layouts = Array.from({ length: MAX_LAYOUTS }, (_, i) => ({ id: `l${i}`, name: 'x', placeholders: [] }));
    deck.slides[0].layoutId = 'l0';
    throwsWith(() => new AddLayout(layout()).do(deck), `at most ${MAX_LAYOUTS}`);
    const many = Array.from({ length: MAX_PLACEHOLDERS + 1 }, (_, i) => ph(`p${i}`));
    throwsWith(() => new AddLayout({ ...layout(), placeholders: many }).do(sample()), `at most ${MAX_PLACEHOLDERS}`);
  });

  it('stores only the modelled fields and a copy', () => {
    const input = { ...layout(), extra: 1, placeholders: [{ ...ph('p'), onclick: 'x' }] } as unknown as Layout;
    const next = new AddLayout(input).do(sample()).deck;
    expect(Object.keys(next.layouts.at(-1)!).sort()).toEqual(['id', 'name', 'placeholders']);
    expect(Object.keys(next.layouts.at(-1)!.placeholders[0]).sort()).toEqual(['h', 'id', 'kind', 'w', 'x', 'y']);
    expect(next.layouts.at(-1)!.placeholders).not.toBe(input.placeholders);
  });

  it('honours the stage of a deck that is not 16:9', () => {
    const deck = { ...createDeck(), stage: { width: 1920, height: 1440 } };
    expect(() => new AddLayout({ ...layout(), placeholders: [ph('p', 'body', { y: 1000, h: 400 })] }).do(deck)).not.toThrow();
    throwsWith(() => new AddLayout({ ...layout(), placeholders: [ph('p', 'body', { y: 1100, h: 400 })] }).do(deck), 'inside the 1920 x 1440');
  });
});

describe('DuplicateLayout', () => {
  it('copies placeholders and background right after the original under a new id and name', () => {
    const deck = sample();
    const next = new DuplicateLayout('ly_two-column', 'ly_copy').do(deck).deck;
    const index = next.layouts.findIndex((l) => l.id === 'ly_two-column');
    expect(next.layouts[index + 1]).toEqual({ ...layoutOf(deck, 'ly_two-column'), id: 'ly_copy', name: 'Two columns copy' });
    expect(next.layouts[index + 1].placeholders).not.toBe(layoutOf(deck, 'ly_two-column').placeholders);
    expect(validateDeck(next).ok).toBe(true);
  });

  it('generates an id by default, and refuses a taken one or an unknown source', () => {
    const deck = sample();
    const next = new DuplicateLayout('ly_blank').do(deck).deck;
    expect(next.layouts[1].id).toMatch(/^ly_/);
    throwsWith(() => new DuplicateLayout('ly_blank', 'ly_title').do(deck), 'already exists');
    throwsWith(() => new DuplicateLayout('nope').do(deck), 'does not exist');
  });

});

describe('RenameLayout', () => {
  it('trims the name and is a no-op for the same name', () => {
    const deck = sample();
    expect(layoutOf(new RenameLayout('ly_blank', '  Empty ').do(deck).deck, 'ly_blank').name).toBe('Empty');
    const same = new RenameLayout('ly_blank', 'Blank').do(deck);
    expect(same.deck).toBe(deck);
    expect(same.patch).toEqual([]);
  });

  it.each(['', '   ', 'x'.repeat(101)])('refuses the name %j', (name) => {
    throwsWith(() => new RenameLayout('ly_blank', name).do(sample()), 'layout name');
  });

  it('refuses an unknown layout', () => {
    throwsWith(() => new RenameLayout('nope', 'x').do(sample()), 'does not exist');
  });

  it('does not touch the slides', () => {
    const deck = sample();
    expect(new RenameLayout('ly_title-content', 'Content').do(deck).deck.slides).toBe(deck.slides);
  });
});

describe('DeleteLayout', () => {
  it('removes a layout no slide uses', () => {
    const deck = sample();
    const next = new DeleteLayout('ly_two-column').do(deck).deck;
    expect(next.layouts.some((l) => l.id === 'ly_two-column')).toBe(false);
    expect(next.slides).toBe(deck.slides);
  });

  it('refuses a layout slides use, saying how many, and changes nothing', () => {
    const deck = sample();
    throwsWith(() => new DeleteLayout('ly_title-content').do(deck), '2 slides use the layout “Title and content”');
    throwsWith(() => new DeleteLayout('ly_blank').do(deck), '1 slide uses');
  });

  it('moves the slides to the replacement and re-flows their content, never leaving a dangling layoutId', () => {
    const deck = sample();
    const next = new DeleteLayout('ly_title-content', 'ly_two-column').do(deck).deck;
    expect(next.slides.map((s) => s.layoutId)).toEqual(['ly_two-column', 'ly_two-column', 'ly_blank']);
    const body = next.slides[0].elements.find((e) => e.placeholder === 'body')!;
    expect(body).toMatchObject({ x: 120, y: 260, w: 810, h: 700 });
    expect(next.slides[2]).toBe(deck.slides[2]);
    expect(validateDeck(next).ok).toBe(true);
  });

  it('is one undo step that restores layout, slides and content', () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(DeckStore);
    const deck = sample();
    store.load(deck);
    store.execute(new DeleteLayout('ly_title-content', 'ly_two-column'));
    store.undo();
    expect(store.deck()).toEqual(deck);
    expect(store.canUndo()).toBe(false);
  });

  it('refuses the replacement being the layout itself, unknown, or the last layout', () => {
    const deck = sample();
    throwsWith(() => new DeleteLayout('ly_title-content', 'ly_title-content').do(deck), 'another layout');
    throwsWith(() => new DeleteLayout('ly_title-content', 'nope').do(deck), 'does not exist');
    throwsWith(() => new DeleteLayout('nope').do(deck), 'does not exist');
    const single = createDeck();
    single.layouts = [single.layouts[0]];
    throwsWith(() => new DeleteLayout(single.layouts[0].id).do(single), 'at least one layout');
  });

  it('ignores a replacement when no slide uses the layout', () => {
    const deck = sample();
    expect(new DeleteLayout('ly_title', 'ly_blank').do(deck).deck.slides).toBe(deck.slides);
  });
});

describe('SetLayoutBackground', () => {
  it('sets, replaces and removes the background; the slides are not touched', () => {
    const deck = sample();
    const set = new SetLayoutBackground('ly_title', { kind: 'solid', color: { token: 'accent' } }).do(deck).deck;
    expect(layoutOf(set, 'ly_title').background).toEqual({ kind: 'solid', color: { token: 'accent' } });
    expect(set.slides).toBe(deck.slides);
    const removed = new SetLayoutBackground('ly_title', undefined).do(set).deck;
    expect('background' in layoutOf(removed, 'ly_title')).toBe(false);
    expect(new SetLayoutBackground('ly_title', undefined).do(deck).deck).toBe(deck);
  });

  it('is a no-op for an equal fill and refuses invalid ones', () => {
    const deck = new SetLayoutBackground('ly_title', { kind: 'solid', color: '#ff0000' }).do(sample()).deck;
    expect(new SetLayoutBackground('ly_title', { kind: 'solid', color: '#ff0000' }).do(deck).deck).toBe(deck);
    throwsWith(() => new SetLayoutBackground('ly_title', { kind: 'solid', color: 'url(javascript:1)' }).do(deck), 'Invalid background');
    throwsWith(() => new SetLayoutBackground('ly_title', { kind: 'solid', color: { token: 'gone' } }).do(deck), 'unknown theme color');
    throwsWith(() => new SetLayoutBackground('nope', undefined).do(deck), 'does not exist');
  });

  it('keeps SetTheme from dropping a colour a layout background uses', () => {
    const deck = new SetLayoutBackground('ly_title', { kind: 'solid', color: { token: 'accent' } }).do(sample()).deck;
    const { accent: _gone, ...colors } = deck.theme.colors;
    throwsWith(() => new SetTheme({ ...deck.theme, colors }).do(deck), 'still uses the colour "accent"');
  });
});

describe('placeholder commands', () => {
  it('AddPlaceholder appends and re-flows a surplus bound element into it', () => {
    const deck = sample();
    // The slide has a second body, bound to nothing yet: give it a binding the layout cannot serve.
    const extra = createElement('text', { placeholder: 'body', x: 1, y: 2, w: 3, h: 4 });
    const withExtra = { ...deck, slides: [{ ...deck.slides[0], elements: [...deck.slides[0].elements, extra] }, ...deck.slides.slice(1)] };
    const next = new AddPlaceholder('ly_title-content', ph('second', 'body', { x: 10, y: 20, w: 30, h: 40 })).do(withExtra).deck;
    expect(layoutOf(next, 'ly_title-content').placeholders.at(-1)).toEqual(ph('second', 'body', { x: 10, y: 20, w: 30, h: 40 }));
    expect(next.slides[0].elements.find((e) => e.id === extra.id)).toMatchObject({ x: 10, y: 20, w: 30, h: 40 });
    expect(next.slides[1]).toBe(deck.slides[1].elements.some((e) => e.id === extra.id) ? next.slides[1] : deck.slides[1]);
  });

  it.each([
    ['a taken id', ph('ph_title1'), 'already exists in this layout'],
    ['a bad kind', ph('n', 'nope' as never), 'title, body, image, footer'],
    ['one outside the stage', ph('n', 'body', { w: 5000 }), 'inside'],
    ['a bad id', ph('a b'), 'placeholder id'],
  ])('AddPlaceholder refuses %s', (_name, placeholder, message) => {
    throwsWith(() => new AddPlaceholder('ly_title-content', placeholder).do(sample()), message);
  });

  it('AddPlaceholder refuses the 51st placeholder and an unknown layout', () => {
    const deck = createDeck();
    deck.layouts[0].placeholders = Array.from({ length: MAX_PLACEHOLDERS }, (_, i) => ph(`p${i}`));
    throwsWith(() => new AddPlaceholder(deck.layouts[0].id, ph('more')).do(deck), `at most ${MAX_PLACEHOLDERS}`);
    throwsWith(() => new AddPlaceholder('nope', ph('n')).do(sample()), 'does not exist');
  });

  it('SetPlaceholderBox moves and resizes, and the slides on the layout follow', () => {
    const deck = sample();
    const next = new SetPlaceholderBox('ly_title-content', 'ph_body1', { x: 200, y: 300, w: 500, h: 400 }).do(deck).deck;
    expect(layoutOf(next, 'ly_title-content').placeholders[1]).toMatchObject({ x: 200, y: 300, w: 500, h: 400 });
    for (const slide of next.slides.slice(0, 2)) {
      expect(slide.elements.find((e) => e.placeholder === 'body')).toMatchObject({ x: 200, y: 300, w: 500, h: 400 });
    }
    expect(next.slides[2]).toBe(deck.slides[2]);
  });

  it('SetPlaceholderBox leaves a locked bound element where it is', () => {
    const deck = sample();
    const body = deck.slides[0].elements.find((e) => e.placeholder === 'body')!;
    const locked = new SetProps([body.id], { locked: true }).do(deck).deck;
    const next = new SetPlaceholderBox('ly_title-content', 'ph_body1', { x: 0, y: 0, w: 10, h: 10 }).do(locked).deck;
    expect(next.slides[0].elements.find((e) => e.id === body.id)).toMatchObject({ x: body.x, y: body.y });
  });

  it.each([
    ['outside on the right', { x: 1800, y: 0, w: 200, h: 10 }],
    ['outside at the bottom', { x: 0, y: 1000, w: 10, h: 100 }],
    ['negative', { x: -1, y: 0, w: 10, h: 10 }],
    ['empty', { x: 0, y: 0, w: 10, h: 0 }],
    ['negative size', { x: 0, y: 0, w: -10, h: 10 }],
    ['Infinity', { x: 0, y: 0, w: Infinity, h: 10 }],
  ])('SetPlaceholderBox refuses a box that is %s, even when nothing would change', (_name, box) => {
    throwsWith(() => new SetPlaceholderBox('ly_title-content', 'ph_body1', box).do(sample()), /inside|above 0|finite/);
  });

  it('SetPlaceholderBox is a no-op for the same box and refuses unknown ids', () => {
    const deck = sample();
    const same = new SetPlaceholderBox('ly_title-content', 'ph_body1', { x: 120, y: 260, w: 1680, h: 700 }).do(deck);
    expect(same.deck).toBe(deck);
    expect(same.patch).toEqual([]);
    throwsWith(() => new SetPlaceholderBox('ly_title-content', 'nope', { x: 0, y: 0, w: 1, h: 1 }).do(deck), 'does not exist');
    throwsWith(() => new SetPlaceholderBox('nope', 'ph_body1', { x: 0, y: 0, w: 1, h: 1 }).do(deck), 'does not exist');
    throwsWith(() => new SetPlaceholderBox('ly_title-content', 'toString', { x: 0, y: 0, w: 1, h: 1 }).do(deck), 'does not exist');
  });

  it('a long drag is one history entry whose size follows the net change', () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(DeckStore);
    store.load(sample());
    const release = store.beginGesture('ph-drag');
    for (let i = 1; i <= 300; i++) store.execute(new SetPlaceholderBox('ly_title-content', 'ph_body1', { x: 120 + i, y: 260, w: 1000, h: 700 }, { coalesceKey: 'ph-drag' }));
    release();
    store.undo();
    expect(layoutOf(store.deck(), 'ly_title-content').placeholders[1]).toMatchObject({ x: 120, w: 1680 });
    expect(store.canUndo()).toBe(false);
  });

  it('SetPlaceholderKind changes the kind and refuses an unknown one', () => {
    const deck = sample();
    const next = new SetPlaceholderKind('ly_title-content', 'ph_body1', 'image').do(deck).deck;
    expect(layoutOf(next, 'ly_title-content').placeholders[1].kind).toBe('image');
    expect(new SetPlaceholderKind('ly_title-content', 'ph_body1', 'body').do(deck).deck).toBe(deck);
    throwsWith(() => new SetPlaceholderKind('ly_title-content', 'ph_body1', 'x' as never).do(deck), 'title, body');
  });

  it('RemovePlaceholder keeps the bound element where it is, with its binding', () => {
    const deck = sample();
    const body = deck.slides[0].elements.find((e) => e.placeholder === 'body')!;
    const next = new RemovePlaceholder('ly_title-content', 'ph_body1').do(deck).deck;
    expect(layoutOf(next, 'ly_title-content').placeholders.map((p) => p.id)).toEqual(['ph_title1']);
    expect(next.slides[0].elements.find((e) => e.id === body.id)).toEqual(body);
    throwsWith(() => new RemovePlaceholder('ly_title-content', 'ph_body1').do(next), 'does not exist');
  });

  it('every layout edit is a single undo step', () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(DeckStore);
    const deck = sample();
    store.load(deck);
    store.execute(new SetPlaceholderBox('ly_title-content', 'ph_body1', { x: 5, y: 5, w: 50, h: 50 }));
    store.undo();
    expect(store.deck()).toEqual(deck);
    store.redo();
    expect(store.deck().slides[0].elements.find((e) => e.placeholder === 'body')).toMatchObject({ x: 5, w: 50 });
  });

  it('does not mutate frozen inputs', () => {
    const deck = sample();
    expect(() => new RemovePlaceholder('ly_title-content', 'ph_body1').do(deck)).not.toThrow();
    expect(() => new DeleteLayout('ly_title-content', 'ly_two-column').do(deck)).not.toThrow();
  });
});

describe('size tokens in SetProps', () => {
  const textDeck = () => {
    const deck = createDeck();
    const el = createElement('text', { fontSize: 40, sizeToken: 'body' }) as TextEl;
    deck.slides[0].elements.push(el);
    return { deck: deepFreeze(deck), id: el.id };
  };

  it('accepts a token the theme has and refuses one it lacks or inherits', () => {
    const { deck, id } = textDeck();
    const next = new SetProps([id], { sizeToken: 'heading' }).do(deck).deck;
    expect((next.slides[0].elements[0] as TextEl).sizeToken).toBe('heading');
    throwsWith(() => new SetProps([id], { sizeToken: 'huge' }).do(deck), 'no type size "huge"');
    throwsWith(() => new SetProps([id], { sizeToken: 'toString' }).do(deck), 'no type size');
    throwsWith(() => new SetProps([id], { sizeToken: 5 }).do(deck), 'sizeToken');
  });

  it('removes the token with undefined, and typing a size replaces it', () => {
    const { deck, id } = textDeck();
    const removed = new SetProps([id], { sizeToken: undefined }).do(deck).deck;
    expect('sizeToken' in removed.slides[0].elements[0]).toBe(false);
    const typed = new SetProps([id], { fontSize: 40 }).do(deck).deck; // even the same number: it is now the author's own
    expect(typed.slides[0].elements[0]).toMatchObject({ fontSize: 40 });
    expect('sizeToken' in typed.slides[0].elements[0]).toBe(false);
  });

  it('SetTheme refuses dropping a type size a text element uses, and allows changing its value', () => {
    const { deck } = textDeck();
    const { body: _gone, ...typeScale } = deck.theme.typeScale;
    throwsWith(() => new SetTheme({ ...deck.theme, typeScale }).do(deck), 'still uses the text size "body"');
    const bigger = new SetTheme({ ...deck.theme, typeScale: { ...deck.theme.typeScale, body: 55 } }).do(deck).deck;
    expect(bigger.slides).toBe(deck.slides);
  });

  it('validateDeck refuses a size token the theme lacks', () => {
    const { deck } = textDeck();
    expect(validateDeck(deck).ok).toBe(true);
    const bad = structuredClone(deck);
    (bad.slides[0].elements[0] as TextEl).sizeToken = 'huge';
    const result = validateDeck(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.map((e) => e.message).join()).toContain('unknown theme type size "huge"');
  });
});

describe('awkward ids', () => {
  it.each(['__proto__', 'constructor', 'toString'])('a layout and placeholder called %s can be added, edited and undone', (id) => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(DeckStore);
    const deck = sample();
    store.load(deck);
    store.execute(new AddLayout({ id, name: 'Odd', placeholders: [ph(id)] }));
    store.execute(new SetPlaceholderBox(id, id, { x: 1, y: 2, w: 3, h: 4 }));
    expect(store.deck().layouts.at(-1)!.placeholders[0]).toMatchObject({ id, x: 1 });
    store.undo();
    store.undo();
    expect(store.deck()).toEqual(deck);
    store.redo();
    store.redo();
    expect(store.deck().layouts.at(-1)!.placeholders[0]).toMatchObject({ id, x: 1 });
  });
});

describe('DuplicateLayout names', () => {
  it('keeps the suffix when the name is already at the limit', () => {
    const deck = createDeck();
    deck.layouts[0].name = 'x'.repeat(100);
    const copy = new DuplicateLayout(deck.layouts[0].id).do(deck).deck.layouts[1].name;
    expect(copy).toHaveLength(100);
    expect(copy.endsWith(' copy')).toBe(true);
    expect(copy).not.toBe(deck.layouts[0].name);
  });
});
