import { TestBed, type ComponentFixture } from '@angular/core/testing';
import axe from 'axe-core';
import { createDeck, createElement, createSlide, type Element, type Slide, type Theme } from '../core/model';
import { DeckRepository, InMemoryDeckRepository } from '../core/persistence';
import { RENDER_PROBE } from './element-view';
import { SlideRenderer } from './slide-renderer';
import type { RenderMode } from './visibility';

/** jsdom has no ResizeObserver; this one lets a test report a size. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  resize(width: number): void {
    this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

type Fixture = ComponentFixture<SlideRenderer>;

const theme: Theme = createDeck().theme;
const root = (fixture: Fixture): HTMLElement => fixture.nativeElement as HTMLElement;
const stageOf = (fixture: Fixture): HTMLElement => root(fixture).querySelector('.stage')!;
const paragraphs = (fixture: Fixture): string[] =>
  Array.from(root(fixture).querySelectorAll('p'), (p) => p.textContent);

function sampleSlide(): Slide {
  const slide = createSlide('layout');
  slide.elements = [
    createElement('text', { x: 100, y: 80, w: 1200, h: 140, text: 'Quarterly review', font: 'heading', fontSize: 96 }),
    createElement('text', { x: 100, y: 300, w: 1200, h: 300, text: '- Revenue up\n- Costs down', fontSize: 48 }),
    createElement('shape', { x: 1300, y: 300, w: 400, h: 400, shape: 'ellipse', stroke: '#000000', strokeWidth: 8 }),
    createElement('line', { x: 100, y: 700, w: 1000, h: 0 }),
    createElement('image', { x: 1300, y: 80, w: 400, h: 200, alt: 'Company logo' }),
  ];
  return slide;
}

const withElement = (slide: Slide, index: number, patch: Record<string, unknown>): Slide => ({
  ...slide,
  elements: slide.elements.map((el, i) => (i === index ? ({ ...el, ...patch } as Element) : el)),
});

function create(repo: DeckRepository, slide: Slide, inputs: { mode?: RenderMode; step?: number } = {}): Fixture {
  const fixture = TestBed.createComponent(SlideRenderer);
  fixture.componentRef.setInput('slide', slide);
  fixture.componentRef.setInput('theme', theme);
  if (inputs.mode) fixture.componentRef.setInput('mode', inputs.mode);
  if (inputs.step !== undefined) fixture.componentRef.setInput('step', inputs.step);
  fixture.detectChanges();
  return fixture;
}

function setup(slide: Slide, inputs: { mode?: RenderMode; step?: number } = {}, probe?: (id: string) => void): Fixture {
  const repo = new InMemoryDeckRepository();
  TestBed.configureTestingModule({
    providers: [
      { provide: DeckRepository, useValue: repo },
      ...(probe ? [{ provide: RENDER_PROBE, useValue: probe }] : []),
    ],
  });
  return create(repo, slide, inputs);
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => vi.unstubAllGlobals());

describe('SlideRenderer scaling', () => {
  it.each([
    [1920, 1],
    [960, 0.5],
    [480, 0.25],
  ])('scales the stage for a %i px container', async (width, expected) => {
    const fixture = setup(sampleSlide());
    await fixture.whenStable();
    FakeResizeObserver.instances[0].resize(width);
    fixture.detectChanges();
    expect(fixture.componentInstance.scale()).toBe(expected);
    expect(stageOf(fixture).style.transform).toBe(`scale(${expected})`);
    expect(stageOf(fixture).style.width).toBe('1920px');
    expect(stageOf(fixture).style.height).toBe('1080px');
  });

  it('follows a per-deck stage size', async () => {
    const fixture = setup(sampleSlide());
    fixture.componentRef.setInput('stage', { width: 1440, height: 1080 });
    await fixture.whenStable();
    FakeResizeObserver.instances[0].resize(720);
    fixture.detectChanges();
    expect(fixture.componentInstance.scale()).toBe(0.5);
    expect(root(fixture).style.aspectRatio).toBe('1440 / 1080');
  });

  it('has scale 0 before the container has a width, and stops observing on destroy', async () => {
    const fixture = setup(sampleSlide());
    await fixture.whenStable();
    expect(fixture.componentInstance.scale()).toBe(0);
    fixture.destroy();
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
  });
});

describe('SlideRenderer content', () => {
  it('renders elements in array (z) order with their geometry and rotation', () => {
    const slide = sampleSlide();
    slide.elements[2] = { ...slide.elements[2], rotation: 30 } as Element;
    const fixture = setup(slide);
    const hosts = Array.from(stageOf(fixture).children) as HTMLElement[];
    expect(hosts.map((h) => h.tagName.toLowerCase())).toEqual([
      'app-text-element',
      'app-text-element',
      'app-shape-element',
      'app-line-element',
      'app-image-element',
    ]);
    expect(hosts[0].style.left).toBe('100px');
    expect(hosts[0].style.top).toBe('80px');
    expect(hosts[0].style.width).toBe('1200px');
    expect(hosts[2].style.transform).toBe('rotate(30deg)');
    expect(hosts[3].style.transform).toBe('');
  });

  it('outputs semantic HTML: heading, list and image alt text', () => {
    const fixture = setup(sampleSlide());
    expect(root(fixture).querySelector('h2')?.textContent).toBe('Quarterly review');
    expect(Array.from(root(fixture).querySelectorAll('li'), (li) => li.textContent)).toEqual([
      'Revenue up',
      'Costs down',
    ]);
    expect(root(fixture).querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Company logo');
  });

  it('applies theme tokens as custom properties on the stage', () => {
    const fixture = setup(sampleSlide());
    expect(stageOf(fixture).style.getPropertyValue('--deck-color-accent')).toBe('#2457d6');
    expect(stageOf(fixture).style.getPropertyValue('--deck-font-heading')).toBe('sans-serif');
    expect(stageOf(fixture).style.getPropertyValue('--deck-space-lg')).toBe('64px');
  });

  it('uses the slide background, falling back to the theme background', () => {
    const slide = sampleSlide();
    const fixture = setup(slide);
    expect(stageOf(fixture).style.backgroundColor).toBe('var(--deck-color-background)');
    fixture.componentRef.setInput('slide', { ...slide, background: { kind: 'solid', color: '#ff0000' } });
    fixture.detectChanges();
    expect(stageOf(fixture).style.backgroundColor).toBe('rgb(255, 0, 0)');
  });

  it('ignores hostile element data instead of passing it on', () => {
    const slide = createSlide('layout');
    slide.elements = [
      createElement('shape', {
        x: Number.NaN,
        w: -5,
        fill: { kind: 'solid', color: 'red; display: none' },
        stroke: 'x) url(y',
        strokeWidth: 4,
      }),
      createElement('text', { color: { token: '__proto__' }, font: 'constructor', text: 'hi' }),
    ];
    const fixture = setup(slide);
    const [shape, label] = Array.from(stageOf(fixture).children) as HTMLElement[];
    expect(shape.style.left).toBe('0px');
    expect(shape.style.width).toBe('0px');
    const inner = shape.firstElementChild as HTMLElement;
    expect(inner.style.display).toBe('');
    expect(inner.style.border).toBe('');
    expect((label.firstElementChild as HTMLElement).style.fontFamily).toBe('var(--deck-font-body, sans-serif)');
  });
});

describe('SlideRenderer visibility', () => {
  const gated = (): Slide => {
    const slide = createSlide('layout');
    slide.elements = [
      createElement('text', { text: 'always' }),
      createElement('text', { text: 'step one', step: 1 }),
      createElement('text', { text: 'step two', step: 2 }),
      createElement('text', { text: 'hidden', hidden: true }),
    ];
    return slide;
  };

  it.each([
    [0, ['always']],
    [1, ['always', 'step one']],
    [2, ['always', 'step one', 'step two']],
  ])('presenting at step %i omits later steps and hidden elements from the DOM', (step, visible) => {
    const fixture = setup(gated(), { mode: 'present', step });
    expect(paragraphs(fixture)).toEqual(visible);
  });

  it('shows every revealed step by default (thumbnails, export), but not hidden elements', () => {
    const fixture = setup(gated(), { mode: 'thumbnail' });
    expect(paragraphs(fixture)).toEqual(['always', 'step one', 'step two']);
  });

  it('keeps all elements in the editor, with hidden ones dimmed and out of the a11y tree', () => {
    const fixture = setup(gated(), { mode: 'edit', step: 0 });
    const hosts = Array.from(stageOf(fixture).children) as HTMLElement[];
    expect(hosts).toHaveLength(4);
    expect(hosts.map((h) => h.classList.contains('ghost'))).toEqual([false, false, false, true]);
    expect(hosts[3].getAttribute('aria-hidden')).toBe('true');
    expect(hosts[0].getAttribute('aria-hidden')).toBeNull();
  });

  it('reacts to step changes', () => {
    const fixture = setup(gated(), { mode: 'present', step: 0 });
    fixture.componentRef.setInput('step', 1);
    fixture.detectChanges();
    expect(paragraphs(fixture)).toEqual(['always', 'step one']);
  });

  it('marks thumbnails inert and hidden from assistive technology', () => {
    const fixture = setup(gated(), { mode: 'thumbnail' });
    const stage = stageOf(fixture);
    expect(stage.getAttribute('aria-hidden')).toBe('true');
    expect(stage.hasAttribute('inert')).toBe(true);
    expect(stage.getAttribute('role')).toBeNull();
  });
});

describe('SlideRenderer change detection', () => {
  it('re-renders only the element whose props changed', () => {
    const renders: string[] = [];
    const slide = sampleSlide();
    const fixture = setup(slide, {}, (id) => renders.push(id));
    expect(renders).toHaveLength(5);

    renders.length = 0;
    fixture.componentRef.setInput('slide', withElement(slide, 1, { text: '- Revenue up\n- Costs down\n- Hiring' }));
    fixture.detectChanges();
    expect(renders).toEqual([slide.elements[1].id]);
    expect(root(fixture).textContent).toContain('Hiring');
  });

  it('only renders the new element when another one is added', () => {
    const renders: string[] = [];
    const slide = sampleSlide();
    const fixture = setup(slide, {}, (id) => renders.push(id));
    renders.length = 0;
    const added = createElement('line');
    fixture.componentRef.setInput('slide', { ...slide, elements: [...slide.elements, added] });
    fixture.detectChanges();
    expect(renders).toEqual([added.id]);
    expect(stageOf(fixture).children).toHaveLength(6);
  });

  it('reuses the DOM of untouched elements', () => {
    const slide = sampleSlide();
    const fixture = setup(slide);
    const before = Array.from(stageOf(fixture).children);
    fixture.componentRef.setInput('slide', withElement(slide, 0, { x: 5 }));
    fixture.detectChanges();
    expect(Array.from(stageOf(fixture).children)).toEqual(before);
    expect((before[0] as HTMLElement).style.left).toBe('5px');
  });
});

describe('ImageElement assets', () => {
  const hash = 'a'.repeat(64);

  function imageSlide(assetId: string): Slide {
    const slide = createSlide('layout');
    slide.elements = [createElement('image', { assetId, alt: 'Logo' })];
    return slide;
  }

  it('shows the image once the asset is read from the repository', async () => {
    const repo = new InMemoryDeckRepository();
    vi.spyOn(repo, 'getAsset').mockResolvedValue({ ok: true, value: new Blob(['x'], { type: 'image/png' }) });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }));
    TestBed.configureTestingModule({ providers: [{ provide: DeckRepository, useValue: repo }] });
    const fixture = create(repo, imageSlide(hash));
    expect(root(fixture).querySelector('img')).toBeNull();
    await fixture.whenStable();
    fixture.detectChanges();
    const img = root(fixture).querySelector('img');
    expect(img?.getAttribute('src')).toBe('blob:test');
    expect(img?.getAttribute('alt')).toBe('Logo');
    expect(repo.getAsset).toHaveBeenCalledWith(hash);
  });

  it('keeps the placeholder for ids that are not content hashes, without touching the repository', async () => {
    const repo = new InMemoryDeckRepository();
    const spy = vi.spyOn(repo, 'getAsset');
    TestBed.configureTestingModule({ providers: [{ provide: DeckRepository, useValue: repo }] });
    const fixture = create(repo, imageSlide('../secret'));
    await fixture.whenStable();
    expect(spy).not.toHaveBeenCalled();
    expect(root(fixture).querySelector('[role="img"]')).not.toBeNull();
  });
});

describe('SlideRenderer accessibility', () => {
  it('has no AXE violations on a sample slide', async () => {
    const fixture = setup(sampleSlide(), { mode: 'present' });
    document.body.appendChild(root(fixture));
    try {
      // jsdom has no layout or computed colours, so contrast is covered by the theme palette instead.
      const results = await axe.run(root(fixture), { rules: { 'color-contrast': { enabled: false } } });
      expect(results.violations).toEqual([]);
    } finally {
      root(fixture).remove();
    }
  });
});
