import { JSDOM } from 'jsdom';
import { createDeck, createSlide, validateDeck, createElement, type CodeEl } from '../../core/model';
import { themeVars } from '../../renderer';
import { HostBridge, type BridgePort } from './bridge';
import { buildDocument } from './document-builder';
import { COUNTER_COMPONENT } from './examples';
import { HostApi } from './host-api';
import { API_VERSION, type HostMessage, type JsonValue } from './protocol';
import { resolveProps } from './props';
import { readRuntimeSource } from './testing';

/**
 * The counter example, end to end: the real document from `buildDocument` with the real runtime
 * runs in a jsdom window, linked through a pair of in-memory ports to the real bridge and
 * `HostApi`. (Real browser isolation, the CSP and the sandbox are not something jsdom enforces;
 * DT-19 covers them with a browser.)
 */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve));
/** Messages cross between two realms; the host sees its own prototypes. */
const crossRealm = (message: unknown): unknown => JSON.parse(JSON.stringify(message));

async function runCounter(options: { props: Record<string, unknown>; state: Record<string, JsonValue>; saved: Record<string, JsonValue>[] }) {
  const runtime = readRuntimeSource();
  const html = buildDocument({ def: COUNTER_COMPONENT, runtime, themeVars: themeVars(createDeck().theme) });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://app.example/',
    beforeParse(frameWindow) {
      // jsdom runs no module scripts and has no blob URLs: stand in for the runtime's module loader.
      (frameWindow as unknown as { __deckHooks: unknown }).__deckHooks = { loadModule: (js: string) => frameWindow.eval(js) };
    },
  });
  const { window } = dom;
  await new Promise<void>((resolve) => window.addEventListener('load', () => resolve()));
  await tick();
  const hostPort: BridgePort = { onmessage: null, postMessage: () => undefined, close: () => undefined };
  const framePort = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: unknown) => void hostPort.onmessage?.({ data: crossRealm(m) } as MessageEvent<unknown>) };
  hostPort.postMessage = (m: unknown) => void framePort.onmessage?.({ data: m });

  const bridge = new HostBridge(hostPort, {
    onMessage: (message) => api.handle(message),
  });
  const api = new HostApi({
    send: (m) => bridge.send(m),
    mode: 'present',
    state: options.state,
    saveState: (state) => options.saved.push(state),
    allowedAssets: new Set(),
    readAsset: async () => null,
    networkOrigins: [],
    onHeartbeat: () => undefined,
    onSteps: () => undefined,
    onNavigate: () => undefined,
    onLog: () => undefined,
    onError: () => undefined,
    onSnapshot: () => undefined,
    onLink: () => undefined,
    setTimer: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
    clearTimer: () => undefined,
  });

  const portEvent = new window.MessageEvent('message', { data: { type: 'port', apiVersion: API_VERSION } });
  Object.defineProperty(portEvent, 'source', { value: window.parent });
  Object.defineProperty(portEvent, 'ports', { value: [framePort] });
  window.dispatchEvent(portEvent);

  const init: HostMessage = {
    type: 'init',
    apiVersion: API_VERSION,
    props: options.props,
    theme: themeVars(createDeck().theme),
    mode: 'present',
    size: { w: 800, h: 400 },
    state: options.state,
    libs: [],
    permissions: { network: false },
  };
  bridge.send(init);
  await tick();
  const button = window.document.getElementById('inc') as HTMLButtonElement;
  const output = window.document.getElementById('n') as HTMLElement;
  return { window, button, output, bridge, api };
}

describe('counter example', () => {
  it('is a valid component that can be inserted into a deck', () => {
    const deck = createDeck();
    const slide = createSlide(deck.layouts[0].id);
    const element = createElement('code', { componentId: COUNTER_COMPONENT.id, props: { start: 2, label: 'Go' } });
    const result = validateDeck({ ...deck, components: [COUNTER_COMPONENT], slides: [{ ...slide, elements: [element] }] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(COUNTER_COMPONENT.html + COUNTER_COMPONENT.css + COUNTER_COMPONENT.js).not.toMatch(/<\/script/i);
  });

  it('renders with its props and keeps its count in deck.state', async () => {
    const saved: Record<string, JsonValue>[] = [];
    const props = resolveProps(COUNTER_COMPONENT, { start: 5, label: 'Plus' } satisfies Partial<CodeEl['props']>);
    const frame = await runCounter({ props, state: {}, saved });
    expect(frame.button.textContent).toBe('Plus');
    expect(frame.output.textContent).toBe('5');
    frame.button.click();
    frame.button.click();
    await tick();
    expect(frame.output.textContent).toBe('7');
    expect(saved.at(-1)).toEqual({ n: 7 });
  });

  it('continues from the persisted state when the frame is built again', async () => {
    const saved: Record<string, JsonValue>[] = [];
    const first = await runCounter({ props: resolveProps(COUNTER_COMPONENT, {}), state: {}, saved });
    first.button.click();
    first.button.click();
    first.button.click();
    await tick();
    const second = await runCounter({ props: resolveProps(COUNTER_COMPONENT, {}), state: saved.at(-1)!, saved: [] });
    expect(second.output.textContent).toBe('3');
    second.button.click();
    expect(second.output.textContent).toBe('4');
  });

  it('follows prop changes from the properties panel', async () => {
    const frame = await runCounter({ props: resolveProps(COUNTER_COMPONENT, {}), state: {}, saved: [] });
    expect(frame.button.textContent).toBe('Add one');
    frame.bridge.send({ type: 'props', props: resolveProps(COUNTER_COMPONENT, { label: 'Renamed' }) });
    await tick();
    expect(frame.button.textContent).toBe('Renamed');
  });

  it('carries the theme into the frame as CSS variables', async () => {
    const frame = await runCounter({ props: {}, state: {}, saved: [] });
    const base = frame.window.document.getElementById('deck-base')!.textContent!;
    expect(base).toContain('--deck-color-text');
    expect(frame.window.document.documentElement.style.getPropertyValue('--deck-color-text')).not.toBe('');
  });
});
