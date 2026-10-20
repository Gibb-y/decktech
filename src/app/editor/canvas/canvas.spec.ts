import { TestBed, type ComponentFixture } from '@angular/core/testing';
import axe from 'axe-core';
import { createDeck, createElement, type Deck, type Element } from '../../core/model';
import { DeckRepository, InMemoryDeckRepository } from '../../core/persistence';
import { CLOCK, DeckStore } from '../../core/store';
import { RENDER_PROBE } from '../../renderer';
import { LiveAnnouncer } from '../../shared';
import { Canvas } from './canvas';
import { corners } from './geometry';
import { createStressDeck } from './stress-deck';

let now = 0;
const probe = vi.fn();

beforeAll(() => {
  // jsdom has no layout: give the canvas area a size.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
});

afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)['clientWidth'];
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)['clientHeight'];
});

afterEach(() => document.body.replaceChildren());

interface Options {
  elements?: Element[];
  deck?: Deck;
  /** Zoom to apply (stage units → pixels); default is the fitted zoom. */
  zoom?: number;
}

function setup(options: Options = {}) {
  now = 0;
  probe.mockClear();
  TestBed.configureTestingModule({
    providers: [
      { provide: CLOCK, useValue: () => now },
      { provide: DeckRepository, useClass: InMemoryDeckRepository },
      { provide: RENDER_PROBE, useValue: probe },
    ],
  });
  const store = TestBed.inject(DeckStore);
  const base = options.deck ?? createDeck();
  const elements = options.elements ?? [
    createElement('text', { x: 200, y: 200, w: 400, h: 200, text: 'First' }),
    createElement('shape', { x: 900, y: 400, w: 300, h: 200, shape: 'rect' }),
    createElement('shape', { x: 1400, y: 700, w: 200, h: 200, shape: 'ellipse' }),
  ];
  if (!options.deck) {
    const [slide] = base.slides;
    store.load({ ...base, slides: [{ ...slide, elements }] });
  } else store.load(base);
  const announce = vi.spyOn(TestBed.inject(LiveAnnouncer), 'announce');
  const fixture = TestBed.createComponent(Canvas);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  const canvas = fixture.componentInstance;
  if (options.zoom !== undefined) {
    canvas.actualSize();
    canvas.zoomBy(options.zoom);
  }
  fixture.detectChanges();
  return { fixture, canvas, store, announce, ids: store.currentSlide().elements.map((e) => e.id) };
}

type Fixture = ComponentFixture<Canvas>;
const root = (f: Fixture) => f.nativeElement as HTMLElement;
const area = (f: Fixture) => root(f).querySelector<HTMLElement>('.viewport')!;
const hits = (f: Fixture) => Array.from(root(f).querySelectorAll<HTMLElement>('.hit'));
const handle = (f: Fixture, name: string) => root(f).querySelector<HTMLElement>(`.handle.h-${name}`)!;

/** Client position of a stage point at the current viewport (the area sits at the page origin in jsdom). */
const px = (c: Canvas, x: number, y: number) => {
  const v = c.viewport();
  return { x: x * v.zoom + v.panX, y: y * v.zoom + v.panY };
};

function fire(target: Element | HTMLElement, type: string, at: { x: number; y: number }, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 0, ...init });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  (target as HTMLElement).dispatchEvent(event);
  return event;
}

/** Press on `target` at a stage point, move through `path` (stage points), release. */
function drag(f: Fixture, target: HTMLElement, from: [number, number], path: [number, number][], init: MouseEventInit = {}): void {
  const c = f.componentInstance;
  fire(target, 'pointerdown', px(c, ...from), init);
  for (const p of path) {
    fire(area(f), 'pointermove', px(c, ...p), init);
    f.detectChanges();
  }
  fire(area(f), 'pointerup', px(c, ...path[path.length - 1]), init);
  f.detectChanges();
}

function key(f: Fixture, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  area(f).dispatchEvent(event);
  f.detectChanges();
  return event;
}

const stored = (store: DeckStore, id: string) => store.currentSlide().elements.find((e) => e.id === id)!;

describe('Canvas selection', () => {
  it('draws one overlay target per element, in z-order, over the renderer in edit mode', () => {
    const { fixture, ids } = setup();
    expect(hits(fixture)).toHaveLength(ids.length);
    expect(root(fixture).querySelector('app-slide-renderer')).toBeTruthy();
    expect(root(fixture).querySelector('.frame')).toBeNull();
  });

  it('selects on click and announces it; clicking empty space clears', () => {
    const { fixture, store, ids, announce } = setup();
    fire(hits(fixture)[1], 'pointerdown', px(fixture.componentInstance, 1000, 500));
    fire(area(fixture), 'pointerup', px(fixture.componentInstance, 1000, 500));
    fixture.detectChanges();
    expect(store.selection()).toEqual([ids[1]]);
    expect(announce).toHaveBeenLastCalledWith('Rectangle, 2 of 3, selected');
    expect(root(fixture).querySelector('.frame')).toBeTruthy();
    fire(area(fixture), 'pointerdown', px(fixture.componentInstance, 5, 5));
    fire(area(fixture), 'pointerup', px(fixture.componentInstance, 5, 5));
    expect(store.selection()).toEqual([]);
  });

  it('shift-click adds and removes without moving anything', () => {
    const { fixture, store, ids } = setup();
    const c = fixture.componentInstance;
    fire(hits(fixture)[0], 'pointerdown', px(c, 300, 300));
    fire(hits(fixture)[2], 'pointerdown', px(c, 1500, 800), { shiftKey: true });
    expect(store.selection()).toEqual([ids[0], ids[2]]);
    fire(hits(fixture)[0], 'pointerdown', px(c, 300, 300), { shiftKey: true });
    expect(store.selection()).toEqual([ids[2]]);
    expect(store.canUndo()).toBe(false);
  });

  it('marquee selects every element it touches, at a non-1 zoom; shift extends the selection', () => {
    const { fixture, store, ids } = setup({ zoom: 0.5 });
    drag(fixture, area(fixture), [100, 100], [[700, 500]]);
    expect(store.selection()).toEqual([ids[0]]);
    drag(fixture, area(fixture), [100, 100], [[1000, 450]]);
    expect(store.selection()).toEqual([ids[0], ids[1]]);
    drag(fixture, area(fixture), [1350, 650], [[1700, 950]], { shiftKey: true });
    expect(store.selection()).toEqual([ids[0], ids[1], ids[2]]);
    expect(root(fixture).querySelector('.marquee')).toBeNull();
  });

  it('pressing one of several selected elements without dragging narrows the selection to it', () => {
    const { fixture, store, ids } = setup();
    const c = fixture.componentInstance;
    store.select(ids);
    fire(hits(fixture)[1], 'pointerdown', px(c, 1000, 500));
    expect(store.selection()).toEqual(ids);
    fire(area(fixture), 'pointerup', px(c, 1000, 500));
    expect(store.selection()).toEqual([ids[1]]);
  });
});

describe('Canvas move', () => {
  it.each([0.5, 1, 2])('lands on the expected stage coordinates at zoom %d with a rotated element', (zoom) => {
    const rotated = createElement('shape', { x: 300, y: 300, w: 400, h: 200, rotation: 30, shape: 'rect' });
    const { fixture, store } = setup({ elements: [rotated], zoom });
    // Alt switches snapping off, so the result is exactly the pointer delta in stage units.
    drag(fixture, hits(fixture)[0], [500, 400], [[600, 450], [800, 520]], { altKey: true });
    expect(stored(store, rotated.id)).toMatchObject({ x: 600, y: 420, w: 400, h: 200, rotation: 30 });
  });

  it('is one undo step, also when the pointer rests longer than the coalescing window', () => {
    const { fixture, store, ids, canvas } = setup();
    const target = hits(fixture)[1];
    fire(target, 'pointerdown', px(canvas, 1000, 500));
    for (let i = 1; i <= 5; i++) {
      fire(area(fixture), 'pointermove', px(canvas, 1000 + i * 20, 500), { altKey: true });
      now += i === 3 ? 5_000 : 16;
    }
    fire(area(fixture), 'pointerup', px(canvas, 1100, 500));
    expect(stored(store, ids[1]).x).toBe(1000);
    store.undo();
    expect(stored(store, ids[1]).x).toBe(900);
    expect(store.canUndo()).toBe(false);
    store.redo();
    expect(stored(store, ids[1]).x).toBe(1000);
  });

  it('does not start a drag below the movement threshold', () => {
    const { fixture, store, canvas } = setup();
    fire(hits(fixture)[1], 'pointerdown', { x: 500, y: 300 });
    fire(area(fixture), 'pointermove', { x: 502, y: 301 });
    fire(area(fixture), 'pointerup', { x: 502, y: 301 });
    expect(store.canUndo()).toBe(false);
  });

  it('moves a multi-selection together', () => {
    const { fixture, store, ids, canvas } = setup();
    store.select([ids[0], ids[1]]);
    drag(fixture, hits(fixture)[0], [300, 300], [[350, 330]], { altKey: true });
    expect([stored(store, ids[0]).x, stored(store, ids[1]).x]).toEqual([250, 950]);
    expect(stored(store, ids[2]).x).toBe(1400);
  });

  it('never moves a locked element and leaves the history alone', () => {
    const locked = createElement('shape', { x: 100, y: 100, w: 100, h: 100, locked: true });
    const { fixture, store } = setup({ elements: [locked] });
    drag(fixture, hits(fixture)[0], [150, 150], [[400, 400]]);
    expect(stored(store, locked.id).x).toBe(100);
    expect(store.canUndo()).toBe(false);
    expect(root(fixture).querySelector('.handle')).toBeNull();
  });

  it('snaps to the slide edge and to other elements, shows guides while dragging and removes them after', () => {
    const { fixture, store, ids, canvas } = setup({ zoom: 1 });
    fire(hits(fixture)[0], 'pointerdown', px(canvas, 300, 300));
    // The text starts at x 200; moving it by -197 puts its left edge 3 units from the slide edge.
    fire(area(fixture), 'pointermove', px(canvas, 103, 300));
    fixture.detectChanges();
    expect(stored(store, ids[0]).x).toBe(0);
    expect(root(fixture).querySelectorAll('.guide.vertical').length).toBeGreaterThan(0);
    fire(area(fixture), 'pointerup', px(canvas, 103, 300));
    fixture.detectChanges();
    expect(root(fixture).querySelector('.guide')).toBeNull();
  });

  it('snaps to other elements', () => {
    const a = createElement('shape', { x: 100, y: 100, w: 100, h: 100 });
    const b = createElement('shape', { x: 500, y: 700, w: 100, h: 100 });
    const { fixture, store } = setup({ elements: [a, b], zoom: 1 });
    // Drop `a` at x 396, y 697: its right edge is 4 units from b's left edge (500), its top 3 from b's top (700).
    drag(fixture, hits(fixture)[0], [150, 150], [[150 + 296, 150 + 597]]);
    const moved = stored(store, a.id);
    expect(moved.x + moved.w).toBe(500);
    expect(moved.y).toBe(700);
  });

  it('Escape during a drag puts everything back', () => {
    const { fixture, store, ids, canvas, announce } = setup();
    fire(hits(fixture)[1], 'pointerdown', px(canvas, 1000, 500));
    fire(area(fixture), 'pointermove', px(canvas, 1300, 700), { altKey: true });
    expect(stored(store, ids[1]).x).not.toBe(900);
    key(fixture, 'Escape');
    expect(stored(store, ids[1]).x).toBe(900);
    expect(store.canUndo()).toBe(false);
    expect(announce).toHaveBeenLastCalledWith('Cancelled');
    // The pointer is no longer dragging anything.
    fire(area(fixture), 'pointermove', px(canvas, 1500, 900), { altKey: true });
    expect(stored(store, ids[1]).x).toBe(900);
  });
});

describe('Canvas cancel', () => {
  it('Escape after a press that changed nothing does not undo an earlier edit', () => {
    const { fixture, store, ids, canvas } = setup();
    store.select([ids[0]]);
    key(fixture, 'ArrowRight');
    expect(stored(store, ids[0]).x).toBe(201);
    fire(hits(fixture)[1], 'pointerdown', px(canvas, 1000, 500));
    fire(area(fixture), 'pointermove', px(canvas, 1001, 500));
    key(fixture, 'Escape');
    expect(stored(store, ids[0]).x).toBe(201);
    expect(store.canUndo()).toBe(true);
  });
});

describe('Canvas interrupted gestures', () => {
  it('a cancelled pointer does not narrow a multi-selection', () => {
    const { fixture, store, ids, canvas } = setup();
    store.select(ids);
    fire(hits(fixture)[1], 'pointerdown', px(canvas, 1000, 500));
    fire(area(fixture), 'pointercancel', px(canvas, 1000, 500));
    expect(store.selection()).toEqual(ids);
  });

  it('losing focus or the pointer capture mid-drag ends the gesture, so the keyboard works again', () => {
    const { fixture, store, ids, canvas } = setup();
    for (const end of ['blur', 'lostpointercapture']) {
      store.select([ids[0]]);
      fire(hits(fixture)[1], 'pointerdown', px(canvas, 1000, 500));
      fire(area(fixture), 'pointermove', px(canvas, 1100, 500), { altKey: true });
      area(fixture).dispatchEvent(new Event(end));
      const x = stored(store, ids[1]).x;
      key(fixture, 'ArrowRight');
      expect(stored(store, ids[1]).x).toBe(x + 1);
    }
  });

  it('forgets a held Space when focus leaves, so the next click selects instead of panning', () => {
    const { fixture, store, ids, canvas } = setup();
    area(fixture).dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    area(fixture).dispatchEvent(new Event('blur'));
    fire(hits(fixture)[0], 'pointerdown', px(canvas, 300, 300));
    expect(store.selection()).toEqual([ids[0]]);
  });
});

describe('Canvas resize and rotate', () => {
  it.each([0.5, 2])('resizes with the south-east handle at zoom %d', (zoom) => {
    const el = createElement('shape', { x: 400, y: 300, w: 200, h: 100, shape: 'rect' });
    const { fixture, store } = setup({ elements: [el], zoom });
    fixture.componentInstance; // handles exist once selected
    store.select([el.id]);
    fixture.detectChanges();
    drag(fixture, handle(fixture, 'se'), [600, 400], [[650, 500], [700, 520]], { altKey: true });
    expect(stored(store, el.id)).toMatchObject({ x: 400, y: 300, w: 300, h: 220 });
  });

  it('keeps the aspect ratio with shift', () => {
    const el = createElement('shape', { x: 400, y: 300, w: 200, h: 100, shape: 'rect' });
    const { fixture, store } = setup({ elements: [el] });
    store.select([el.id]);
    fixture.detectChanges();
    drag(fixture, handle(fixture, 'se'), [600, 400], [[800, 450]], { shiftKey: true, altKey: true });
    const e = stored(store, el.id);
    expect(e.w / e.h).toBeCloseTo(2);
    expect(e.w).toBe(400);
  });

  it('resizes a rotated element along its own axes and keeps the opposite edge in place', () => {
    const el = createElement('shape', { x: 400, y: 300, w: 200, h: 100, rotation: 90, shape: 'rect' });
    const { fixture, store, canvas } = setup({ elements: [el], zoom: 0.5 });
    store.select([el.id]);
    fixture.detectChanges();
    // Turned 90°, the east handle (at 500, 450) faces down. Dragging it 40 units down makes the box 40 wider.
    const westBefore = corners({ x: 400, y: 300, w: 200, h: 100, rotation: 90 });
    drag(fixture, handle(fixture, 'e'), [500, 450], [[500, 490]], { altKey: true });
    const e = stored(store, el.id);
    expect(e).toMatchObject({ w: 240, h: 100, rotation: 90 });
    const after = corners({ x: e.x, y: e.y, w: e.w, h: e.h, rotation: 90 });
    // The west (top-left → bottom-left after rotation) edge did not move on the stage.
    expect(after[0].x).toBeCloseTo(westBefore[0].x);
    expect(after[0].y).toBeCloseTo(westBefore[0].y);
    expect(after[3].x).toBeCloseTo(westBefore[3].x);
  });

  it('scales a group of unrotated elements as a block', () => {
    const a = createElement('shape', { x: 100, y: 100, w: 100, h: 100 });
    const b = createElement('shape', { x: 300, y: 100, w: 100, h: 100 });
    const { fixture, store } = setup({ elements: [a, b] });
    store.select([a.id, b.id]);
    fixture.detectChanges();
    // The group spans x 100..400; pull its east edge to 700 (twice as wide).
    drag(fixture, handle(fixture, 'e'), [400, 150], [[700, 150]], { altKey: true });
    expect(stored(store, a.id)).toMatchObject({ x: 100, w: 200, h: 100 });
    expect(stored(store, b.id)).toMatchObject({ x: 500, w: 200, h: 100 });
  });

  it('offers no resize handles for a group with a rotated member', () => {
    const a = createElement('shape', { x: 100, y: 100, w: 100, h: 100 });
    const b = createElement('shape', { x: 300, y: 100, w: 100, h: 100, rotation: 10 });
    const { fixture, store } = setup({ elements: [a, b] });
    store.select([a.id, b.id]);
    fixture.detectChanges();
    expect(root(fixture).querySelector('.frame')).toBeTruthy();
    expect(root(fixture).querySelector('.handle')).toBeNull();
  });

  it('rotates with the handle and snaps to 15° with shift, as one undo step', () => {
    const el = createElement('shape', { x: 400, y: 300, w: 200, h: 100, shape: 'rect' });
    const { fixture, store, canvas } = setup({ elements: [el], zoom: 0.5 });
    store.select([el.id]);
    fixture.detectChanges();
    const rotate = root(fixture).querySelector<HTMLElement>('.handle.rotate')!;
    // Centre is (500, 350). A pointer straight to the right is a quarter turn.
    drag(fixture, rotate, [500, 200], [[700, 350]]);
    expect(stored(store, el.id).rotation).toBe(90);
    store.undo();
    expect(stored(store, el.id).rotation).toBe(0);
    expect(store.canUndo()).toBe(false);
    fire(rotate, 'pointerdown', px(canvas, 500, 200));
    fire(area(fixture), 'pointermove', px(canvas, 690, 300), { shiftKey: true });
    expect(stored(store, el.id).rotation % 15).toBe(0);
  });
});

describe('Canvas keyboard', () => {
  it('is focusable, named and described', () => {
    const { fixture } = setup();
    const a = area(fixture);
    expect(a.tabIndex).toBe(0);
    expect(a.getAttribute('aria-label')).toBe('Slide canvas');
    expect(document.getElementById(a.getAttribute('aria-describedby')!)?.textContent).toContain('Tab selects the next element');
  });

  it('Tab walks the elements, and past the last one lets focus leave', () => {
    const { fixture, store, ids } = setup();
    expect(key(fixture, 'Tab').defaultPrevented).toBe(true);
    expect(store.selection()).toEqual([ids[0]]);
    key(fixture, 'Tab');
    key(fixture, 'Tab');
    expect(store.selection()).toEqual([ids[2]]);
    expect(key(fixture, 'Tab').defaultPrevented).toBe(false);
    expect(key(fixture, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(store.selection()).toEqual([ids[1]]);
  });

  it('nudges, resizes, rotates, reorders, duplicates, copies, pastes, deletes and undoes from the keyboard alone', () => {
    const { fixture, store, ids } = setup();
    key(fixture, 'Tab');
    key(fixture, 'ArrowRight', { shiftKey: true });
    expect(stored(store, ids[0]).x).toBe(210);
    key(fixture, 'ArrowDown', { ctrlKey: true });
    expect(stored(store, ids[0]).h).toBe(201);
    key(fixture, 'ArrowRight', { altKey: true, shiftKey: true });
    expect(stored(store, ids[0]).rotation).toBe(15);
    key(fixture, ']');
    expect(store.currentSlide().elements[1].id).toBe(ids[0]);
    key(fixture, 'd', { ctrlKey: true });
    expect(store.currentSlide().elements).toHaveLength(4);
    key(fixture, 'Delete');
    expect(store.currentSlide().elements).toHaveLength(3);
    key(fixture, 'z', { ctrlKey: true });
    expect(store.currentSlide().elements).toHaveLength(4);
    key(fixture, 'z', { ctrlKey: true, shiftKey: true });
    expect(store.currentSlide().elements).toHaveLength(3);
    key(fixture, 'a', { ctrlKey: true });
    expect(store.selection()).toHaveLength(3);
    key(fixture, 'c', { ctrlKey: true });
    key(fixture, 'v', { ctrlKey: true });
    expect(store.currentSlide().elements).toHaveLength(6);
    key(fixture, 'Escape');
    expect(store.selection()).toEqual([]);
  });

  it('pans with the arrow keys when nothing is selected', () => {
    const { fixture, canvas } = setup();
    canvas.actualSize();
    const before = canvas.viewport();
    key(fixture, 'ArrowLeft');
    expect(canvas.viewport().panX).toBe(before.panX + 40);
  });

  it('every shortcut is listed in the help', () => {
    const { fixture } = setup();
    const terms = Array.from(root(fixture).querySelectorAll('.shortcuts dt'), (d) => d.textContent);
    expect(terms).toEqual(expect.arrayContaining(['Tab', 'Ctrl+D', 'Ctrl+Z', 'Ctrl+Shift+Z', '[', ']', 'Delete', 'Ctrl+A']));
  });
});

describe('Canvas zoom and pan', () => {
  it('fits by default and follows the area', () => {
    const { canvas } = setup();
    const v = canvas.viewport();
    expect(v.zoom).toBeCloseTo((1000 - 48) / 1920);
    expect(v.panX).toBeCloseTo(24);
  });

  it('zooms with Ctrl+wheel around the pointer and pans with the plain wheel', () => {
    const { fixture, canvas } = setup();
    canvas.actualSize();
    const anchorStage = { x: 960, y: 540 };
    const at = px(canvas, anchorStage.x, anchorStage.y);
    const wheel = (init: WheelEventInit) => area(fixture).dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, ...init }));
    wheel({ deltaY: -200, ctrlKey: true });
    const zoomed = canvas.viewport();
    expect(zoomed.zoom).toBeGreaterThan(1);
    const still = px(canvas, anchorStage.x, anchorStage.y);
    expect(still.x).toBeCloseTo(at.x);
    expect(still.y).toBeCloseTo(at.y);
    wheel({ deltaX: 0, deltaY: 50 });
    expect(canvas.viewport().panY).toBeCloseTo(zoomed.panY - 50);
  });

  it('keeps the zoom between the limits and reports it', () => {
    const { fixture, canvas } = setup();
    for (let i = 0; i < 40; i++) canvas.zoomBy(1.25);
    expect(canvas.viewport().zoom).toBe(8);
    fixture.detectChanges();
    expect(root(fixture).querySelector('.zoom')?.textContent).toBe('800%');
    for (let i = 0; i < 80; i++) canvas.zoomBy(0.8);
    expect(canvas.viewport().zoom).toBeCloseTo(0.1);
  });

  it('the toolbar buttons zoom, fit and show 100%', () => {
    const { fixture, canvas } = setup();
    const button = (name: string) => Array.from(root(fixture).querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') ?? b.textContent.trim()) === name)!;
    button('100%').click();
    expect(canvas.viewport().zoom).toBe(1);
    button('Zoom in').click();
    expect(canvas.viewport().zoom).toBeCloseTo(1.25);
    button('Fit').click();
    expect(canvas.viewport().zoom).toBeCloseTo((1000 - 48) / 1920);
  });

  it('space-drag and middle-button drag pan the slide', () => {
    const { fixture, canvas, store, ids } = setup();
    canvas.actualSize();
    const start = canvas.viewport();
    area(fixture).dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    fire(hits(fixture)[0], 'pointerdown', { x: 300, y: 300 });
    fire(area(fixture), 'pointermove', { x: 330, y: 310 });
    fire(area(fixture), 'pointerup', { x: 330, y: 310 });
    area(fixture).dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    expect(canvas.viewport().panX).toBe(start.panX + 30);
    expect(store.selection()).toEqual([]);
    expect(stored(store, ids[0]).x).toBe(200);
    fire(area(fixture), 'pointerdown', { x: 300, y: 300 }, { button: 1 });
    fire(area(fixture), 'pointermove', { x: 300, y: 280 });
    fire(area(fixture), 'pointerup', { x: 300, y: 280 });
    expect(canvas.viewport().panY).toBe(start.panY + 10 - 20);
  });
});

describe('Canvas interact mode', () => {
  const code = () => createElement('code', { x: 100, y: 100, w: 400, h: 300, componentId: 'cp_x', props: {} });

  it('is only available for one selected code element and lets the pointer through to it', () => {
    const c = code();
    const other = createElement('shape', { x: 800, y: 100 });
    const { fixture, store, canvas, announce } = setup({ elements: [c, other] });
    canvas.toggleInteract();
    expect(announce).toHaveBeenLastCalledWith('Select one code component to interact with it');
    store.select([c.id]);
    fixture.detectChanges();
    canvas.toggleInteract();
    fixture.detectChanges();
    expect(hits(fixture)[0].classList.contains('interacting')).toBe(true);
    expect(hits(fixture)[1].classList.contains('interacting')).toBe(false);
    expect(root(fixture).querySelector('.handle')).toBeNull();
    const toggle = Array.from(root(fixture).querySelectorAll('button')).find((b) => b.textContent.trim() === 'Interact')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('ends when the selection changes', () => {
    const c = code();
    const other = createElement('shape', { x: 800, y: 100 });
    const { fixture, store, canvas } = setup({ elements: [c, other] });
    store.select([c.id]);
    canvas.toggleInteract();
    store.select([other.id]);
    fixture.detectChanges();
    store.select([c.id]);
    fixture.detectChanges();
    expect(hits(fixture)[0].classList.contains('interacting')).toBe(false);
  });
});

describe('Canvas quality', () => {
  it('re-renders only the element being dragged on a 100-element slide', () => {
    const { fixture, store, canvas } = setup({ deck: createStressDeck(100) });
    const slideElements = store.currentSlide().elements;
    expect(slideElements).toHaveLength(100);
    expect(hits(fixture)).toHaveLength(100);
    const target = slideElements[1];
    fire(hits(fixture)[1], 'pointerdown', px(canvas, target.x + 10, target.y + 10));
    probe.mockClear();
    const moves = 50;
    for (let i = 1; i <= moves; i++) {
      fire(area(fixture), 'pointermove', px(canvas, target.x + 10 + i * 10, target.y + 10 + i * 2), { altKey: true });
      fixture.detectChanges();
    }
    fire(area(fixture), 'pointerup', px(canvas, 0, 0));
    expect(probe.mock.calls.every(([id]) => id === target.id)).toBe(true);
    expect(probe.mock.calls.length).toBe(moves);
    store.undo();
    expect(stored(store, target.id).x).toBe(target.x);
    expect(store.canUndo()).toBe(false);
  });

  it('keeps one history entry of constant size for a long drag', () => {
    const { fixture, store, canvas } = setup({ deck: createStressDeck(100) });
    const target = store.currentSlide().elements[1];
    fire(hits(fixture)[1], 'pointerdown', px(canvas, target.x + 10, target.y + 10));
    for (let i = 1; i <= 300; i++) fire(area(fixture), 'pointermove', px(canvas, target.x + 10 + i, target.y + 10), { altKey: true });
    fire(area(fixture), 'pointerup', px(canvas, 0, 0));
    store.undo();
    expect(store.canUndo()).toBe(false);
  });

  it('has no AXE violations with and without a selection (colour contrast needs layout and is checked by hand)', async () => {
    const { fixture, store, ids } = setup();
    const run = () => axe.run(root(fixture), { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect((await run()).violations).toEqual([]);
    store.select([ids[0]]);
    fixture.detectChanges();
    expect((await run()).violations).toEqual([]);
  });
});
