import { TestBed } from '@angular/core/testing';
import {
  BUILT_IN_THEMES,
  createDeck,
  createElement,
  createSlide,
  createTheme,
  instantiateLayout,
  validateDeck,
  type Deck,
  type Element,
  type Layout,
  type Theme,
} from '../model';
import { CommandError } from './command';
import { AddElement, SetProps, SetSlideBackground, SetSlideLayout, SetTheme } from './commands';
import { DeckStore } from './deck-store';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const FONT = 'f'.repeat(64);
const layoutOf = (deck: Deck, id: string): Layout => deck.layouts.find((l) => l.id === id)!;
const dark = (): Theme => createTheme('dark');
const textOf = (e: Element): string | undefined => (e as { text?: string }).text;

/** A deck with a slide on "Two columns": title and two bodies bound to placeholders, plus a loose shape. */
function twoColumns() {
  const deck = createDeck('T');
  const layout = layoutOf(deck, 'ly_two-column');
  const slide = instantiateLayout(createSlide(layout.id), layout, deck.theme);
  slide.elements.push(createElement('shape', { x: 5, y: 6, w: 7, h: 8 }));
  deck.slides[0] = slide;
  return { deck: deepFreeze(deck), slide: deck.slides[0] };
}

describe('SetTheme', () => {
  it('restyles every element without touching one: elements point at tokens, not colours', () => {
    const { deck } = twoColumns();
    const next = new SetTheme(dark()).do(deck).deck;
    expect(next.theme.colors['background']).toBe('#14161a');
    expect(next.slides).toBe(deck.slides);
    expect(next.layouts).toBe(deck.layouts);
  });

  it('is one undo step and undo restores the old theme', () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(DeckStore);
    store.load(createDeck());
    const before = store.deck().theme;
    store.execute(new SetTheme(dark()));
    expect(store.deck().theme.colors['text']).toBe('#f2f4f8');
    store.undo();
    expect(store.deck().theme).toEqual(before);
    expect(store.canUndo()).toBe(false);
  });

  it('records nothing when the theme is unchanged, and copies its input', () => {
    const deck = createDeck();
    expect(new SetTheme(structuredClone(deck.theme)).do(deck).deck).toBe(deck);
    const input = dark();
    const result = new SetTheme(input).do(deck).deck;
    input.colors['text'] = '#000000';
    expect(result.theme.colors['text']).toBe('#f2f4f8');
  });

  it('keeps the result a valid deck', () => {
    const { deck } = twoColumns();
    expect(validateDeck(new SetTheme(dark()).do(deck).deck).ok).toBe(true);
  });

  it.each([
    ['no background colour', (t: Theme) => delete t.colors['background'], 'needs a "background" colour'],
    ['no text colour', (t: Theme) => delete t.colors['text'], 'needs a "text" colour'],
    ['no body font', (t: Theme) => delete t.fonts['body'], 'needs a "body" font'],
    ['a colour that is not a colour', (t: Theme) => (t.colors['text'] = 'red; background: url(x)'), 'Invalid theme'],
    ['a negative type size', (t: Theme) => (t.typeScale['body'] = -1), 'Invalid theme'],
    ['a font face of an unknown asset', (t: Theme) => (t.fontFaces = [{ family: 'X', assetId: FONT }]), 'Invalid theme'],
  ])('rejects a theme with %s', (_name, damage, message) => {
    const { deck } = twoColumns();
    const theme = dark();
    damage(theme);
    expect(() => new SetTheme(theme).do(deck)).toThrow(CommandError);
    expect(() => new SetTheme(theme).do(deck)).toThrow(message);
  });

  it('rejects hostile keys', () => {
    const { deck } = twoColumns();
    const theme = JSON.parse('{"colors":{"__proto__":"#000000","background":"#fff","text":"#000"},"fonts":{"body":"sans-serif"},"typeScale":{},"spacing":{}}') as Theme;
    expect(() => new SetTheme(theme).do(deck)).toThrow('Invalid theme');
  });

  it('refuses to drop a colour token or font that elements still use', () => {
    const { deck } = twoColumns();
    const noAccent = dark();
    delete noAccent.colors['accent']; // the loose shape fills with the accent token
    expect(() => new SetTheme(noAccent).do(deck)).toThrow('still uses the colour "accent"');
    const noHeading = dark();
    delete noHeading.fonts['heading'];
    expect(() => new SetTheme(noHeading).do(deck)).toThrow('still uses the font "heading"');
  });

  it('also protects tokens used by slide and layout backgrounds', () => {
    const { deck } = twoColumns();
    const withBackground = new SetSlideBackground(deck.slides[0].id, { kind: 'solid', color: { token: 'muted' } }).do(deck).deck;
    const theme = dark();
    delete theme.colors['muted'];
    expect(() => new SetTheme(theme).do(withBackground)).toThrow('"muted"');
    const layoutBackground: Deck = { ...deck, layouts: deck.layouts.map((l) => ({ ...l, background: { kind: 'solid', color: { token: 'muted' } } as const })) };
    expect(() => new SetTheme(theme).do(layoutBackground)).toThrow('"muted"');
  });

  describe('embedded fonts', () => {
    const withFont = (mime: string): Deck => ({ ...createDeck(), assets: { [FONT]: { blobKey: FONT, mime, hash: FONT, size: 3 } } });
    const themeWithFont = (): Theme => ({ ...createTheme(), fontFaces: [{ family: 'Inter', assetId: FONT }], fonts: { ...createTheme().fonts, Inter: '"Inter", sans-serif' } });

    it('accepts a font asset of the deck', () => {
      const next = new SetTheme(themeWithFont()).do(withFont('font/woff2')).deck;
      expect(next.theme.fontFaces).toEqual([{ family: 'Inter', assetId: FONT }]);
      expect(validateDeck(next).ok).toBe(true);
    });

    it('rejects an asset that is not a font', () => {
      expect(() => new SetTheme(themeWithFont()).do(withFont('image/png'))).toThrow('is not a font');
    });
  });
});

describe('SetSlideLayout reflow', () => {
  it('moves bound content into the matching placeholders and keeps every element and its text', () => {
    const { deck, slide } = twoColumns();
    const next = new SetSlideLayout(slide.id, 'ly_title-content').do(deck).deck;
    const [title, left, right, loose] = next.slides[0].elements;
    const target = layoutOf(deck, 'ly_title-content').placeholders;
    expect([title.x, title.y, title.w, title.h]).toEqual([target[0].x, target[0].y, target[0].w, target[0].h]);
    expect([left.x, left.y, left.w, left.h]).toEqual([target[1].x, target[1].y, target[1].w, target[1].h]);
    // This layout has one body placeholder: the second body keeps its place and binding.
    expect(right).toBe(slide.elements[2]);
    expect(loose).toBe(slide.elements[3]);
    expect(next.slides[0].elements.map((e) => e.id)).toEqual(slide.elements.map((e) => e.id));
    expect(next.slides[0].elements.map(textOf)).toEqual(slide.elements.map(textOf));
    expect(next.slides[0].layoutId).toBe('ly_title-content');
  });

  it('pairs the n-th bound element in z-order with the n-th placeholder of its kind', () => {
    const { deck, slide } = twoColumns();
    const elements = [slide.elements[0], slide.elements[2], slide.elements[1], slide.elements[3]];
    const input: Deck = { ...deck, slides: [{ ...slide, layoutId: 'ly_blank', elements }] };
    const next = new SetSlideLayout(slide.id, 'ly_two-column').do(input).deck;
    const bodies = layoutOf(deck, 'ly_two-column').placeholders.filter((p) => p.kind === 'body');
    expect(next.slides[0].elements[1].x).toBe(bodies[0].x);
    expect(next.slides[0].elements[2].x).toBe(bodies[1].x);
  });

  it('leaves locked and unbound elements where they are, and layouts without placeholders change nothing but the id', () => {
    const { deck, slide } = twoColumns();
    const locked = { ...slide.elements[0], locked: true } as Element;
    const input: Deck = { ...deck, slides: [{ ...slide, elements: [locked, ...slide.elements.slice(1)] }] };
    const blank = new SetSlideLayout(slide.id, 'ly_blank').do(input).deck;
    expect(blank.slides[0].elements).toEqual(input.slides[0].elements);
    const titleOnly = new SetSlideLayout(slide.id, 'ly_title-only').do(input).deck;
    expect(titleOnly.slides[0].elements[0]).toBe(locked);
  });

  it('is reversible: undo restores positions, and switching back finds the elements again', () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(DeckStore);
    const { deck, slide } = twoColumns();
    store.load(deck);
    store.execute(new SetSlideLayout(slide.id, 'ly_title-content'));
    store.execute(new SetSlideLayout(slide.id, 'ly_two-column'));
    expect(store.deck().slides[0].elements).toEqual(deck.slides[0].elements);
    store.undo();
    store.undo();
    expect(store.deck().slides[0]).toEqual(deck.slides[0]);
  });

  it('reflows image placeholders too, and resets rotation', () => {
    const { deck, slide } = twoColumns();
    const picture = createElement('image', { placeholder: 'image', rotation: 12, x: 1, y: 2, w: 3, h: 4 });
    const custom: Layout = { id: 'ly_pic', name: 'Picture', placeholders: [{ id: 'ph_a', kind: 'image', x: 10, y: 20, w: 300, h: 200 }] };
    const input: Deck = { ...deck, layouts: [...deck.layouts, custom], slides: [{ ...slide, elements: [...slide.elements, picture] }] };
    const moved = new SetSlideLayout(slide.id, 'ly_pic').do(input).deck.slides[0].elements.at(-1)!;
    expect(moved).toMatchObject({ x: 10, y: 20, w: 300, h: 200, rotation: 0, placeholder: 'image', id: picture.id });
  });

  it('fails without changes for an unknown layout or slide, and is a no-op for the current layout', () => {
    const { deck, slide } = twoColumns();
    expect(() => new SetSlideLayout(slide.id, 'ly_nope').do(deck)).toThrow('does not exist');
    expect(() => new SetSlideLayout('sl_nope', 'ly_blank').do(deck)).toThrow(CommandError);
    expect(new SetSlideLayout(slide.id, slide.layoutId).do(deck).deck).toBe(deck);
  });

  it('only rewrites the slide it was asked about', () => {
    const { deck, slide } = twoColumns();
    const other = { ...createSlide('ly_blank'), elements: [createElement('text', { placeholder: 'title' })] };
    const input: Deck = { ...deck, slides: [slide, other] };
    const next = new SetSlideLayout(slide.id, 'ly_title-only').do(input).deck;
    expect(next.slides[1]).toBe(other);
  });
});

describe('placeholder binding on elements', () => {
  it('is settable and removable through SetProps, and checked', () => {
    const { deck, slide } = twoColumns();
    const loose = slide.elements[3];
    const bound = new SetProps([loose.id], { placeholder: 'footer' }).do(deck).deck;
    expect(bound.slides[0].elements[3].placeholder).toBe('footer');
    const unbound = new SetProps([loose.id], { placeholder: undefined }).do(bound).deck;
    expect('placeholder' in unbound.slides[0].elements[3]).toBe(false);
    expect(() => new SetProps([loose.id], { placeholder: 'sidebar' }).do(deck)).toThrow('"placeholder" must be one of title, body, image, footer');
  });

  it('survives AddElement and validation', () => {
    const { deck, slide } = twoColumns();
    const next = new AddElement(slide.id, createElement('text', { placeholder: 'footer' })).do(deck).deck;
    expect(validateDeck(next).ok).toBe(true);
  });
});

describe('instantiateLayout', () => {
  it('creates a bound, theme-styled text element for each text placeholder', () => {
    const deck = createDeck();
    const layout = layoutOf(deck, 'ly_title-content');
    const slide = instantiateLayout(createSlide(layout.id), layout, deck.theme);
    expect(slide.layoutId).toBe(layout.id);
    expect(slide.elements.map((e) => e.placeholder)).toEqual(['title', 'body']);
    expect(slide.elements[0]).toMatchObject({ type: 'text', font: 'heading', fontSize: deck.theme.typeScale['heading'] });
    expect(slide.elements[1]).toMatchObject({ type: 'text', fontSize: deck.theme.typeScale['body'] });
    expect(validateDeck({ ...deck, slides: [slide] }).ok).toBe(true);
  });

  it('gives a blank layout no elements, and an image placeholder none (a picture needs a file)', () => {
    const deck = createDeck();
    expect(instantiateLayout(createSlide('ly_blank'), layoutOf(deck, 'ly_blank'), deck.theme).elements).toEqual([]);
    const picture: Layout = { id: 'ly_p', name: 'P', placeholders: [{ id: 'ph_i', kind: 'image', x: 0, y: 0, w: 5, h: 5 }] };
    expect(instantiateLayout(createSlide('ly_p'), picture, deck.theme).elements).toEqual([]);
  });

  it('skips the heading font when the theme has none, so the slide still validates', () => {
    const deck = createDeck();
    delete (deck.theme.fonts as Record<string, string>)['heading'];
    const layout = layoutOf(deck, 'ly_title-only');
    const slide = instantiateLayout(createSlide(layout.id), layout, deck.theme);
    expect('font' in slide.elements[0]).toBe(false);
    expect(validateDeck({ ...deck, slides: [slide] }).ok).toBe(true);
  });

  it('references colours by token whatever the theme, so a theme switch restyles it', () => {
    const deck = createDeck();
    const layout = layoutOf(deck, 'ly_title-only');
    const slide = instantiateLayout(createSlide(layout.id), layout, BUILT_IN_THEMES[1].theme);
    expect(slide.elements[0]).toMatchObject({ color: { token: 'text' } });
  });
});
