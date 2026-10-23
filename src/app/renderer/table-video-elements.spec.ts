import { TestBed, type ComponentFixture } from '@angular/core/testing';
import axe from 'axe-core';
import { createDeck, createElement, createSlide, type Element, type Slide, type Theme } from '../core/model';
import { DeckRepository, InMemoryDeckRepository } from '../core/persistence';
import { SlideRenderer } from './slide-renderer';
import { readableOn } from './table-element';
import type { RenderMode } from './visibility';

const HASH = 'a'.repeat(64);
const POSTER = 'b'.repeat(64);
const theme: Theme = createDeck().theme;
const root = (f: ComponentFixture<SlideRenderer>): HTMLElement => f.nativeElement as HTMLElement;

function render(elements: Element[], inputs: { mode?: RenderMode; distance?: number; step?: number; repo?: InMemoryDeckRepository } = {}): ComponentFixture<SlideRenderer> {
  const repo = inputs.repo ?? new InMemoryDeckRepository();
  TestBed.configureTestingModule({ providers: [{ provide: DeckRepository, useValue: repo }] });
  const slide: Slide = { ...createSlide('layout'), elements };
  const fixture = TestBed.createComponent(SlideRenderer);
  fixture.componentRef.setInput('slide', slide);
  fixture.componentRef.setInput('theme', theme);
  if (inputs.mode) fixture.componentRef.setInput('mode', inputs.mode);
  if (inputs.step !== undefined) fixture.componentRef.setInput('step', inputs.step);
  if (inputs.distance !== undefined) fixture.componentRef.setInput('distance', inputs.distance);
  fixture.detectChanges();
  return fixture;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

const sample = (patch: Record<string, unknown> = {}) =>
  createElement('table', { rows: [['Name', 'Qty'], ['Apples', '3'], ['Pears', '5']], header: true, ...patch });

describe('table rendering', () => {
  it('emits a semantic table: a header of th scope=col and the rest as td', () => {
    const f = render([sample()]);
    const html = root(f);
    expect(Array.from(html.querySelectorAll('thead th'), (th) => [th.textContent, th.getAttribute('scope')])).toEqual([['Name', 'col'], ['Qty', 'col']]);
    expect(Array.from(html.querySelectorAll('tbody tr'), (tr) => Array.from(tr.querySelectorAll('td'), (td) => td.textContent))).toEqual([['Apples', '3'], ['Pears', '5']]);
    expect(html.querySelectorAll('tbody th')).toHaveLength(0);
  });

  it.each([false, undefined])('has no header row when header is %s', (header) => {
    const f = render([sample({ header })]);
    expect(root(f).querySelector('thead')).toBeNull();
    expect(root(f).querySelector('th')).toBeNull();
    expect(root(f).querySelectorAll('tbody tr')).toHaveLength(3);
  });

  it('keeps a header-only table valid: a header and an empty body', () => {
    const f = render([sample({ rows: [['A', 'B']] })]);
    expect(root(f).querySelectorAll('thead th')).toHaveLength(2);
    expect(root(f).querySelectorAll('tbody tr')).toHaveLength(0);
  });

  it('sizes columns by relative width, and equally without widths', () => {
    const widths = (el: Element) => Array.from(root(render([el])).querySelectorAll('col'), (c) => Number.parseFloat(c.style.width));
    expect(widths(sample({ columnWidths: [1, 3] }))).toEqual([25, 75]);
    TestBed.resetTestingModule();
    expect(widths(sample())).toEqual([50, 50]);
  });

  it.each([[[0, 1]], [[1, -1]], [[1, Number.NaN]], [[1]], [[1, 2, 3]]])('falls back to equal widths for the unusable widths %j', (columnWidths) => {
    const cols = Array.from(root(render([sample({ columnWidths })])).querySelectorAll('col'), (c) => Number.parseFloat(c.style.width));
    expect(cols).toEqual([50, 50]);
  });

  it('fills a cell with a theme token or a colour and picks readable text for it', () => {
    const f = render([sample({ cellFills: [[{ token: 'accent' }, null], [null, '#000000'], [null, '#ffffff']] })]);
    const cells = Array.from(root(f).querySelectorAll<HTMLElement>('th, td'));
    expect(cells[0].style.backgroundColor).toBe('var(--deck-color-accent)');
    expect(cells[3].style.backgroundColor).toBe('rgb(0, 0, 0)');
    expect(cells[3].style.color).not.toBe('');
    expect(cells[1].style.backgroundColor).toBe('');
    expect(cells[1].style.color).toBe('');
  });

  it('chooses the theme text colour on a light fill and the theme background on a dark one', () => {
    const custom: Theme = { ...theme, colors: { ...theme.colors, text: '#111111', background: '#ffffff' } };
    expect(readableOn('#ffffff', custom)).toBe('var(--deck-color-text)');
    expect(readableOn('#000000', custom)).toBe('var(--deck-color-background)');
    expect(readableOn({ token: 'unknown' }, custom)).toBeNull();
    expect(readableOn('rebeccapurple', custom)).toBeNull();
  });

  it('shows cell text as text, never as markup', () => {
    const f = render([sample({ rows: [['<img src=x onerror=alert(1)>', '<b>bold</b>']] })]);
    expect(root(f).querySelector('img')).toBeNull();
    expect(root(f).querySelector('b')).toBeNull();
    expect(root(f).querySelector('th')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('ignores a colour that is not a plain colour instead of writing it into a style', () => {
    const f = render([sample({ cellFills: [['red; background: url(https://evil.test/x)', { token: '../x' }], [null, null], [null, null]] })]);
    root(f)
      .querySelectorAll<HTMLElement>('th')
      .forEach((th) => expect(th.getAttribute('style') ?? '').not.toContain('evil'));
    expect(root(f).querySelector<HTMLElement>('th')?.style.backgroundColor).toBe('');
  });

  it('survives rows that are not a grid', () => {
    for (const rows of [undefined, 'abc', [], [null, ['ok']], [[1, 'a']], [['a'], ['b', 'c']]]) {
      TestBed.resetTestingModule();
      expect(() => render([sample({ rows })])).not.toThrow();
    }
  });

  it('is left out of the output when hidden in present mode, and kept as a ghost in the editor', () => {
    const hidden = sample({ hidden: true });
    expect(root(render([hidden], { mode: 'present' })).querySelector('table')).toBeNull();
    TestBed.resetTestingModule();
    const edit = render([hidden], { mode: 'edit' });
    expect(root(edit).querySelector('app-table-element')?.getAttribute('aria-hidden')).toBe('true');
  });

  it.each<RenderMode>(['edit', 'present', 'thumbnail'])('renders in %s mode and passes axe', async (mode) => {
    const f = render([sample({ cellFills: [[{ token: 'accent' }, null], [null, null], [null, null]] })], { mode });
    expect(root(f).querySelector('table')).not.toBeNull();
    const result = await axe.run(root(f), { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('video rendering', () => {
  const video = (patch: Record<string, unknown> = {}) => createElement('video', { assetId: HASH, poster: POSTER, label: 'Product demo', ...patch });

  function repoWith(): InMemoryDeckRepository {
    const repo = new InMemoryDeckRepository();
    vi.spyOn(repo, 'getAsset').mockImplementation(async (id: string) => ({ ok: true, value: new Blob([id.slice(0, 1)], { type: id === HASH ? 'video/mp4' : 'image/png' }) }));
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => `blob:${b.type}`), revokeObjectURL: vi.fn() }));
    return repo;
  }

  const player = (f: ComponentFixture<SlideRenderer>) => root(f).querySelector<HTMLVideoElement>('video')!;

  async function settled(f: ComponentFixture<SlideRenderer>): Promise<void> {
    // The video and its poster load one after the other, each a promise of its own.
    for (let i = 0; i < 3; i++) {
      await f.whenStable();
      f.detectChanges();
    }
  }

  it('plays in present mode: source, controls, poster and an accessible name', async () => {
    const f = render([video({ loop: true })], { mode: 'present', repo: repoWith() });
    await settled(f);
    const v = player(f);
    expect(v.getAttribute('src')).toBe('blob:video/mp4');
    expect(v.getAttribute('poster')).toBe('blob:image/png');
    expect(v.controls).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.autoplay).toBe(false);
    expect(v.muted).toBe(false);
    expect(v.getAttribute('aria-label')).toBe('Product demo');
  });

  it('autoplays only when asked, and then silently because browsers allow nothing else', async () => {
    const f = render([video({ autoplay: true })], { mode: 'present', repo: repoWith() });
    await settled(f);
    expect(player(f).autoplay).toBe(true);
    expect(player(f).muted).toBe(true);
  });

  it('honours muted without autoplay', async () => {
    const f = render([video({ muted: true })], { mode: 'present', repo: repoWith() });
    await settled(f);
    expect(player(f).muted).toBe(true);
    expect(player(f).autoplay).toBe(false);
  });

  it.each<RenderMode>(['thumbnail', 'edit'])('does not load or play the video in %s mode: a paused poster', async (mode) => {
    const repo = repoWith();
    const f = render([video({ autoplay: true })], { mode, repo });
    await settled(f);
    const v = player(f);
    expect(v.hasAttribute('src')).toBe(false);
    expect(v.controls).toBe(false);
    expect(v.autoplay).toBe(false);
    expect(v.getAttribute('poster')).toBe('blob:image/png');
    expect(repo.getAsset).not.toHaveBeenCalledWith(HASH);
  });

  it('draws a slide that is only preloaded (distance > 0) like a thumbnail, so nothing plays off screen', async () => {
    const repo = repoWith();
    const f = render([video({ autoplay: true })], { mode: 'present', distance: 1, repo });
    await settled(f);
    expect(player(f).hasAttribute('src')).toBe(false);
    expect(player(f).autoplay).toBe(false);
    expect(repo.getAsset).not.toHaveBeenCalledWith(HASH);
  });

  it('starts playing when the preloaded slide becomes the shown one', async () => {
    const f = render([video({ autoplay: true })], { mode: 'present', distance: 1, repo: repoWith() });
    await settled(f);
    f.componentRef.setInput('distance', 0);
    await settled(f);
    expect(player(f).getAttribute('src')).toBe('blob:video/mp4');
    expect(player(f).autoplay).toBe(true);
  });

  it('shows a labelled placeholder when the video cannot be read, and falls back to the name "Video"', async () => {
    const repo = new InMemoryDeckRepository();
    vi.spyOn(repo, 'getAsset').mockResolvedValue({ ok: false, error: { kind: 'not-found', message: 'gone' } } as never);
    const f = render([video({ label: undefined })], { mode: 'present', repo });
    await settled(f);
    const missing = root(f).querySelector('.missing')!;
    expect(missing.getAttribute('aria-label')).toBe('Video');
    expect(root(f).querySelector('video')).toBeNull();
  });

  it('does not request an asset id that is not a hash', async () => {
    const repo = repoWith();
    const f = render([video({ assetId: '../secret', poster: '../other' })], { mode: 'present', repo });
    await settled(f);
    expect(repo.getAsset).not.toHaveBeenCalled();
  });

  it('is left out of the output until its step is reached', () => {
    const f = render([video({ step: 2 })], { mode: 'present', step: 1 });
    expect(root(f).querySelector('app-video-element')).toBeNull();
    f.componentRef.setInput('step', 2);
    f.detectChanges();
    expect(root(f).querySelector('app-video-element')).not.toBeNull();
  });

  it.each<RenderMode>(['edit', 'present', 'thumbnail'])('renders in %s mode and passes axe', async (mode) => {
    const f = render([video()], { mode, repo: repoWith() });
    await settled(f);
    const result = await axe.run(root(f), { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});
