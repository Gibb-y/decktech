import { Component, DestroyRef, effect, inject, input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import axe from 'axe-core';
import { createDeck, createElement, createSlide, type Deck, type Element as DeckElement, type Slide, type Transition } from '../core/model';
import { ALL_STEPS, CODE_ELEMENT_VIEW, CodeHostEvents } from '../renderer';
import { PresentationView } from './presentation-view';

/** Stands in for the sandboxed code view: records when it is made, destroyed and how far from the shown slide it is. */
const instances = { created: 0, destroyed: 0, distances: new Map<string, number>() };

@Component({
  selector: 'app-stub-code',
  template: `<span class="stub">code {{ elementId() }}</span>`,
})
class StubCodeView {
  readonly elements = input<unknown>();
  readonly elementId = input<string>('');
  readonly theme = input<unknown>();
  readonly mode = input<string>('present');
  readonly components = input<unknown>();
  readonly deckId = input<string>('');
  readonly ghost = input<boolean>(false);
  readonly distance = input<number>(0);

  constructor() {
    instances.created++;
    effect(() => instances.distances.set(this.elementId(), this.distance()));
    inject(DestroyRef).onDestroy(() => instances.destroyed++);
  }
}

const text = (content: string, step?: number): DeckElement => createElement('text', { text: content, step });
const code = (): DeckElement => createElement('code');
const slideOf = (elements: DeckElement[], transition?: Transition): Slide => ({ ...createSlide('layout'), elements, transition });

interface Options {
  slides: Slide[];
  start?: number;
}

async function present(options: Options) {
  instances.created = 0;
  instances.destroyed = 0;
  instances.distances.clear();
  const deck: Deck = { ...createDeck('Talk'), slides: options.slides };
  TestBed.configureTestingModule({ providers: [{ provide: CODE_ELEMENT_VIEW, useValue: () => Promise.resolve(StubCodeView) }] });
  const fixture = TestBed.createComponent(PresentationView);
  fixture.componentRef.setInput('deck', deck);
  if (options.start !== undefined) fixture.componentRef.setInput('start', options.start);
  const exited = vi.fn();
  fixture.componentInstance.exited.subscribe(exited);
  document.body.appendChild(fixture.nativeElement);
  await settle(fixture);
  const root = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    deck,
    root,
    exited,
    events: TestBed.inject(CodeHostEvents),
    settle: () => settle(fixture),
    layers: () => Array.from(root.querySelectorAll<HTMLElement>('.layer')),
    current: () => root.querySelector<HTMLElement>('.layer.current')!,
    shownText: () => Array.from(root.querySelectorAll('.layer.current app-text-element')).map((el) => el.textContent?.trim()),
    status: () => root.querySelector('[role="status"]')!.textContent!.trim(),
    key: (key: string, init: KeyboardEventInit = {}, target: Element = document.body) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    },
  };
}

type Presentation = Awaited<ReturnType<typeof present>>;

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
  }
  fixture.detectChanges();
}

const threePlain = () => [slideOf([text('one')]), slideOf([text('two')]), slideOf([text('three')])];

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PresentationView', () => {
  describe('navigation', () => {
    it('shows the first slide, or the one asked for', async () => {
      expect((await present({ slides: threePlain() })).shownText()).toEqual(['one']);
      TestBed.resetTestingModule();
      expect((await present({ slides: threePlain(), start: 2 })).shownText()).toEqual(['three']);
    });

    it.each(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'])('advances on %j', async (key) => {
      const p = await present({ slides: threePlain() });
      const event = p.key(key);
      await p.settle();
      expect(p.shownText()).toEqual(['two']);
      expect(event.defaultPrevented).toBe(true);
    });

    it.each(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'])('goes back on %j', async (key) => {
      const p = await present({ slides: threePlain(), start: 2 });
      p.key(key);
      await p.settle();
      expect(p.shownText()).toEqual(['two']);
    });

    it('goes back on Shift+Space, as a clicker that sends it expects', async () => {
      const p = await present({ slides: threePlain(), start: 1 });
      p.key(' ', { shiftKey: true });
      await p.settle();
      expect(p.shownText()).toEqual(['one']);
    });

    it('jumps with Home and End', async () => {
      const p = await present({ slides: threePlain(), start: 1 });
      p.key('End');
      await p.settle();
      expect(p.shownText()).toEqual(['three']);
      p.key('Home');
      await p.settle();
      expect(p.shownText()).toEqual(['one']);
    });

    it('leaves a key with a modifier, a used key and a key for a control alone', async () => {
      const p = await present({ slides: threePlain() });
      expect(p.key('ArrowRight', { ctrlKey: true }).defaultPrevented).toBe(false);
      expect(p.key('ArrowRight', { altKey: true }).defaultPrevented).toBe(false);
      expect(p.key('ArrowRight', { metaKey: true }).defaultPrevented).toBe(false);
      expect(p.key('x').defaultPrevented).toBe(false);
      const button = p.root.querySelector<HTMLButtonElement>('.controls button')!;
      expect(p.key('Enter', {}, button).defaultPrevented).toBe(false);
      expect(p.key(' ', {}, button).defaultPrevented).toBe(false);
      await p.settle();
      expect(p.shownText()).toEqual(['one']);
      // Arrows still work with the focus on a control, which is where a click on "Next" leaves it.
      p.key('ArrowRight', {}, button);
      await p.settle();
      expect(p.shownText()).toEqual(['two']);
    });

    it('advances on a click on the slide, and the buttons work too', async () => {
      const p = await present({ slides: threePlain() });
      p.root.querySelector<HTMLElement>('.stage')!.click();
      await p.settle();
      expect(p.shownText()).toEqual(['two']);
      const [previous, next] = Array.from(p.root.querySelectorAll<HTMLButtonElement>('.controls button'));
      next.click();
      await p.settle();
      expect(p.shownText()).toEqual(['three']);
      previous.click();
      previous.click();
      await p.settle();
      expect(p.shownText()).toEqual(['one']);
    });

    it('moves on a swipe and not on a short or vertical touch', async () => {
      const p = await present({ slides: threePlain(), start: 1 });
      const stage = p.root.querySelector<HTMLElement>('.stage')!;
      const touch = (from: [number, number], to: [number, number], click = true) => {
        const make = (type: string, [clientX, clientY]: [number, number]) => {
          const event = new Event(type, { bubbles: true });
          Object.assign(event, { pointerType: 'touch', clientX, clientY });
          return event;
        };
        stage.dispatchEvent(make('pointerdown', from));
        stage.dispatchEvent(make('pointerup', to));
        // A browser sends the click after a swipe too; it must not count as a second step.
        if (click) stage.click();
      };
      touch([300, 100], [100, 110]);
      await p.settle();
      expect(p.shownText()).toEqual(['three']);
      touch([100, 100], [300, 90]);
      await p.settle();
      expect(p.shownText()).toEqual(['two']);
      // A drag too short or too vertical is neither a swipe nor, for the browser, a click.
      touch([100, 100], [130, 100], false);
      touch([100, 100], [100, 400], false);
      await p.settle();
      expect(p.shownText()).toEqual(['two']);
    });

    it('treats a tap as a click', async () => {
      const p = await present({ slides: threePlain() });
      const stage = p.root.querySelector<HTMLElement>('.stage')!;
      const event = (type: string) => Object.assign(new Event(type, { bubbles: true }), { pointerType: 'touch', clientX: 50, clientY: 50 });
      stage.dispatchEvent(event('pointerdown'));
      stage.dispatchEvent(event('pointerup'));
      stage.click();
      await p.settle();
      expect(p.shownText()).toEqual(['two']);
    });

    it('stays on the last slide and says so, and offers no previous before the first', async () => {
      const p = await present({ slides: threePlain() });
      const [previous, next] = Array.from(p.root.querySelectorAll<HTMLButtonElement>('.controls button'));
      expect(previous.getAttribute('aria-disabled')).toBe('true');
      expect(next.getAttribute('aria-disabled')).toBe('false');
      p.key('End');
      await p.settle();
      expect(previous.getAttribute('aria-disabled')).toBe('false');
      expect(next.getAttribute('aria-disabled')).toBe('true');
      p.key('ArrowRight');
      await p.settle();
      expect(p.shownText()).toEqual(['three']);
      expect(p.status()).toContain('End of the presentation');
      p.key('ArrowLeft');
      await p.settle();
      expect(p.status()).toBe('Slide 2 of 3');
    });
  });

  describe('exiting', () => {
    it.each([['Escape key', (p: Presentation) => p.key('Escape')], ['Exit button', (p: Presentation) => p.root.querySelector<HTMLButtonElement>('.controls button:last-child')!.click()]])('emits exited once for the %s', async (_name, act) => {
      const p = await present({ slides: threePlain() });
      act(p);
      act(p);
      expect(p.exited).toHaveBeenCalledTimes(1);
    });
  });

  describe('fullscreen', () => {
    function stubFullscreen(request: () => Promise<void>) {
      let element: Element | null = null;
      const exitFullscreen = vi.fn(() => {
        element = null;
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      });
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element });
      Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen });
      const requestFullscreen = vi.fn(function (this: Element) {
        return request().then(() => {
          element = this;
          document.dispatchEvent(new Event('fullscreenchange'));
        });
      });
      Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen });
      return { requestFullscreen, exitFullscreen, leave: () => {
        element = null;
        document.dispatchEvent(new Event('fullscreenchange'));
      } };
    }

    afterEach(() => {
      for (const name of ['fullscreenEnabled', 'fullscreenElement', 'exitFullscreen']) delete (document as unknown as Record<string, unknown>)[name];
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)['requestFullscreen'];
    });

    it('asks for fullscreen on its own element, and the browser leaving it ends the presentation', async () => {
      const fullscreen = stubFullscreen(() => Promise.resolve());
      const p = await present({ slides: threePlain() });
      expect(fullscreen.requestFullscreen).toHaveBeenCalledTimes(1);
      expect(fullscreen.requestFullscreen.mock.contexts[0]).toBe(p.root);
      expect(p.exited).not.toHaveBeenCalled();
      fullscreen.leave();
      expect(p.exited).toHaveBeenCalledTimes(1);
    });

    it('carries on in the window when fullscreen is refused, and Escape still leaves', async () => {
      const fullscreen = stubFullscreen(() => Promise.reject(new TypeError('Permissions check failed')));
      const p = await present({ slides: threePlain() });
      p.key('ArrowRight');
      await p.settle();
      expect(p.shownText()).toEqual(['two']);
      expect(p.exited).not.toHaveBeenCalled();
      p.key('Escape');
      expect(p.exited).toHaveBeenCalledTimes(1);
      expect(fullscreen.exitFullscreen).not.toHaveBeenCalled();
    });

    it('leaves fullscreen when the presentation is exited or destroyed', async () => {
      const fullscreen = stubFullscreen(() => Promise.resolve());
      const p = await present({ slides: threePlain() });
      p.key('Escape');
      expect(fullscreen.exitFullscreen).toHaveBeenCalledTimes(1);
      expect(p.exited).toHaveBeenCalledTimes(1);

      TestBed.resetTestingModule();
      fullscreen.exitFullscreen.mockClear();
      const other = await present({ slides: threePlain() });
      other.fixture.destroy();
      expect(fullscreen.exitFullscreen).toHaveBeenCalledTimes(1);
    });
  });

  describe('steps', () => {
    it('reveals elements one step at a time and takes them back', async () => {
      const p = await present({ slides: [slideOf([text('always'), text('first', 1), text('second', 2)]), slideOf([text('next slide')])] });
      expect(p.shownText()).toEqual(['always']);
      p.key('ArrowRight');
      await p.settle();
      expect(p.shownText()).toEqual(['always', 'first']);
      expect(p.status()).toBe('Slide 1 of 2, step 1 of 2');
      p.key('ArrowRight');
      await p.settle();
      expect(p.shownText()).toEqual(['always', 'first', 'second']);
      p.key('ArrowRight');
      await p.settle();
      expect(p.shownText()).toEqual(['next slide']);
      p.key('ArrowLeft');
      await p.settle();
      expect(p.shownText()).toEqual(['always', 'first', 'second']);
      p.key('ArrowLeft');
      await p.settle();
      expect(p.shownText()).toEqual(['always', 'first']);
    });

    it('tells the components of the shown slide which internal step to show', async () => {
      const el = code();
      const p = await present({ slides: [slideOf([el]), slideOf([text('end')])] });
      p.events.setStepCount(el.id, 2);
      await p.settle();
      expect(p.events.stepIndexes().get(el.id)).toBe(0);
      p.key('ArrowRight');
      await p.settle();
      expect(p.events.stepIndexes().get(el.id)).toBe(1);
      p.key('ArrowRight');
      await p.settle();
      expect(p.events.stepIndexes().get(el.id)).toBe(2);
      expect(p.shownText()).toEqual([]);
      p.key('ArrowRight');
      await p.settle();
      expect(p.shownText()).toEqual(['end']);
      p.key('ArrowLeft');
      await p.settle();
      expect(p.events.stepIndexes().get(el.id)).toBe(2);
    });

    it('forgets what it told the components when it is closed', async () => {
      const el = code();
      const p = await present({ slides: [slideOf([el])] });
      p.events.setStepCount(el.id, 2);
      await p.settle();
      p.key('ArrowRight');
      await p.settle();
      expect(p.events.stepIndexes().size).toBe(1);
      p.fixture.destroy();
      expect(p.events.stepIndexes().size).toBe(0);
    });
  });

  describe('navigation requests from components', () => {
    it('follows next, prev and goTo from a component of the shown slide', async () => {
      const el = code();
      const slides = [slideOf([text('a')]), slideOf([el]), slideOf([text('c')])];
      const p = await present({ slides, start: 1 });
      p.events.requestNavigation(el.id, { action: 'next' });
      await p.settle();
      expect(p.shownText()).toEqual(['c']);
      p.events.requestNavigation(el.id, { action: 'next' });
      await p.settle();
      expect(p.shownText()).toEqual(['c']);

      const again = await presentAt(p, slides, 1);
      again.events.requestNavigation(el.id, { action: 'prev' });
      await again.settle();
      expect(again.shownText()).toEqual(['a']);
    });

    it('spends the steps of the slide first, like any other advance', async () => {
      const el = code();
      const p = await present({ slides: [slideOf([el, text('later', 1)]), slideOf([text('b')])] });
      p.events.requestNavigation(el.id, { action: 'next' });
      await p.settle();
      expect(p.shownText()).toEqual(['later']);
    });

    it('goes to a slide by id and ignores an id the deck does not have', async () => {
      const el = code();
      const slides = [slideOf([el]), slideOf([text('b')]), slideOf([text('c')])];
      const p = await present({ slides });
      p.events.requestNavigation(el.id, { action: 'goTo', slideId: slides[2].id });
      await p.settle();
      expect(p.shownText()).toEqual(['c']);
      p.events.requestNavigation(el.id, { action: 'goTo', slideId: 'slide_missing' });
      await p.settle();
      expect(p.shownText()).toEqual(['c']);
    });

    it('ignores a component that is only preloaded, and a request made before the presentation began', async () => {
      const first = code();
      const second = code();
      const events = (await present({ slides: [slideOf([first])] })).events;
      events.requestNavigation(first.id, { action: 'next' });
      TestBed.resetTestingModule();

      const slides = [slideOf([text('a')]), slideOf([second]), slideOf([text('c')])];
      const p = await present({ slides });
      // The component of slide 2 is mounted hidden; it asks (as a component may on load) and is not heard.
      p.events.requestNavigation(second.id, { action: 'next' });
      await p.settle();
      expect(p.shownText()).toEqual(['a']);
    });
  });

  /** A second look at the same running presentation, positioned on `start`. */
  async function presentAt(p: Presentation, _slides: Slide[], start: number) {
    p.fixture.componentRef.setInput('start', 99);
    await p.settle();
    p.fixture.componentRef.setInput('start', start);
    await p.settle();
    return p;
  }

  describe('preloading', () => {
    it('keeps a neighbour with code hidden and inert, and does not draw one without', async () => {
      const el = code();
      const p = await present({ slides: [slideOf([text('a')]), slideOf([el]), slideOf([text('c')])] });
      expect(p.layers().map((layer) => layer.classList.contains('current'))).toEqual([true, false]);
      const hidden = p.layers()[1];
      expect(hidden.getAttribute('aria-hidden')).toBe('true');
      expect(hidden.hasAttribute('inert')).toBe(true);
      expect(hidden.querySelector('.stub')).not.toBeNull();
      expect(p.current().hasAttribute('inert')).toBe(false);
    });

    it('tells each code view how far its slide is from the shown one', async () => {
      const slides = [slideOf([code()]), slideOf([code()]), slideOf([code()])];
      const p = await present({ slides, start: 1 });
      expect(slides.map((slide) => instances.distances.get(slide.elements[0].id))).toEqual([1, 0, 1]);
      p.key('ArrowRight');
      await p.settle();
      expect(slides.map((slide) => instances.distances.get(slide.elements[0].id))).toEqual([1, 1, 0]);
    });

    it('reuses the preloaded component when its slide comes, and shows it within 100 ms (Q10)', async () => {
      const slides = [slideOf([text('a')]), slideOf([code(), text('b')]), slideOf([text('c')])];
      const p = await present({ slides });
      expect(instances.created).toBe(1);
      const before = p.layers()[1].querySelector('app-stub-code');

      const started = performance.now();
      p.key('ArrowRight');
      p.fixture.detectChanges();
      const elapsed = performance.now() - started;

      expect(p.current().querySelector('app-stub-code')).toBe(before);
      expect(instances.created).toBe(1);
      expect(instances.destroyed).toBe(0);
      expect(elapsed).toBeLessThan(100);
    });

    it('destroys the code of slides more than one away and makes it again on return', async () => {
      const slides = [slideOf([code()]), slideOf([text('b')]), slideOf([text('c')]), slideOf([code()])];
      const p = await present({ slides });
      expect(instances.created).toBe(1);
      p.key('ArrowRight');
      await p.settle();
      expect(instances.destroyed).toBe(0);
      p.key('ArrowRight');
      await p.settle();
      expect(instances.destroyed).toBe(1);
      expect(instances.created).toBe(2);
      p.key('Home');
      await p.settle();
      expect(instances.destroyed).toBe(2);
      expect(instances.created).toBe(3);
    });

    it('draws the earlier slide complete and the later one at its start', async () => {
      const slides = [slideOf([code(), text('early-reveal', 1)]), slideOf([text('b')]), slideOf([code(), text('late-reveal', 1)])];
      const p = await present({ slides, start: 1 });
      const [earlier, , later] = [p.layers()[0], p.layers()[1], p.layers()[2]];
      expect(earlier.textContent).toContain('early-reveal');
      expect(later.textContent).not.toContain('late-reveal');
    });
  });

  describe('transitions', () => {
    const fade: Transition = { type: 'fade', durationMs: 200 };

    function reducedMotion(matches: boolean) {
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: matches && query.includes('reduced-motion'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
    }

    it('plays the transition of the slide that comes in, and not for the first slide', async () => {
      reducedMotion(false);
      const p = await present({ slides: [slideOf([text('a')], fade), slideOf([text('b')], fade), slideOf([text('c')])] });
      expect(p.current().getAttribute('data-transition')).toBeNull();
      p.key('ArrowRight');
      await p.settle();
      expect(p.current().getAttribute('data-transition')).toBe('fade');
      expect(p.root.querySelector<HTMLElement>('.stage')!.style.getPropertyValue('--duration')).toBe('200ms');
      p.key('ArrowRight');
      await p.settle();
      expect(p.current().getAttribute('data-transition')).toBeNull();
    });

    it('keeps the slide that goes under the one that comes in until the transition is over', async () => {
      reducedMotion(false);
      const p = await present({ slides: [slideOf([text('a')]), slideOf([text('b')], fade)] });
      vi.useFakeTimers();
      try {
        p.key('ArrowRight');
        p.fixture.detectChanges();
        expect(p.layers().map((layer) => layer.className.includes('leaving'))).toEqual([true, false]);
        expect(p.layers()[0].getAttribute('aria-hidden')).toBe('true');
        vi.advanceTimersByTime(250);
        p.fixture.detectChanges();
        expect(p.layers()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('draws no transition and keeps no slide under when reduced motion is asked for', async () => {
      reducedMotion(true);
      const p = await present({ slides: [slideOf([text('a')]), slideOf([text('b')], fade)] });
      p.key('ArrowRight');
      await p.settle();
      expect(p.current().getAttribute('data-transition')).toBeNull();
      expect(p.layers()).toHaveLength(1);
    });

    it.each([{ type: 'none', durationMs: 500 }, { type: 'slide', durationMs: -5 }] as Transition[])('draws nothing for %j', async (transition) => {
      reducedMotion(false);
      const p = await present({ slides: [slideOf([text('a')]), slideOf([text('b')], transition)] });
      p.key('ArrowRight');
      await p.settle();
      expect(p.layers()).toHaveLength(1);
      expect(p.root.querySelector<HTMLElement>('.stage')!.style.getPropertyValue('--duration')).toBe('0ms');
    });

    it('caps the length of a transition', async () => {
      reducedMotion(false);
      const p = await present({ slides: [slideOf([text('a')]), slideOf([text('b')], { type: 'zoom', durationMs: 9e9 })] });
      p.key('ArrowRight');
      await p.settle();
      expect(p.root.querySelector<HTMLElement>('.stage')!.style.getPropertyValue('--duration')).toBe('5000ms');
    });
  });

  describe('accessibility', () => {
    it('announces the slide in a polite live region, with the step when there is one', async () => {
      const p = await present({ slides: [slideOf([text('a'), text('b', 1)]), slideOf([text('c')])] });
      const region = p.root.querySelector('[role="status"]')!;
      expect(region.getAttribute('aria-live')).toBe('polite');
      expect(p.status()).toBe('Slide 1 of 2, step 0 of 1');
      p.key('ArrowRight');
      await p.settle();
      expect(p.status()).toBe('Slide 1 of 2, step 1 of 1');
      p.key('ArrowRight');
      await p.settle();
      expect(p.status()).toBe('Slide 2 of 2');
    });

    it('is a labelled region with a heading, and passes AXE', async () => {
      const el = code();
      const p = await present({ slides: [slideOf([createElement('text', { text: 'Hello' }), el]), slideOf([text('b')])] });
      expect(p.root.getAttribute('aria-label')).toBe('Talk');
      expect(p.root.querySelector('h1')?.textContent).toContain('Talk');
      const result = await axe.run(p.root, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
      expect(result.violations.map((v) => v.id)).toEqual([]);
    });

    it('lets the controls be reached by keyboard and shown when focused', async () => {
      const p = await present({ slides: threePlain() });
      const controls = p.root.querySelector<HTMLElement>('.controls')!;
      expect(controls.classList.contains('visible')).toBe(false);
      p.root.dispatchEvent(new Event('pointermove'));
      p.fixture.detectChanges();
      expect(controls.classList.contains('visible')).toBe(true);
      expect(controls.querySelectorAll('button')).toHaveLength(3);
    });
  });

  describe('offline (Q6)', () => {
    it('makes no network request of its own while presenting', async () => {
      const fetchSpy = vi.fn();
      const xhr = vi.fn();
      const beacon = vi.fn();
      const socket = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      vi.stubGlobal('XMLHttpRequest', xhr);
      vi.stubGlobal('WebSocket', socket);
      vi.stubGlobal('EventSource', socket);
      Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon });
      try {
        const slides = [slideOf([text('a', 1), code()]), slideOf([text('b')]), slideOf([code()])];
        const p = await present({ slides });
        for (const key of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'End', 'Home']) {
          p.key(key);
          await p.settle();
        }
        p.fixture.destroy();
      } finally {
        delete (navigator as unknown as Record<string, unknown>)['sendBeacon'];
      }
      expect([fetchSpy, xhr, beacon, socket].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
    });
  });

  it('draws a slide in a deck of one slide with nothing to step', async () => {
    const p = await present({ slides: [slideOf([text('only')])] });
    p.key('ArrowRight');
    await p.settle();
    expect(p.shownText()).toEqual(['only']);
    expect(p.status()).toContain('End of the presentation');
    expect(ALL_STEPS).toBe(Number.POSITIVE_INFINITY);
  });
});
