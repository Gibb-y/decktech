import { BUILT_IN_LAYOUTS, createBuiltInLayouts, createDeck, validateDeck, validateTheme } from '.';
import { AA_TEXT_CONTRAST, contrastRatio } from './contrast';
import { BUILT_IN_THEMES, createTheme } from './themes';

describe('contrastRatio', () => {
  it.each([
    ['#000000', '#ffffff', 21],
    ['#ffffff', '#ffffff', 1],
    ['#fff', '#000', 21],
  ])('%s on %s is %d', (a, b, expected) => expect(contrastRatio(a, b)).toBeCloseTo(expected, 5));

  it('is symmetric and NaN for colours it cannot read', () => {
    expect(contrastRatio('#2457d6', '#ffffff')).toBe(contrastRatio('#ffffff', '#2457d6'));
    expect(contrastRatio('red', '#ffffff')).toBeNaN();
    expect(contrastRatio('#ffffff', 'rgb(0,0,0)')).toBeNaN();
  });
});

describe('built-in themes', () => {
  it('ships a light and a dark theme', () => {
    expect(BUILT_IN_THEMES.map((t) => t.id)).toEqual(['light', 'dark']);
  });

  describe.each(BUILT_IN_THEMES)('$name', ({ theme }) => {
    // Every colour that is used for text or for thin marks must reach WCAG AA on the background.
    it.each(['text', 'muted', 'accent'])('%s reaches AA contrast on the background', (token) => {
      const ratio = contrastRatio(theme.colors[token], theme.colors['background']);
      expect(ratio, `${token} ${theme.colors[token]} on ${theme.colors['background']}`).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
    });

    it('is a valid theme', () => {
      expect(validateTheme(theme, []).ok).toBe(true);
    });
  });

  it('define the same tokens, so switching never leaves a dangling reference', () => {
    const [light, dark] = BUILT_IN_THEMES.map((t) => t.theme);
    expect(Object.keys(dark.colors).sort()).toEqual(Object.keys(light.colors).sort());
    expect(Object.keys(dark.fonts).sort()).toEqual(Object.keys(light.fonts).sort());
    expect(Object.keys(dark.typeScale)).toEqual(Object.keys(light.typeScale));
  });

  it('createTheme gives an independent copy and falls back to light', () => {
    const copy = createTheme('dark');
    copy.colors['text'] = '#000000';
    expect(BUILT_IN_THEMES[1].theme.colors['text']).not.toBe('#000000');
    expect(createTheme('nope')).toEqual(BUILT_IN_THEMES[0].theme);
  });
});

describe('built-in layouts', () => {
  it('has at least title, title and content, two columns and blank', () => {
    const names = BUILT_IN_LAYOUTS.map((l) => l.name);
    expect(names).toEqual(expect.arrayContaining(['Title slide', 'Title and content', 'Two columns', 'Blank']));
    expect(BUILT_IN_LAYOUTS[0].name).toBe('Blank');
  });

  it('keeps its placeholders inside the default stage, with unique ids', () => {
    for (const layout of BUILT_IN_LAYOUTS) {
      expect(new Set(layout.placeholders.map((p) => p.id)).size).toBe(layout.placeholders.length);
      for (const p of layout.placeholders) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x + p.w).toBeLessThanOrEqual(1920);
        expect(p.y + p.h).toBeLessThanOrEqual(1080);
      }
    }
  });

  it('is copied for each deck', () => {
    const copy = createBuiltInLayouts();
    copy[1].placeholders[0].x = 5;
    expect(BUILT_IN_LAYOUTS[1].placeholders[0].x).not.toBe(5);
  });

  it('makes a new deck that passes validation', () => {
    expect(validateDeck(createDeck()).ok).toBe(true);
  });
});

describe('validation of the theme additions', () => {
  const faces = (fontFaces: unknown) => validateTheme({ ...createTheme(), fontFaces }, ['f'.repeat(64)]);

  it('accepts an embedded font whose asset exists', () => {
    expect(faces([{ family: 'Inter', assetId: 'f'.repeat(64) }]).ok).toBe(true);
  });

  it.each([
    ['an unknown asset', [{ family: 'Inter', assetId: 'e'.repeat(64) }], 'fontFaces[0].assetId'],
    ['a family that could close a CSS string', [{ family: 'a"; }', assetId: 'f'.repeat(64) }], 'fontFaces[0].family'],
    ['an empty family', [{ family: '', assetId: 'f'.repeat(64) }], 'fontFaces[0].family'],
    ['an extra field', [{ family: 'Inter', assetId: 'f'.repeat(64), url: 'x' }], 'fontFaces[0]'],
  ])('rejects %s', (_name, fontFaces, path) => {
    const result = faces(fontFaces);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.some((e) => e.path.includes(path))).toBe(true);
  });

  it('rejects an element placeholder that is not a kind', () => {
    const deck = createDeck();
    deck.slides[0].elements.push({ id: 'el_a', type: 'line', x: 0, y: 0, w: 1, h: 0, rotation: 0, stroke: '#000', strokeWidth: 1, placeholder: 'sidebar' } as never);
    const result = validateDeck(deck);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0].path).toBe('slides[0].elements[0].placeholder');
  });
});
