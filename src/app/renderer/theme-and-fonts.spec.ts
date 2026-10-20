import { TestBed } from '@angular/core/testing';
import { createDeck, createElement, createSlide, createTheme, type Layout, type Slide, type Theme } from '../core/model';
import { DeckRepository, InMemoryDeckRepository } from '../core/persistence';
import { SlideRenderer } from './slide-renderer';

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const HASH = 'a'.repeat(64);

function create(slide: Slide, theme: Theme, layout?: Layout) {
  const repo = new InMemoryDeckRepository();
  TestBed.configureTestingModule({ providers: [{ provide: DeckRepository, useValue: repo }] });
  const fixture = TestBed.createComponent(SlideRenderer);
  fixture.componentRef.setInput('slide', slide);
  fixture.componentRef.setInput('theme', theme);
  fixture.componentRef.setInput('layout', layout);
  fixture.detectChanges();
  const stage = () => (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.stage')!;
  return { fixture, stage, repo };
}

beforeEach(() => vi.stubGlobal('ResizeObserver', FakeResizeObserver));
afterEach(() => vi.unstubAllGlobals());

describe('SlideRenderer: theme and layout', () => {
  const slide = (): Slide => ({ ...createSlide('ly_x'), elements: [createElement('text', { text: 'Hi', color: { token: 'accent' } })] });

  it('restyles the same slide when only the theme changes: elements keep their token references', () => {
    const { fixture, stage } = create(slide(), createTheme('light'));
    expect(stage().style.getPropertyValue('--deck-color-accent')).toBe('#2457d6');
    const text = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('app-text-element')!;
    const colourBefore = text.innerHTML;
    fixture.componentRef.setInput('theme', createTheme('dark'));
    fixture.detectChanges();
    expect(stage().style.getPropertyValue('--deck-color-accent')).toBe('#8ab4ff');
    expect(stage().style.getPropertyValue('--deck-color-background')).toBe('#14161a');
    expect(text.innerHTML).toBe(colourBefore); // the element markup refers to var(--deck-color-accent) and is unchanged
  });

  it('draws the layout background where the slide has none, and the slide’s own over it', () => {
    const layout: Layout = { id: 'ly_x', name: 'X', placeholders: [], background: { kind: 'solid', color: '#00ff00' } };
    const { fixture, stage } = create(slide(), createTheme(), layout);
    expect(stage().style.backgroundColor).toBe('rgb(0, 255, 0)');
    fixture.componentRef.setInput('slide', { ...slide(), background: { kind: 'solid', color: '#ff0000' } });
    fixture.detectChanges();
    expect(stage().style.backgroundColor).toBe('rgb(255, 0, 0)');
    fixture.componentRef.setInput('slide', slide());
    fixture.componentRef.setInput('layout', undefined);
    fixture.detectChanges();
    expect(stage().style.backgroundColor).toBe('var(--deck-color-background)');
  });
});

describe('embedded fonts', () => {
  class FakeFontFace {
    static instances: FakeFontFace[] = [];
    loaded = false;
    constructor(
      readonly family: string,
      readonly source: string,
    ) {
      FakeFontFace.instances.push(this);
    }
    load(): Promise<FakeFontFace> {
      this.loaded = true;
      return Promise.resolve(this);
    }
  }
  const added: unknown[] = [];
  const deleted: unknown[] = [];

  beforeEach(() => {
    FakeFontFace.instances = [];
    added.length = 0;
    deleted.length = 0;
    vi.stubGlobal('FontFace', FakeFontFace);
    Object.defineProperty(document, 'fonts', { configurable: true, value: { add: (f: unknown) => added.push(f), delete: (f: unknown) => deleted.push(f) } });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:font'), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => Reflect.deleteProperty(document, 'fonts'));

  const themeWithFont = (): Theme => ({ ...createDeck().theme, fontFaces: [{ family: 'Inter', assetId: HASH }] });
  const flush = async (fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r));
      fixture.detectChanges();
    }
    await fixture.whenStable();
  };

  it('loads an embedded font with FontFace once its blob has been read, only once, and drops it on destroy', async () => {
    const { fixture, repo } = create(createSlide('ly'), themeWithFont());
    expect(FakeFontFace.instances).toHaveLength(0); // the blob is not read yet
    // The asset id is a content hash, so the theme has to name what the store returns.
    const stored = await repo.putAsset(new Blob([new Uint8Array([1, 2, 3])], { type: 'font/woff2' }));
    if (!stored.ok) throw new Error('put failed');
    fixture.componentRef.setInput('theme', { ...createDeck().theme, fontFaces: [{ family: 'Inter', assetId: stored.value.ref.hash }] });
    await flush(fixture);
    fixture.componentRef.setInput('theme', { ...createDeck().theme, fontFaces: [{ family: 'Inter', assetId: stored.value.ref.hash }] });
    await flush(fixture);
    expect(FakeFontFace.instances).toHaveLength(1);
    expect(FakeFontFace.instances[0]).toMatchObject({ family: 'Inter', loaded: true });
    expect(FakeFontFace.instances[0].source).toBe('url("blob:font")');
    expect(added).toEqual(FakeFontFace.instances);
    fixture.destroy();
    TestBed.resetTestingModule();
    expect(deleted).toEqual(FakeFontFace.instances);
  });

  it('removes a face the theme no longer lists', async () => {
    const { fixture, repo } = create(createSlide('ly'), createDeck().theme);
    const stored = await repo.putAsset(new Blob([new Uint8Array([9, 9])], { type: 'font/woff2' }));
    if (!stored.ok) throw new Error('put failed');
    fixture.componentRef.setInput('theme', { ...createDeck().theme, fontFaces: [{ family: 'Inter', assetId: stored.value.ref.hash }] });
    await flush(fixture);
    expect(added).toHaveLength(1);
    fixture.componentRef.setInput('theme', createDeck().theme);
    await flush(fixture);
    expect(deleted).toEqual(added);
  });

  it('does nothing for a font whose asset cannot be read', async () => {
    const { fixture } = create(createSlide('ly'), themeWithFont());
    await flush(fixture);
    expect(FakeFontFace.instances).toHaveLength(0);
  });

  it('is silent where the FontFace API does not exist', () => {
    vi.stubGlobal('FontFace', undefined);
    expect(() => create(createSlide('ly'), themeWithFont())).not.toThrow();
  });
});
