import { JSDOM } from 'jsdom';
import { parseFrameMessage } from './protocol';
import { readRuntimeSource } from './testing';

const runtimeSource = readRuntimeSource();
const tick = () => new Promise<void>((resolve) => setTimeout(resolve));
/** Messages built in the frame's window have that window's prototypes; the host sees its own realm's. */
const clone = (message: unknown): unknown => JSON.parse(JSON.stringify(message));

interface Booted {
  window: Window & typeof globalThis & { eval(code: string): unknown; deck: any; __deckHooks?: unknown };
  /** Everything the frame posted to its parent, in order. */
  toParent: unknown[];
  /** Everything the frame sent over its port, in order. */
  toHost: any[];
  port: { postMessage(m: unknown): void; onmessage: ((e: { data: unknown }) => void) | null };
  connect(): void;
  host(message: unknown): void;
}

async function boot(options: { html?: string; hooks?: unknown; waitForLoad?: boolean } = {}): Promise<Booted> {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${options.html ?? ''}</body></html>`, { runScripts: 'outside-only', url: 'https://app.example/' });
  const { window } = dom;
  if (options.waitForLoad !== false) await new Promise<void>((resolve) => window.addEventListener('load', () => resolve()));
  (window as any).URL.createObjectURL = () => `blob:test/${Math.random()}`;
  (window as any).Response = Response;
  if (options.hooks) (window as any).__deckHooks = options.hooks;
  const toParent: unknown[] = [];
  window.addEventListener('message', (event) => toParent.push(event.data));
  window.eval(runtimeSource);
  await tick();
  const toHost: any[] = [];
  const port = { postMessage: (m: unknown) => void toHost.push(m), onmessage: null as ((e: { data: unknown }) => void) | null };
  return {
    window: window as Booted['window'],
    toParent,
    toHost,
    port,
    connect() {
      const event = new window.MessageEvent('message', { data: { type: 'port', apiVersion: 1 } });
      Object.defineProperty(event, 'source', { value: window.parent });
      Object.defineProperty(event, 'ports', { value: [port] });
      window.dispatchEvent(event);
    },
    host: (message) => port.onmessage?.({ data: message }),
  };
}

const init = (extra: Record<string, unknown> = {}) => ({
  type: 'init',
  apiVersion: 1,
  props: { start: 5 },
  theme: { '--deck-color-text': '#123456' },
  mode: 'present',
  size: { w: 800, h: 450 },
  state: { n: 41 },
  libs: [],
  permissions: { network: false },
  ...extra,
});

describe('deck-runtime.js', () => {
  it('is safe to inline and defines the API in one script', () => {
    expect(runtimeSource).not.toMatch(/<\/script/i);
    expect(runtimeSource).not.toMatch(/\bimport\s*\(/);
  });

  it('posts ready with its API version once the document is parsed, and again waits for the port', async () => {
    const frame = await boot();
    expect(frame.toParent).toEqual([{ type: 'ready', apiVersion: 1 }]);
    expect(frame.toHost).toEqual([]);
  });

  it('also starts while the document is still loading', async () => {
    const frame = await boot({ waitForLoad: false });
    await tick();
    await tick();
    expect(frame.toParent.filter((m) => (m as { type: string }).type === 'ready')).toHaveLength(1);
  });

  it('takes the port only from the parent, once, and only a single port', async () => {
    const frame = await boot();
    const attempt = (source: unknown, ports: unknown[], data: unknown = { type: 'port' }) => {
      const event = new frame.window.MessageEvent('message', { data });
      Object.defineProperty(event, 'source', { value: source });
      Object.defineProperty(event, 'ports', { value: ports });
      frame.window.dispatchEvent(event);
    };
    const stray = { postMessage: vi.fn(), onmessage: null };
    attempt({ other: true }, [stray]);
    attempt(frame.window.parent, [], { type: 'port' });
    attempt(frame.window.parent, [stray, stray]);
    attempt(frame.window.parent, [stray], { type: 'init' });
    expect(stray.onmessage).toBeNull();
    frame.connect();
    expect(frame.port.onmessage).toBeTypeOf('function');
    attempt(frame.window.parent, [stray]);
    expect(stray.onmessage).toBeNull();
    expect(frame.toHost[0]).toEqual({ type: 'heartbeat' });
  });

  it('runs ready callbacks with the init data and applies the theme', async () => {
    const frame = await boot();
    const seen: unknown[] = [];
    frame.window.deck.ready((context: unknown) => seen.push(context));
    frame.connect();
    expect(seen).toEqual([]);
    frame.host(init());
    expect(seen).toEqual([{ props: { start: 5 }, theme: { '--deck-color-text': '#123456' }, mode: 'present', size: { w: 800, h: 450 } }]);
    expect(frame.window.document.documentElement.style.getPropertyValue('--deck-color-text')).toBe('#123456');
    expect(frame.window.deck.mode).toBe('present');
    expect(frame.window.deck.state.get('n')).toBe(41);
  });

  it('calls a late ready callback asynchronously and survives a throwing one', async () => {
    const frame = await boot();
    frame.connect();
    frame.host(init());
    const seen: unknown[] = [];
    frame.window.deck.ready(() => {
      throw new Error('component bug');
    });
    frame.window.deck.ready((context: { props: unknown }) => seen.push(context.props));
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toEqual([{ start: 5 }]);
    expect(frame.toHost).toContainEqual({ type: 'error', message: 'component bug', stack: expect.any(String) });
  });

  it('ignores a second init and only applies safe theme names', async () => {
    const frame = await boot();
    frame.connect();
    frame.host(init({ theme: { '--deck-color-a': '#111', 'background': 'red', '--evil': 'x', 'x;}': '1' } }));
    const style = frame.window.document.documentElement.style;
    expect(style.getPropertyValue('--deck-color-a')).toBe('#111');
    expect(style.getPropertyValue('background')).toBe('');
    expect(style.getPropertyValue('--evil')).toBe('');
    frame.host(init({ props: { start: 99 }, mode: 'edit' }));
    expect(frame.window.deck.mode).toBe('present');
  });

  it('forwards props, theme, step and size changes', async () => {
    const frame = await boot();
    const props: unknown[] = [];
    const steps: unknown[] = [];
    frame.connect();
    frame.window.deck.onProps((p: unknown) => props.push(p));
    frame.window.deck.onStep((i: unknown) => steps.push(i));
    frame.host(init());
    frame.host({ type: 'props', props: { start: 6 } });
    frame.host({ type: 'step', index: 2 });
    frame.host({ type: 'theme', theme: { '--deck-color-text': '#abcdef' } });
    frame.host({ type: 'size', size: { w: 10, h: 20 } });
    expect(props).toEqual([{ start: 6 }]);
    expect(steps).toEqual([2]);
    expect(frame.window.document.documentElement.style.getPropertyValue('--deck-color-text')).toBe('#abcdef');
    expect(frame.window.deck.size).toEqual({ w: 10, h: 20 });
  });

  it('keeps state locally and tells the host, in a form the host accepts', async () => {
    const frame = await boot();
    frame.connect();
    frame.host(init());
    const { state } = frame.window.deck;
    state.set('n', 42);
    state.set('obj', { a: [1, 2] });
    state.set('gone', undefined);
    state.set('fn', () => 1);
    state.remove('n');
    expect(state.get('n')).toBeUndefined();
    const obj = state.get('obj');
    expect(obj).toEqual({ a: [1, 2] });
    obj.a.push(3);
    expect(state.get('obj')).toEqual({ a: [1, 2] });
    const sent = frame.toHost.filter((m) => m.type.startsWith('state'));
    expect(sent).toEqual([
      { type: 'state-set', key: 'n', value: 42 },
      { type: 'state-set', key: 'obj', value: { a: [1, 2] } },
      { type: 'state-remove', key: 'gone' },
      { type: 'state-remove', key: 'fn' },
      { type: 'state-remove', key: 'n' },
    ]);
    for (const message of frame.toHost) expect(parseFrameMessage(clone(message)).ok, JSON.stringify(message)).toBe(true);
  });

  it('sends steps, navigation, log and snapshot messages the host accepts', async () => {
    const frame = await boot();
    frame.connect();
    frame.host(init());
    const { deck } = frame.window;
    deck.steps(3);
    deck.navigate.next();
    deck.navigate.prev();
    deck.navigate.goTo('sl_2');
    deck.log('a', 1, { b: 2 }, null, undefined, new frame.window.Error('x'), Number.NaN);
    deck.snapshot(new frame.window.Blob(['x'], { type: 'image/png' }));
    expect(() => deck.steps(-1)).toThrow(/whole number/);
    expect(() => deck.steps(1.5)).toThrow(/whole number/);
    expect(() => deck.snapshot('not a blob')).toThrow(/needs a Blob/);
    const types = frame.toHost.map((m) => m.type);
    expect(types).toEqual(['heartbeat', 'steps', 'navigate', 'navigate', 'navigate', 'log', 'snapshot']);
    for (const message of frame.toHost) {
      // Blobs of another realm are not instances of the test realm's Blob; check the envelope instead.
      if (message.type === 'snapshot') expect(message.blob).toBeInstanceOf(frame.window.Blob);
      else expect(parseFrameMessage(clone(message)).ok, JSON.stringify(message)).toBe(true);
    }
    expect(frame.toHost[5].args).toEqual(['a', 1, '{"b":2}', null, 'undefined', expect.stringContaining('x'), 'NaN']);
  });

  it('forwards console output and uncaught errors', async () => {
    const frame = await boot();
    frame.connect();
    frame.window.console.warn('careful', 2);
    frame.window.dispatchEvent(new frame.window.ErrorEvent('error', { message: 'Uncaught boom', error: new Error('boom') }));
    const rejection = new frame.window.Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: new Error('rejected') });
    frame.window.dispatchEvent(rejection);
    expect(frame.toHost).toContainEqual({ type: 'log', level: 'warn', args: ['careful', 2] });
    expect(frame.toHost).toContainEqual({ type: 'error', message: 'Uncaught boom', stack: expect.any(String) });
    expect(frame.toHost).toContainEqual({ type: 'error', message: 'rejected', stack: expect.any(String) });
    for (const message of frame.toHost) expect(parseFrameMessage(clone(message)).ok, JSON.stringify(message)).toBe(true);
  });

  describe('assets', () => {
    it('resolves a blob URL, once per asset', async () => {
      const frame = await boot();
      frame.connect();
      frame.host(init());
      const first = frame.window.deck.assets.url('asset-1');
      const again = frame.window.deck.assets.url('asset-1');
      expect(first).toBe(again);
      const request = frame.toHost.find((m) => m.type === 'asset-request');
      expect(frame.toHost.filter((m) => m.type === 'asset-request')).toHaveLength(1);
      expect(parseFrameMessage(clone(request)).ok).toBe(true);
      frame.host({ type: 'asset', id: request.id, mime: 'image/png', data: new ArrayBuffer(4) });
      await expect(first).resolves.toMatch(/^blob:/);
    });

    it('rejects an asset the host would not give, and asks again next time', async () => {
      const frame = await boot();
      frame.connect();
      frame.host(init());
      const promise = frame.window.deck.assets.url('nope');
      const request = frame.toHost.find((m) => m.type === 'asset-request');
      frame.host({ type: 'asset', id: request.id, mime: '', data: null });
      await expect(promise).rejects.toThrow(/not available/);
      frame.window.deck.assets.url('nope').catch(() => undefined);
      expect(frame.toHost.filter((m) => m.type === 'asset-request')).toHaveLength(2);
    });
  });

  describe('fetch', () => {
    it('does not exist without the network permission', async () => {
      const frame = await boot();
      frame.connect();
      frame.host(init());
      expect(frame.window.deck.fetch).toBeUndefined();
    });

    it('is proxied through the host when permitted', async () => {
      const frame = await boot();
      frame.connect();
      frame.host(init({ permissions: { network: true } }));
      const promise = frame.window.deck.fetch('https://api.example.com/x', { method: 'POST', body: '{}', headers: { Accept: 'a' } });
      const request = frame.toHost.find((m) => m.type === 'fetch');
      expect(request).toMatchObject({ url: 'https://api.example.com/x', init: { method: 'POST', body: '{}', headers: { Accept: 'a' } } });
      expect(parseFrameMessage(clone(request)).ok).toBe(true);
      frame.host({ type: 'fetch-result', id: request.id, ok: true, status: 200, statusText: 'OK', headers: [['content-type', 'text/plain']], body: new TextEncoder().encode('hi').buffer });
      const response = await promise;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('hi');
    });

    it.each([[204], [304], [404], [500]])('turns a %i answer into a Response', async (status) => {
      const frame = await boot();
      frame.connect();
      frame.host(init({ permissions: { network: true } }));
      const promise = frame.window.deck.fetch('https://api.example.com/x');
      const request = frame.toHost.find((m) => m.type === 'fetch');
      frame.host({ type: 'fetch-result', id: request.id, ok: status < 400, status, statusText: '', headers: [], body: new ArrayBuffer(0) });
      const response = await promise;
      expect(response.status).toBe(status);
      expect(response.ok).toBe(status >= 200 && status < 300);
    });

    it('rejects on a refusal and on a body that is not a string', async () => {
      const frame = await boot();
      frame.connect();
      frame.host(init({ permissions: { network: true } }));
      const refused = frame.window.deck.fetch('https://evil.example/x');
      const request = frame.toHost.find((m) => m.type === 'fetch');
      frame.host({ type: 'fetch-result', id: request.id, ok: false, status: 0, statusText: '', headers: [], body: null, error: 'not an allowed origin' });
      await expect(refused).rejects.toThrow(/not an allowed origin/);
      await expect(frame.window.deck.fetch('https://api.example.com/x', { method: 'POST', body: new frame.window.Blob(['x']) })).rejects.toThrow(/strings/);
    });
  });

  describe('links and navigation', () => {
    const click = (frame: Booted, selector: string) => {
      const event = new frame.window.MouseEvent('click', { bubbles: true, cancelable: true });
      frame.window.document.querySelector(selector)!.dispatchEvent(event);
      return event;
    };

    it('routes web links to the host and never navigates', async () => {
      const frame = await boot({ html: '<a id="web" href="https://example.com/p?q=1"><b id="inner">go</b></a><a id="mail" href="mailto:me@example.com">m</a><a id="js" href="javascript:alert(1)">j</a><a id="rel" href="/other">r</a>' });
      frame.connect();
      expect(click(frame, '#web').defaultPrevented).toBe(true);
      expect(click(frame, '#inner').defaultPrevented).toBe(true);
      expect(click(frame, '#mail').defaultPrevented).toBe(true);
      expect(click(frame, '#js').defaultPrevented).toBe(true);
      expect(click(frame, '#rel').defaultPrevented).toBe(true);
      const links = frame.toHost.filter((m) => m.type === 'link').map((m) => m.url);
      expect(links).toEqual(['https://example.com/p?q=1', 'https://example.com/p?q=1', 'mailto:me@example.com', 'https://app.example/other']);
    });

    it('leaves in-page anchors alone', async () => {
      const frame = await boot({ html: '<a id="jump" href="#section">j</a><div id="section"></div>' });
      frame.connect();
      expect(click(frame, '#jump').defaultPrevented).toBe(false);
      expect(frame.toHost.filter((m) => m.type === 'link')).toEqual([]);
    });

    it('turns window.open into a link request and submits into nothing', async () => {
      const frame = await boot({ html: '<form id="f"><button id="b">x</button></form>' });
      frame.connect();
      expect(frame.window.open('https://example.com/')).toBeNull();
      expect(frame.window.open('javascript:alert(1)')).toBeNull();
      expect(frame.toHost.filter((m) => m.type === 'link')).toEqual([{ type: 'link', url: 'https://example.com/' }]);
      const submit = new frame.window.Event('submit', { bubbles: true, cancelable: true });
      frame.window.document.getElementById('f')!.dispatchEvent(submit);
      expect(submit.defaultPrevented).toBe(true);
    });
  });

  describe('user code', () => {
    it('hands the source and the libraries to the module loader after init', async () => {
      const loadModule = vi.fn();
      const frame = await boot({ hooks: { loadModule }, html: '<script type="application/json" id="deck-user-js">"export const x = 1;"</script>' });
      frame.connect();
      expect(loadModule).not.toHaveBeenCalled();
      const libs = [{ id: 'lib-1', mime: 'text/javascript', data: new ArrayBuffer(2) }];
      frame.host(init({ libs }));
      expect(loadModule).toHaveBeenCalledWith('export const x = 1;', libs);
    });

    it('builds an import map for the libraries and a blob module for the component', async () => {
      const frame = await boot({ html: '<script type="application/json" id="deck-user-js">"import \\"lib-1\\";"</script>' });
      frame.connect();
      frame.host(init({ libs: [{ id: 'lib-1', mime: 'application/octet-stream', data: new ArrayBuffer(2) }] }));
      const map = frame.window.document.querySelector('script[type="importmap"]')!;
      expect(Object.keys(JSON.parse(map.textContent!).imports)).toEqual(['lib-1']);
      expect(JSON.parse(map.textContent!).imports['lib-1']).toMatch(/^blob:/);
      const module = frame.window.document.querySelector('script[type="module"]') as HTMLScriptElement;
      expect(module.src).toMatch(/^blob:/);
      // The import map comes first, or the module could not resolve the library.
      expect(map.compareDocumentPosition(module) & 4).toBeTruthy();
    });

    it('does not add a module for an empty script or a corrupt holder', async () => {
      const empty = await boot({ html: '<script type="application/json" id="deck-user-js">""</script>' });
      empty.connect();
      empty.host(init());
      expect(empty.window.document.querySelector('script[type="module"]')).toBeNull();
      const corrupt = await boot({ html: '<script type="application/json" id="deck-user-js">{not json</script>' });
      corrupt.connect();
      corrupt.host(init());
      expect(corrupt.window.document.querySelector('script[type="module"]')).toBeNull();
    });
  });

  it('cannot have its deck object replaced by the component', async () => {
    const frame = await boot();
    const descriptor = Object.getOwnPropertyDescriptor(frame.window, 'deck')!;
    expect(descriptor.writable).toBe(false);
    expect(descriptor.configurable).toBe(false);
  });

  it('ignores junk on the port', async () => {
    const frame = await boot();
    frame.connect();
    expect(() => {
      frame.host(null);
      frame.host('init');
      frame.host({ type: 'constructor' });
      frame.host({ type: 'asset', id: 999, data: null });
      frame.host({ type: 'fetch-result', id: 999 });
    }).not.toThrow();
  });
});
