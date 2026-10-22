import { TestBed, type ComponentFixture } from '@angular/core/testing';
import axe from 'axe-core';
import { createDeck, createElement, createSlide, type CodeEl, type ComponentDef, type Slide } from '../../core/model';
import { DeckRepository, InMemoryDeckRepository } from '../../core/persistence';
import { ErrorService } from '../../core/errors';
import { CODE_ELEMENT_VIEW, CodeHostEvents, FrameRegistry, SlideRenderer, type RenderMode } from '../../renderer';
import type { BridgePort } from './bridge';
import { CodeElementRenderer } from './code-element-renderer';
import { COUNTER_COMPONENT } from './examples';
import { ComponentAssets, ComponentPolicy, ComponentStateStore, HostConsole, LinkGuard, RuntimeSource } from './host-services';
import type { JsonValue } from './protocol';
import { SANDBOX_CHANNEL } from './supervisor';

class FakePort implements BridgePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  sent: any[] = [];
  closed = false;
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  close(): void {
    this.closed = true;
  }
  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

class MemoryStateStore extends ComponentStateStore {
  readonly saves: { deckId: string; elementId: string; state: Record<string, JsonValue> }[] = [];
  initial: Record<string, JsonValue> = {};
  override load(): Record<string, JsonValue> {
    return { ...this.initial };
  }
  override save(deckId: string, elementId: string, state: Record<string, JsonValue>): void {
    this.saves.push({ deckId, elementId, state });
  }
}

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Harness {
  fixture: ComponentFixture<SlideRenderer>;
  ports: FakePort[];
  store: MemoryStateStore;
  element: CodeEl;
  slide: Slide;
  def: ComponentDef;
  frames(): HTMLIFrameElement[];
  handshake(index?: number): FakePort;
  settle(): Promise<void>;
  update(patch: Partial<CodeEl>): Promise<void>;
}

async function harness(options: { mode?: RenderMode; def?: Partial<ComponentDef>; withoutDef?: boolean; origins?: string[]; runtime?: () => Promise<string> } = {}): Promise<Harness> {
  const ports: FakePort[] = [];
  const store = new MemoryStateStore();
  const def: ComponentDef = { ...structuredClone(COUNTER_COMPONENT), ...options.def };
  const element = createElement('code', { x: 100, y: 200, w: 800, h: 400, componentId: def.id, props: { start: 7 } }) as CodeEl;
  const slide = { ...createSlide('layout'), elements: [element] };
  const deck = createDeck();
  TestBed.configureTestingModule({
    providers: [
      { provide: DeckRepository, useValue: new InMemoryDeckRepository() },
      { provide: CODE_ELEMENT_VIEW, useValue: () => Promise.resolve(CodeElementRenderer) },
      { provide: RuntimeSource, useValue: { load: options.runtime ?? (() => Promise.resolve('/*runtime*/')) } },
      { provide: ComponentStateStore, useValue: store },
      { provide: SANDBOX_CHANNEL, useValue: () => {
          const port = new FakePort();
          ports.push(port);
          return { port1: port, port2: { port: ports.length } };
        } },
      { provide: ComponentAssets, useValue: { read: async () => ({ mime: 'image/png', data: new ArrayBuffer(4) }) } },
      { provide: LinkGuard, useValue: { open: vi.fn() } },
      ...(options.origins ? [{ provide: ComponentPolicy, useValue: { networkOrigins: () => options.origins, mayRun: () => true } }] : []),
    ],
  });
  const fixture = TestBed.createComponent(SlideRenderer);
  fixture.componentRef.setInput('slide', slide);
  fixture.componentRef.setInput('theme', deck.theme);
  fixture.componentRef.setInput('mode', options.mode ?? 'present');
  fixture.componentRef.setInput('deckId', 'dk_test');
  fixture.componentRef.setInput('components', options.withoutDef ? [] : [def]);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await tick();
    }
  };
  fixture.detectChanges();
  await settle();
  const frames = () => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('iframe'));
  return {
    fixture,
    ports,
    store,
    element,
    slide,
    def,
    frames,
    settle,
    handshake(index = 0) {
      const frame = frames()[index];
      const event = new MessageEvent('message', { data: { type: 'ready', apiVersion: 1 }, origin: 'null' });
      Object.defineProperty(event, 'source', { value: frame.contentWindow });
      window.dispatchEvent(event);
      return ports[ports.length - 1];
    },
    async update(patch) {
      fixture.componentRef.setInput('slide', { ...slide, elements: [{ ...element, ...patch }] });
      await settle();
    },
  };
}

const root = (h: Harness): HTMLElement => h.fixture.nativeElement as HTMLElement;

describe('CodeElementRenderer', () => {
  it('draws a sandboxed frame with the component document, positioned like any element', async () => {
    const h = await harness();
    const [frame] = h.frames();
    expect(h.frames()).toHaveLength(1);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('allow')).toBe('');
    expect(frame.title).toBe('Code component: Counter');
    expect(frame.srcdoc).toContain('Content-Security-Policy');
    expect(frame.srcdoc).toContain("connect-src 'none'");
    expect(frame.srcdoc).toContain('id="inc"');
    expect(frame.srcdoc).toContain('/*runtime*/');
    expect(frame.srcdoc).toContain('--deck-color-text');
    const host = root(h).querySelector('app-code-element') as HTMLElement;
    expect(host.style.left).toBe('100px');
    expect(host.style.top).toBe('200px');
    expect(host.style.width).toBe('800px');
    expect(host.style.height).toBe('400px');
  });

  it('never gives a frame more than allow-scripts, whatever the definition asks for', async () => {
    const h = await harness({ def: { permissions: ['network', 'storage'], html: '<iframe sandbox="allow-same-origin"></iframe>' } });
    for (const frame of h.frames()) expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(h.frames()).toHaveLength(1);
  });

  it('draws a labelled placeholder and no frame in thumbnails', async () => {
    const h = await harness({ mode: 'thumbnail' });
    expect(h.frames()).toEqual([]);
    expect(root(h).querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Code component: Counter');
  });

  it('shows a placeholder for a missing definition', async () => {
    const h = await harness({ withoutDef: true });
    expect(h.frames()).toEqual([]);
    expect(root(h).textContent).toContain('Missing component');
  });

  it('draws nothing when the app provides no code view', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: DeckRepository, useValue: new InMemoryDeckRepository() }] });
    const element = createElement('code', { componentId: 'x' });
    const fixture = TestBed.createComponent(SlideRenderer);
    fixture.componentRef.setInput('slide', { ...createSlide('layout'), elements: [element] });
    fixture.componentRef.setInput('theme', createDeck().theme);
    fixture.detectChanges();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('iframe, app-code-element')).toBeNull();
  });

  it('keeps hidden code elements out of the DOM when presenting', async () => {
    const h = await harness();
    await h.update({ hidden: true });
    expect(h.frames()).toEqual([]);
  });

  describe('handshake', () => {
    it('sends init with the resolved props, theme, state, mode and size', async () => {
      const h = await harness();
      h.store.initial = { n: 3 };
      const port = h.handshake();
      await h.settle();
      expect(port.sent).toHaveLength(1);
      expect(port.sent[0]).toMatchObject({
        type: 'init',
        apiVersion: 1,
        props: { start: 7, label: 'Add one' },
        mode: 'present',
        size: { w: 800, h: 400 },
        state: { n: 3 },
        libs: [],
        permissions: { network: false },
      });
      expect(port.sent[0].theme['--deck-color-text']).toBeDefined();
    });

    it('reports edit mode to the component', async () => {
      const h = await harness({ mode: 'edit' });
      const port = h.handshake();
      await h.settle();
      expect(port.sent[0].mode).toBe('edit');
    });

    it('grants the network only when the component asks and the policy lists origins', async () => {
      const asked = await harness({ def: { permissions: ['network'] }, origins: ['https://api.example.com'] });
      expect(asked.frames()[0].srcdoc).toContain('connect-src https://api.example.com');
      const port = asked.handshake();
      await asked.settle();
      expect(port.sent[0].permissions).toEqual({ network: true });
    });

    it('does not widen the CSP for a component that did not ask', async () => {
      const h = await harness({ def: { permissions: [] }, origins: ['https://api.example.com'] });
      expect(h.frames()[0].srcdoc).toContain("connect-src 'none'");
    });

    it('does not widen the CSP when the user granted nothing', async () => {
      const h = await harness({ def: { permissions: ['network'] } });
      expect(h.frames()[0].srcdoc).toContain("connect-src 'none'");
    });
  });

  describe('keeping the frame in step with the deck', () => {
    it('sends changed props to the running frame without reloading it', async () => {
      const h = await harness();
      const port = h.handshake();
      await h.settle();
      const frame = h.frames()[0];
      await h.update({ props: { start: 9, label: 'Go' } });
      expect(h.frames()[0]).toBe(frame);
      expect(port.sent.at(-1)).toEqual({ type: 'props', props: { start: 9, label: 'Go' } });
    });

    it('does not resend props when only the geometry changes, but tells the frame its size', async () => {
      const h = await harness();
      const port = h.handshake();
      await h.settle();
      const before = port.sent.length;
      await h.update({ x: 300, w: 1000 });
      const added = port.sent.slice(before);
      expect(added.filter((m) => m.type === 'props')).toEqual([]);
      expect(added).toContainEqual({ type: 'size', size: { w: 1000, h: 400 } });
      expect(h.frames()).toHaveLength(1);
    });

    it('applies the defaults for stale or invalid props', async () => {
      const h = await harness();
      const port = h.handshake();
      await h.settle();
      await h.update({ props: { start: 'seven', label: 3, removed: true } });
      expect(port.sent.at(-1)).toEqual({ type: 'props', props: { start: 0, label: 'Add one' } });
    });

    it('sends a changed theme without reloading the frame', async () => {
      const h = await harness();
      const port = h.handshake();
      await h.settle();
      const frame = h.frames()[0];
      const dark = createDeck().theme;
      dark.colors = { ...dark.colors, text: '#fedcba' };
      h.fixture.componentRef.setInput('theme', dark);
      await h.settle();
      expect(h.frames()[0]).toBe(frame);
      expect(port.sent.at(-1)).toMatchObject({ type: 'theme', theme: { '--deck-color-text': '#fedcba' } });
    });

    it('replaces the frame when the source changes and closes the old conversation', async () => {
      const h = await harness();
      const port = h.handshake();
      await h.settle();
      const first = h.frames()[0];
      h.fixture.componentRef.setInput('components', [{ ...h.def, html: '<p id="changed">new</p>' }]);
      await h.settle();
      expect(h.frames()).toHaveLength(1);
      expect(h.frames()[0]).not.toBe(first);
      expect(h.frames()[0].srcdoc).toContain('id="changed"');
      expect(port.closed).toBe(true);
    });

    it('does not reload for changes to the name or the prop schema', async () => {
      const h = await harness();
      const frame = h.frames()[0];
      h.fixture.componentRef.setInput('components', [{ ...h.def, name: 'Renamed', propSchema: [...h.def.propSchema] }]);
      await h.settle();
      expect(h.frames()[0]).toBe(frame);
    });

    it('replaces the frame when its libraries or files change', async () => {
      const h = await harness();
      const first = h.frames()[0];
      h.fixture.componentRef.setInput('components', [{ ...h.def, libs: ['a'.repeat(64)] }]);
      await h.settle();
      expect(h.frames()[0]).not.toBe(first);
    });

    it('keeps a hidden element dimmed in the editor, out of the tab order and the accessibility tree', async () => {
      const h = await harness({ mode: 'edit' });
      await h.update({ hidden: true });
      const host = root(h).querySelector('app-code-element')!;
      expect(host.classList.contains('ghost')).toBe(true);
      expect(host.getAttribute('aria-hidden')).toBe('true');
      expect(host.hasAttribute('inert')).toBe(true);
    });

    it('removes the frame and ends the conversation when destroyed', async () => {
      const h = await harness();
      const port = h.handshake();
      await h.settle();
      h.fixture.destroy();
      expect(port.closed).toBe(true);
      expect(document.querySelectorAll('iframe')).toHaveLength(0);
    });

    it('forwards the step a presenter asks for', async () => {
      const h = await harness();
      const port = h.handshake();
      await h.settle();
      TestBed.inject(CodeHostEvents).stepIndexes.set(new Map([[h.element.id, 2]]));
      await h.settle();
      expect(port.sent.at(-1)).toEqual({ type: 'step', index: 2 });
    });
  });

  describe('what the component can ask for', () => {
    it('persists deck.state per deck and element', async () => {
      const h = await harness();
      const port = h.handshake();
      await h.settle();
      port.receive({ type: 'state-set', key: 'n', value: 12 });
      expect(h.store.saves).toEqual([]);
      await tick(300);
      expect(h.store.saves).toEqual([{ deckId: 'dk_test', elementId: h.element.id, state: { n: 12 } }]);
    });

    it('lets the component read the asset chosen in an asset prop', async () => {
      const asset = 'b'.repeat(64);
      const h = await harness({ def: { propSchema: [{ key: 'image', type: 'asset', label: 'Image', default: '' }] } });
      await h.update({ props: { image: asset } });
      const port = h.handshake();
      await h.settle();
      port.receive({ type: 'asset-request', id: 1, assetId: asset });
      port.receive({ type: 'asset-request', id: 2, assetId: 'c'.repeat(64) });
      await h.settle();
      const answer = (id: number) => port.sent.find((m) => m.type === 'asset' && m.id === id);
      expect(answer(1).data).toBeInstanceOf(ArrayBuffer);
      expect(answer(2).data).toBeNull();
    });

    it('starts a rebuilt frame at the step the presenter is on', async () => {
      const h = await harness();
      TestBed.inject(CodeHostEvents).stepIndexes.set(new Map([[h.element.id, 3]]));
      const port = h.handshake();
      await h.settle();
      expect(port.sent.find((m) => m.type === 'init').step).toBe(3);
    });

    it('writes pending state when the element goes away', async () => {
      const h = await harness();
      const port = h.handshake();
      await h.settle();
      port.receive({ type: 'state-set', key: 'n', value: 1 });
      h.fixture.destroy();
      expect(h.store.saves).toHaveLength(1);
    });

    it('honours navigation only while presenting', async () => {
      const present = await harness();
      present.handshake().receive({ type: 'navigate', action: 'next' });
      const events = TestBed.inject(CodeHostEvents);
      expect(events.navigation()).toMatchObject({ elementId: present.element.id, request: { action: 'next' } });
      TestBed.resetTestingModule();

      const edit = await harness({ mode: 'edit' });
      edit.handshake().receive({ type: 'navigate', action: 'next' });
      expect(TestBed.inject(CodeHostEvents).navigation()).toBeNull();
    });

    it('publishes the steps it declared and forgets them when gone', async () => {
      const h = await harness();
      h.handshake().receive({ type: 'steps', count: 4 });
      const events = TestBed.inject(CodeHostEvents);
      expect(events.stepCounts().get(h.element.id)).toBe(4);
      h.fixture.destroy();
      expect(events.stepCounts().has(h.element.id)).toBe(false);
    });

    it('asks before opening a link, and refuses an unsafe one outright', async () => {
      const h = await harness();
      const port = h.handshake();
      const guard = TestBed.inject(LinkGuard) as unknown as { open: ReturnType<typeof vi.fn> };
      port.receive({ type: 'link', url: 'javascript:alert(1)' });
      expect(guard.open).not.toHaveBeenCalled();
      port.receive({ type: 'link', url: 'https://example.com/' });
      expect(guard.open).toHaveBeenCalledWith('https://example.com/');
    });

    it('collects logs and errors for the console, tagged with the component', async () => {
      const h = await harness({ mode: 'edit' });
      const port = h.handshake();
      port.receive({ type: 'log', level: 'info', args: ['hello', 2] });
      port.receive({ type: 'error', message: 'boom' });
      port.receive({ type: 'bogus' });
      await h.settle();
      const entries = TestBed.inject(HostConsole).entries();
      expect(entries.map((e) => [e.componentId, e.level, e.text])).toEqual([
        [h.def.id, 'info', 'hello 2'],
        [h.def.id, 'error', 'boom'],
        [h.def.id, 'host', 'Message refused: unknown message type'],
      ]);
      expect(root(h).textContent).toContain('Script error: boom');
    });
  });

  describe('failure', () => {
    const navigateAway = (h: Harness) => {
      const frame = h.frames()[0];
      frame.dispatchEvent(new Event('load'));
      frame.dispatchEvent(new Event('load'));
    };

    it('tells the author why and offers a reload while editing', async () => {
      const h = await harness({ mode: 'edit' });
      h.handshake();
      navigateAway(h);
      await h.settle();
      const alert = root(h).querySelector('[role="alert"]')!;
      expect(alert.textContent).toContain('navigated away');
      expect(TestBed.inject(HostConsole).entries().at(-1)?.text).toBe('The component navigated away');
      const first = h.frames()[0];
      (alert.querySelector('button') as HTMLButtonElement).click();
      await h.settle();
      expect(h.frames()[0]).not.toBe(first);
      expect(root(h).querySelector('[role="alert"]')).toBeNull();
    });

    it('takes the frame out of the page when it has failed', async () => {
      const h = await harness();
      h.handshake();
      navigateAway(h);
      await h.settle();
      expect(h.frames()).toEqual([]);
    });

    it('is neutral and offers nothing while presenting', async () => {
      const h = await harness();
      h.handshake();
      navigateAway(h);
      await h.settle();
      const notice = root(h).querySelector('[role="status"]')!;
      expect(notice.textContent?.trim()).toBe('This component is unavailable.');
      expect(root(h).querySelector('button')).toBeNull();
    });

    it('can load the runtime again with the reload button', async () => {
      let attempts = 0;
      const h = await harness({ mode: 'edit', runtime: () => (++attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve('/*runtime*/')) });
      expect(h.frames()).toEqual([]);
      (root(h).querySelector('[role="alert"] button') as HTMLButtonElement).click();
      await h.settle();
      expect(h.frames()).toHaveLength(1);
      expect(root(h).querySelector('[role="alert"]')).toBeNull();
    });

    it('shows why the runtime is missing', async () => {
      const h = await harness({ mode: 'edit', runtime: () => Promise.reject(new Error('deck-runtime.js could not be loaded (404)')) });
      expect(root(h).textContent).toContain('deck-runtime.js could not be loaded (404)');
    });
  });

  describe('lifecycle and watchdog (DT-12)', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    const live = () => TestBed.inject(FrameRegistry);
    const detect = async (h: Harness) => {
      h.fixture.detectChanges();
      await h.fixture.whenStable();
      h.fixture.detectChanges();
    };

    it('replaces a component that hangs (while(true){}) by a placeholder within 5 s when presenting', async () => {
      const h = await harness();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      h.handshake();
      expect(h.frames()).toHaveLength(1);
      vi.advanceTimersByTime(4900);
      await detect(h);
      expect(h.frames()).toHaveLength(1);
      vi.advanceTimersByTime(200);
      await detect(h);
      expect(h.frames()).toEqual([]);
      expect(live().count()).toBe(0);
      expect(root(h).querySelector('[role="status"]')?.textContent?.trim()).toBe('This component is unavailable.');
      expect(root(h).querySelector('button')).toBeNull();
      const [entry] = TestBed.inject(ErrorService).entries();
      expect(entry).toMatchObject({ source: 'host', componentId: h.def.id, message: 'The component stopped responding' });
    });

    it('offers reload and skip in the editor, and skipping destroys the frame', async () => {
      const h = await harness({ mode: 'edit' });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      h.handshake();
      vi.advanceTimersByTime(5100);
      await detect(h);
      const labels = Array.from(root(h).querySelectorAll('[role="alert"] button')).map((b) => b.textContent?.trim());
      expect(labels).toEqual(['Reload component', 'Skip component']);
      expect(h.frames()).toHaveLength(1);
      (root(h).querySelectorAll('[role="alert"] button')[1] as HTMLButtonElement).click();
      await detect(h);
      expect(h.frames()).toEqual([]);
      expect(live().count()).toBe(0);
      expect(root(h).querySelector('[role="alert"]')?.textContent).toContain('The component was skipped.');
      expect(Array.from(root(h).querySelectorAll('[role="alert"] button')).map((b) => b.textContent?.trim())).toEqual(['Reload component']);
      (root(h).querySelector('[role="alert"] button') as HTMLButtonElement).click();
      await detect(h);
      expect(h.frames()).toHaveLength(1);
      expect(root(h).querySelector('[role="alert"]')).toBeNull();
    });

    it('shows an overlay in the editor and a neutral placeholder when presenting for a throwing component', async () => {
      const edit = await harness({ mode: 'edit' });
      edit.handshake().receive({ type: 'error', message: 'boom' });
      await edit.settle();
      expect(root(edit).textContent).toContain('Script error: boom');
      expect(edit.frames()).toHaveLength(1);
      expect(TestBed.inject(ErrorService).entries().map((e) => [e.source, e.componentId, e.message])).toEqual([['component', edit.def.id, 'boom']]);
      TestBed.resetTestingModule();

      const present = await harness();
      present.handshake().receive({ type: 'error', message: 'boom' });
      await present.settle();
      expect(present.frames()).toEqual([]);
      expect(root(present).querySelector('[role="status"]')?.textContent?.trim()).toBe('This component is unavailable.');
      expect(root(present).textContent).not.toContain('boom');
      expect(TestBed.inject(ErrorService).entries()).toHaveLength(1);
    });

    it.each([
      [0, 1],
      [1, 1],
      [2, 0],
      [5, 0],
    ])('keeps a frame for a slide %i away: %i frame(s)', async (distance, frames) => {
      const h = await harness();
      h.fixture.componentRef.setInput('distance', distance);
      await h.settle();
      expect(h.frames()).toHaveLength(frames);
      expect(live().count()).toBe(frames);
    });

    it('destroys frames as the shown slide moves away and makes them again when it returns', async () => {
      const h = await harness();
      expect(live().count()).toBe(1);
      h.fixture.componentRef.setInput('distance', 3);
      await h.settle();
      expect(live().count()).toBe(0);
      expect(root(h).querySelector('[role="alert"], [role="status"]')).toBeNull();
      expect(root(h).querySelector('[aria-label="Code component paused: Counter"]')).not.toBeNull();
      h.fixture.componentRef.setInput('distance', 1);
      await h.settle();
      expect(live().count()).toBe(1);
      expect(h.frames()).toHaveLength(1);
    });

    it('forgets an earlier failure when the frame is destroyed off-screen', async () => {
      const h = await harness({ mode: 'edit' });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      h.handshake();
      vi.advanceTimersByTime(5100);
      await detect(h);
      expect(root(h).querySelector('[role="alert"]')).not.toBeNull();
      h.fixture.componentRef.setInput('distance', 4);
      await detect(h);
      expect(root(h).querySelector('[role="alert"]')).toBeNull();
    });

    it('gives a presenting component a fresh frame after it was away, even if it had thrown', async () => {
      const h = await harness();
      h.handshake().receive({ type: 'error', message: 'boom' });
      await h.settle();
      expect(h.frames()).toEqual([]);
      h.fixture.componentRef.setInput('distance', 3);
      await h.settle();
      h.fixture.componentRef.setInput('distance', 0);
      await h.settle();
      expect(h.frames()).toHaveLength(1);
      expect(root(h).querySelector('[role="status"]')).toBeNull();
    });

    it('destroys an editor frame that is scrolled out of view and restores it', async () => {
      const observers: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
      vi.stubGlobal('IntersectionObserver', class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          observers.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      });
      const h = await harness({ mode: 'edit' });
      expect(live().count()).toBe(1);
      observers.forEach((notify) => notify([{ isIntersecting: false }]));
      await h.settle();
      expect(h.frames()).toEqual([]);
      expect(live().count()).toBe(0);
      observers.forEach((notify) => notify([{ isIntersecting: true }]));
      await h.settle();
      expect(h.frames()).toHaveLength(1);
      expect(live().count()).toBe(1);
    });

    it('does not apply the viewport rule when presenting (the next slide is kept ready)', async () => {
      const observers: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
      vi.stubGlobal('IntersectionObserver', class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          observers.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      });
      const h = await harness();
      h.fixture.componentRef.setInput('distance', 1);
      observers.forEach((notify) => notify([{ isIntersecting: false }]));
      await h.settle();
      expect(h.frames()).toHaveLength(1);
    });

    it('releases the frame count when the view is destroyed', async () => {
      const h = await harness();
      expect(live().count()).toBe(1);
      h.fixture.destroy();
      expect(live().count()).toBe(0);
    });

    it('draws the component snapshot in thumbnails and keeps it after the frame is gone', async () => {
      const created: Blob[] = [];
      const revoked: string[] = [];
      vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
        created.push(blob as Blob);
        return `blob:snap-${created.length}`;
      });
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.push(url));
      const h = await harness({ mode: 'thumbnail' });
      expect(root(h).querySelector('img')).toBeNull();
      expect(root(h).querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Code component: Counter');
      const first = new Blob(['a'], { type: 'image/png' });
      TestBed.inject(CodeHostEvents).setSnapshot(h.element.id, first);
      await h.settle();
      const img = root(h).querySelector('img')!;
      expect(img.getAttribute('src')).toBe('blob:snap-1');
      expect(img.getAttribute('alt')).toBe('Code component: Counter');
      expect(h.frames()).toEqual([]);
      TestBed.inject(CodeHostEvents).setSnapshot(h.element.id, new Blob(['b'], { type: 'image/png' }));
      await h.settle();
      expect(revoked).toEqual(['blob:snap-1']);
      expect(root(h).querySelector('img')?.getAttribute('src')).toBe('blob:snap-2');
      h.fixture.destroy();
      expect(revoked).toEqual(['blob:snap-1', 'blob:snap-2']);
      vi.restoreAllMocks();
    });

    it('keeps the snapshot when a live frame ends but caps how many it remembers (25)', () => {
      const events = TestBed.inject(CodeHostEvents);
      events.setSnapshot('a', new Blob(['x'], { type: 'image/png' }));
      events.release('a');
      expect(events.snapshots().has('a')).toBe(true);
      for (let i = 0; i < 80; i++) events.setSnapshot(`e${i}`, new Blob(['x'], { type: 'image/png' }));
      expect(events.snapshots().size).toBe(25);
      expect(events.snapshots().has('a')).toBe(false);
      expect(events.snapshots().has('e79')).toBe(true);
    });

    it('keeps many code components bounded: frames exist only for the slides near the shown one', async () => {
      const ports: FakePort[] = [];
      TestBed.configureTestingModule({
        providers: [
          { provide: DeckRepository, useValue: new InMemoryDeckRepository() },
          { provide: CODE_ELEMENT_VIEW, useValue: () => Promise.resolve(CodeElementRenderer) },
          { provide: RuntimeSource, useValue: { load: () => Promise.resolve('/*runtime*/') } },
          { provide: SANDBOX_CHANNEL, useValue: () => { const port = new FakePort(); ports.push(port); return { port1: port, port2: {} }; } },
        ],
      });
      const def = structuredClone(COUNTER_COMPONENT);
      const deck = createDeck();
      const slideCount = 30;
      const fixtures = Array.from({ length: slideCount }, () => {
        const slide = { ...createSlide('layout'), elements: [createElement('code', { x: 0, y: 0, w: 400, h: 300, componentId: def.id }), createElement('code', { x: 500, y: 0, w: 400, h: 300, componentId: def.id })] };
        const fixture = TestBed.createComponent(SlideRenderer);
        fixture.componentRef.setInput('slide', slide);
        fixture.componentRef.setInput('theme', deck.theme);
        fixture.componentRef.setInput('components', [def]);
        return fixture;
      });
      const show = async (current: number) => {
        fixtures.forEach((fixture, i) => fixture.componentRef.setInput('distance', Math.abs(i - current)));
        for (let n = 0; n < 4; n++) {
          fixtures.forEach((fixture) => fixture.detectChanges());
          await Promise.all(fixtures.map((fixture) => fixture.whenStable()));
          await tick();
        }
      };
      await show(0);
      expect(TestBed.inject(FrameRegistry).count()).toBe(4);
      for (const current of [1, 15, 29]) {
        await show(current);
        expect(TestBed.inject(FrameRegistry).count()).toBe(current === 1 ? 6 : current === 15 ? 6 : 4);
      }
    });
  });

  it('passes AXE: the frame has a title and nothing else is added', async () => {
    const h = await harness({ mode: 'edit' });
    const results = await axe.run(root(h), { iframes: false, rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
