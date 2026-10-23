import { createDeck, createElement } from './factory';
import type { Deck, Element } from './types';
import { validateDeck } from './validate';

const VIDEO = 'b'.repeat(64);
const POSTER = 'a'.repeat(64);

function deckWith(...elements: Element[]): Deck {
  const deck = createDeck('T');
  deck.assets[VIDEO] = { blobKey: 'k1', mime: 'video/mp4', hash: VIDEO, size: 20 };
  deck.assets[POSTER] = { blobKey: 'k2', mime: 'image/png', hash: POSTER, size: 10 };
  deck.slides[0].elements.push(...elements);
  return deck;
}

const problems = (deck: unknown): { path: string; message: string }[] => {
  const result = validateDeck(deck);
  return result.ok ? [] : result.error;
};
const at = '.slides[0].elements[0]'.slice(1);

describe('table element', () => {
  it('accepts the default table and one with every optional field', () => {
    expect(problems(deckWith(createElement('table')))).toEqual([]);
    const full = createElement('table', {
      rows: [['h1', 'h2'], ['a', 'b'], ['c', 'd']],
      header: true,
      columnWidths: [1, 3],
      cellFills: [[{ token: 'accent' }, null], [null, '#ff0000'], [null, null]],
    });
    expect(problems(deckWith(full))).toEqual([]);
  });

  it('starts with a header row and a table-sized height', () => {
    expect(createElement('table')).toMatchObject({ header: true, h: 240, rows: [['', ''], ['', '']] });
  });

  it('accepts a table written before header, widths and fills existed', () => {
    const old = createElement('table');
    delete (old as { header?: boolean }).header;
    expect(problems(deckWith(old))).toEqual([]);
  });

  it.each([
    ['no rows', { rows: [] }, `${at}.rows`, 'must have at least one row'],
    ['an empty row', { rows: [[]] }, `${at}.rows[0]`, 'must have at least one cell'],
    ['ragged rows', { rows: [['a', 'b'], ['c']] }, `${at}.rows[1]`, 'must have 2 cells like the first row'],
    ['a non-string cell', { rows: [[1, 'b']] }, `${at}.rows[0][0]`, 'must be a string'],
    ['rows that are not an array', { rows: 'abc' }, `${at}.rows`, 'must be an array'],
    ['a non-boolean header', { header: 'yes' }, `${at}.header`, 'must be a boolean'],
    ['too few widths', { columnWidths: [1] }, `${at}.columnWidths`, 'must have one width per column (2)'],
    ['a zero width', { columnWidths: [1, 0] }, `${at}.columnWidths[1]`, 'must be >= 5e-324'],
    ['a negative width', { columnWidths: [1, -2] }, `${at}.columnWidths[1]`, 'must be >= 5e-324'],
    ['a NaN width', { columnWidths: [1, Number.NaN] }, `${at}.columnWidths[1]`, 'must be a finite number'],
    ['widths that are not an array', { columnWidths: 5 }, `${at}.columnWidths`, 'must be an array'],
    ['fills with too few rows', { cellFills: [[null, null]] }, `${at}.cellFills`, 'must have one row per table row (2)'],
    ['fills with too few columns', { cellFills: [[null], [null, null]] }, `${at}.cellFills[0]`, 'must have one entry per column (2)'],
    ['an invalid fill colour', { cellFills: [['url(x)', null], [null, null]] }, `${at}.cellFills[0][0]`, 'must be a hex, rgb(), hsl() or keyword colour'],
    ['an unknown theme token', { cellFills: [[{ token: 'nope' }, null], [null, null]] }, `${at}.cellFills[0][0].token`, 'references unknown theme color "nope"'],
    ['an undefined fill', { cellFills: [[undefined, null], [null, null]] }, `${at}.cellFills[0][0]`, 'must be an object'],
    ['an unknown field', { cellWidths: [1] }, `${at}.cellWidths`, 'unknown field'],
  ])('rejects %s', (_name, patch, path, message) => {
    const table = { ...createElement('table'), ...patch } as unknown as Element;
    expect(problems(deckWith(table))).toContainEqual({ path, message });
  });

  it('does not crash on fills or widths when rows are unusable', () => {
    const table = { ...createElement('table'), rows: 7, columnWidths: [1], cellFills: [[null]] } as unknown as Element;
    expect(problems(deckWith(table)).map((p) => p.path)).toContain(`${at}.rows`);
  });
});

describe('video element', () => {
  it('accepts the default video and one with every optional field', () => {
    expect(problems(deckWith(createElement('video', { assetId: VIDEO })))).toEqual([]);
    const full = createElement('video', { assetId: VIDEO, poster: POSTER, autoplay: true, loop: true, muted: true, label: 'Product demo' });
    expect(problems(deckWith(full))).toEqual([]);
  });

  it('accepts a video written before poster, muted and label existed', () => {
    const old = createElement('video', { assetId: VIDEO });
    delete (old as { muted?: boolean }).muted;
    expect(problems(deckWith(old))).toEqual([]);
  });

  it.each([
    ['an unknown poster asset', { poster: 'c'.repeat(64) }, `${at}.poster`, `references unknown asset "${'c'.repeat(64)}"`],
    ['an empty poster', { poster: '' }, `${at}.poster`, 'must be an id (1-128 chars of A-Z a-z 0-9 _ -)'],
    ['a non-boolean muted', { muted: 1 }, `${at}.muted`, 'must be a boolean'],
    ['a non-string label', { label: 3 }, `${at}.label`, 'must be a string'],
    ['an over-long label', { label: 'x'.repeat(1_001) }, `${at}.label`, 'must be at most 1000 characters'],
    ['a non-boolean autoplay', { autoplay: 'yes' }, `${at}.autoplay`, 'must be a boolean'],
  ])('rejects %s', (_name, patch, path, message) => {
    const video = { ...createElement('video', { assetId: VIDEO }), ...patch } as unknown as Element;
    expect(problems(deckWith(video))).toContainEqual({ path, message });
  });

  it('rejects an unknown video asset', () => {
    const video = createElement('video', { assetId: 'c'.repeat(64) });
    expect(problems(deckWith(video)).map((p) => p.path)).toContain(`${at}.assetId`);
  });
});
