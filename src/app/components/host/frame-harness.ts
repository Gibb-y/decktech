// Spec helper, never imported by the application: runs a component's real document in jsdom.
import { JSDOM } from 'jsdom';
import { createDeck, type ComponentDef } from '../../core/model';
import { themeVars } from '../../renderer';
import { HostBridge, type BridgePort } from './bridge';
import { buildDocument } from './document-builder';
import { HostApi } from './host-api';
import { API_VERSION, type HostMessage, type JsonValue } from './protocol';
import { readRuntimeSource } from './testing';

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve));
/** Messages cross between two realms; the host sees its own prototypes. */
const crossRealm = (message: unknown): unknown => JSON.parse(JSON.stringify(message));

export interface RunOptions {
  props: Record<string, unknown>;
  state: Record<string, JsonValue>;
  saved: Record<string, JsonValue>[];
  /** What the component logged (`deck.log`, `console`), as `[level, ...args]`. */
  logs?: unknown[][];
  /** Uncaught errors the component reported. */
  errors?: string[];
}

/**
 * The component's real document from `buildDocument` with the real runtime, in a jsdom window,
 * linked through a pair of in-memory ports to the real bridge and `HostApi`. Real browser
 * isolation, the CSP and the sandbox are not something jsdom enforces; DT-19 covers them.
 */
export async function runComponent(def: ComponentDef, options: RunOptions) {
  const runtime = readRuntimeSource();
  const html = buildDocument({ def, runtime, themeVars: themeVars(createDeck().theme) });
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
    onLog: (...args) => void options.logs?.push(args),
    onError: (message) => void options.errors?.push(message),
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
  return { window, bridge, api, document: window.document };
}
