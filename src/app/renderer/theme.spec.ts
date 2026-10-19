import { createDeck, type Fill } from '../core/model';
import { fillStyle, resolveColor, resolveFont, themeVars } from './theme';
import { parseText } from './text-blocks';

const theme = createDeck().theme;

describe('themeVars', () => {
  it('maps every token group to a --deck-* custom property', () => {
    const vars = themeVars(theme);
    expect(vars['--deck-color-accent']).toBe('#2457d6');
    expect(vars['--deck-font-body']).toBe('sans-serif');
    expect(vars['--deck-type-title']).toBe('96px');
    expect(vars['--deck-space-md']).toBe('32px');
  });

  it('skips unsafe keys and values', () => {
    const vars = themeVars({
      colors: { 'a b': '#fff', ok: 'red', bad: 'red; background: url(x)' },
      fonts: { body: 'Arial', evil: 'x; } body { display: none', url: 'url(http://x)' },
      typeScale: { n: Number.NaN },
      spacing: {},
    });
    expect(Object.keys(vars).sort()).toEqual(['--deck-color-ok', '--deck-font-body']);
  });
});

describe('resolveColor', () => {
  it.each([
    ['literal hex', '#abc', '#abc'],
    ['literal function', 'rgb(1, 2, 3)', 'rgb(1, 2, 3)'],
    ['token', { token: 'accent' }, 'var(--deck-color-accent)'],
    ['unknown token', { token: 'nope' }, null],
    ['inherited token name', { token: 'toString' }, null],
    ['token with unsafe key', { token: 'a);b' }, null],
    ['smuggled css', 'red), url(http://x', null],
    ['undefined', undefined, null],
  ])('%s', (_name, color, expected) => {
    expect(resolveColor(color, theme)).toBe(expected);
  });
});

describe('resolveFont', () => {
  it('uses the key, and the body font for missing or unknown keys', () => {
    expect(resolveFont('mono', theme)).toBe('var(--deck-font-mono, sans-serif)');
    expect(resolveFont(undefined, theme)).toBe('var(--deck-font-body, sans-serif)');
    expect(resolveFont('constructor', theme)).toBe('var(--deck-font-body, sans-serif)');
  });
});

describe('fillStyle', () => {
  const none = () => null;

  it('solid, gradient and image fills', () => {
    expect(fillStyle({ kind: 'solid', color: { token: 'accent' } }, theme, none)).toEqual({
      'background-color': 'var(--deck-color-accent)',
    });
    expect(
      fillStyle(
        { kind: 'gradient', angle: 90, stops: [{ offset: 0, color: 'red' }, { offset: 1, color: '#000' }] },
        theme,
        none,
      ),
    ).toEqual({ 'background-image': 'linear-gradient(90deg, red 0%, #000 100%)' });
    expect(fillStyle({ kind: 'image', assetId: 'a', fit: 'stretch' }, theme, () => 'blob:x')['background-size']).toBe(
      '100% 100%',
    );
  });

  it('drops hostile or unusable parts instead of passing them on', () => {
    const hostile: Fill = {
      kind: 'gradient',
      angle: 0,
      stops: [{ offset: 0, color: 'red), url(x' }, { offset: 1, color: 'blue' }],
    };
    expect(fillStyle(hostile, theme, none)).toEqual({});
    expect(fillStyle({ kind: 'image', assetId: 'a', fit: 'cover' }, theme, none)).toEqual({});
    expect(fillStyle(undefined, theme, none)).toEqual({});
  });
});

describe('parseText', () => {
  it('splits paragraphs and groups bullet lines', () => {
    expect(parseText('Title\n\n- one\n* two\nafter\r\n• three')).toEqual([
      { kind: 'paragraph', text: 'Title' },
      { kind: 'list', items: ['one', 'two'] },
      { kind: 'paragraph', text: 'after' },
      { kind: 'list', items: ['three'] },
    ]);
  });

  it('gives nothing for empty text', () => {
    expect(parseText('')).toEqual([]);
    expect(parseText('  \n ')).toEqual([]);
  });
});
