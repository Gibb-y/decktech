import { createDeck, createElement, createSlide, createTheme, effectiveFontSize, freePlaceholder, instantiateLayout, themeContrast, type Layout } from './index';

describe('themeContrast', () => {
  it('reports text, muted and accent against the background, and flags the ones below AA', () => {
    const checks = themeContrast({ colors: { background: '#ffffff', text: '#111111', muted: '#cccccc', accent: '#2457d6' } });
    expect(checks.map((c) => c.token)).toEqual(['text', 'muted', 'accent']);
    expect(checks.map((c) => c.passes)).toEqual([true, false, true]);
    expect(checks[1].ratio).toBeCloseTo(1.6, 1);
  });

  it('passes both built-in themes', () => {
    for (const id of ['light', 'dark']) expect(themeContrast(createTheme(id)).every((c) => c.passes)).toBe(true);
  });

  it('treats exactly 4.5:1 as a pass and just below as a fail', () => {
    // #767676 on white is 4.54:1; #777777 is 4.48:1.
    expect(themeContrast({ colors: { background: '#ffffff', text: '#767676' } })[0].passes).toBe(true);
    expect(themeContrast({ colors: { background: '#ffffff', text: '#777777' } })[0].passes).toBe(false);
  });

  it('does not measure what is not a hex colour, and skips tokens the theme lacks', () => {
    expect(themeContrast({ colors: { background: 'white', text: '#000000' } })).toEqual([{ token: 'text', ratio: null, passes: null }]);
    expect(themeContrast({ colors: { text: '#000000' } })).toEqual([{ token: 'text', ratio: null, passes: null }]);
    expect(themeContrast({ colors: { background: '#fff' } })).toEqual([]);
  });

  it('ignores inherited names', () => {
    expect(themeContrast({ colors: {} })).toEqual([]);
  });
});

describe('effectiveFontSize', () => {
  const theme = { typeScale: { body: 50 } };
  it('follows the type scale when the token exists, else the own size', () => {
    expect(effectiveFontSize({ fontSize: 40, sizeToken: 'body' }, theme)).toBe(50);
    expect(effectiveFontSize({ fontSize: 40 }, theme)).toBe(40);
    expect(effectiveFontSize({ fontSize: 40, sizeToken: 'gone' }, theme)).toBe(40);
    expect(effectiveFontSize({ fontSize: 40, sizeToken: 'toString' }, theme)).toBe(40);
  });
});

describe('placeholder elements use the type scale', () => {
  it('a new slide’s title, body and footer carry size tokens', () => {
    const deck = createDeck();
    const layout = deck.layouts.find((l) => l.id === 'ly_title-content')!;
    const slide = instantiateLayout(createSlide(layout.id), layout, deck.theme);
    expect(slide.elements.map((e) => (e as { sizeToken?: string }).sizeToken)).toEqual(['heading', 'body']);
  });

  it('a theme without those sizes gives fixed sizes instead', () => {
    const deck = createDeck();
    deck.theme.typeScale = {};
    const layout = deck.layouts.find((l) => l.id === 'ly_title-content')!;
    const slide = instantiateLayout(createSlide(layout.id), layout, deck.theme);
    expect(slide.elements.every((e) => !('sizeToken' in e))).toBe(true);
  });
});

describe('freePlaceholder', () => {
  const layout: Layout = {
    id: 'l',
    name: 'L',
    placeholders: [
      { id: 'a', kind: 'image', x: 0, y: 0, w: 10, h: 10 },
      { id: 'b', kind: 'image', x: 20, y: 0, w: 10, h: 10 },
      { id: 'c', kind: 'body', x: 40, y: 0, w: 10, h: 10 },
    ],
  };

  it('gives the next image placeholder after those already bound, then none', () => {
    const slide = createSlide('l');
    expect(freePlaceholder(slide, layout, 'image')?.id).toBe('a');
    slide.elements.push(createElement('image', { placeholder: 'image' }));
    expect(freePlaceholder(slide, layout, 'image')?.id).toBe('b');
    slide.elements.push(createElement('image', { placeholder: 'image' }));
    expect(freePlaceholder(slide, layout, 'image')).toBeUndefined();
  });

  it('is undefined without a layout or a placeholder of the kind, and unbound pictures do not use one up', () => {
    const slide = createSlide('l');
    slide.elements.push(createElement('image'));
    expect(freePlaceholder(slide, layout, 'image')?.id).toBe('a');
    expect(freePlaceholder(slide, undefined, 'image')).toBeUndefined();
    expect(freePlaceholder(slide, layout, 'footer')).toBeUndefined();
  });
});
