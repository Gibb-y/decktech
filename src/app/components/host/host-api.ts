import { isSafeHref } from '../../core/model';
import {
  BRIDGE_LIMITS,
  measureJson,
  normalizeOrigin,
  type FetchInit,
  type FrameMessage,
  type HostMessage,
  type JsonValue,
  type LogLevel,
} from './protocol';

export interface HostApiDeps {
  /** Sends to the frame (the bridge's `send`). */
  send(message: HostMessage, transfer?: Transferable[]): void;
  mode: 'edit' | 'present';
  /** Persisted state of this instance, as loaded; `saveState` gets the whole object. */
  state: Record<string, JsonValue>;
  saveState(state: Record<string, JsonValue>): void;
  /** Asset ids the component may read (its `files` and `libs`). */
  allowedAssets: Pick<ReadonlySet<string>, 'has'>;
  readAsset(assetId: string): Promise<{ mime: string; data: ArrayBuffer } | null>;
  /** Origins `deck.fetch` may reach; empty means the capability is off. */
  networkOrigins: readonly string[];
  fetchImpl?: typeof fetch;
  onHeartbeat(): void;
  onSteps(count: number): void;
  onNavigate(request: { action: 'next' | 'prev' } | { action: 'goTo'; slideId: string }): void;
  onLog(level: LogLevel, args: JsonValue[]): void;
  onError(message: string, stack?: string): void;
  onSnapshot(blob: Blob): void;
  onLink(url: string): void;
  /** Timers, injectable for tests. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const SAVE_DELAY_MS = 250;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const FORBIDDEN_HEADER = /^(cookie|set-cookie|host|origin|referer|user-agent|connection|content-length|transfer-encoding|upgrade|sec-.*|proxy-.*)$/i;
const NO_BODY = new Set(['GET', 'HEAD']);

/**
 * The host side of the component API (arc42 §8.3): what each whitelisted message does. Every
 * capability is checked here against the component's mode, permissions and declared assets, so a
 * message that parsed is still not trusted. Nothing in this class touches the DOM.
 */
export class HostApi {
  private readonly state = new Map<string, JsonValue>();
  private pendingAssets = 0;
  private pendingFetches = 0;
  private saveTimer: unknown = null;
  private destroyed = false;
  private readonly aborts = new Set<AbortController>();

  constructor(private readonly deps: HostApiDeps) {
    for (const [key, value] of Object.entries(deps.state)) this.state.set(key, value);
  }

  get networkEnabled(): boolean {
    return this.deps.networkOrigins.length > 0;
  }

  handle(message: FrameMessage): void {
    if (this.destroyed) return;
    switch (message.type) {
      case 'heartbeat':
        return this.deps.onHeartbeat();
      case 'steps':
        return this.deps.onSteps(message.count);
      case 'state-set':
        return this.setState(message.key, message.value);
      case 'state-remove':
        if (this.state.delete(message.key)) this.scheduleSave();
        return;
      case 'navigate':
        if (this.deps.mode !== 'present') return this.deps.onLog('warn', ['deck.navigate only works while presenting']);
        return this.deps.onNavigate(message.action === 'goTo' ? { action: 'goTo', slideId: message.slideId } : { action: message.action });
      case 'asset-request':
        return void this.serveAsset(message.id, message.assetId);
      case 'log':
        return this.deps.onLog(message.level, message.args);
      case 'error':
        return this.deps.onError(message.message, message.stack);
      case 'snapshot':
        return this.deps.onSnapshot(message.blob);
      case 'link':
        if (!isSafeHref(message.url)) return this.deps.onLog('warn', [`Link refused: only http(s) and mailto addresses can be opened`]);
        return this.deps.onLink(message.url);
      case 'fetch':
        return void this.proxyFetch(message.id, message.url, message.init);
    }
  }

  /** Writes pending state now and stops everything in flight. */
  destroy(): void {
    if (this.destroyed) return;
    this.flush();
    this.destroyed = true;
    for (const controller of this.aborts) controller.abort();
    this.aborts.clear();
  }

  private setState(key: string, value: JsonValue): void {
    const isNew = !this.state.has(key);
    if (isNew && this.state.size >= BRIDGE_LIMITS.maxStateKeys) {
      return this.deps.onLog('warn', [`deck.state is full: at most ${BRIDGE_LIMITS.maxStateKeys} keys`]);
    }
    const next = { ...Object.fromEntries(this.state), [key]: value };
    if (measureJson(next, BRIDGE_LIMITS.maxStateBytes) === null) {
      return this.deps.onLog('warn', [`deck.state is full: at most ${BRIDGE_LIMITS.maxStateBytes / 1024} KiB`]);
    }
    this.state.set(key, value);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    const set = this.deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.saveTimer = set(() => {
      this.saveTimer = null;
      this.deps.saveState(Object.fromEntries(this.state));
    }, SAVE_DELAY_MS);
  }

  /** Writes a pending save now. */
  private flush(): void {
    if (this.saveTimer === null) return;
    (this.deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.saveTimer);
    this.saveTimer = null;
    this.deps.saveState(Object.fromEntries(this.state));
  }

  private async serveAsset(id: number, assetId: string): Promise<void> {
    const reply = (mime: string, data: ArrayBuffer | null) => {
      if (!this.destroyed) this.deps.send({ type: 'asset', id, mime, data }, data ? [data] : []);
    };
    if (!this.deps.allowedAssets.has(assetId) || this.pendingAssets >= BRIDGE_LIMITS.maxPendingAssets) return reply('', null);
    this.pendingAssets++;
    try {
      const asset = await this.deps.readAsset(assetId);
      reply(asset?.mime ?? '', asset?.data ?? null);
    } catch {
      reply('', null);
    } finally {
      this.pendingAssets--;
    }
  }

  private async proxyFetch(id: number, rawUrl: string, init: FetchInit): Promise<void> {
    const fail = (error: string, status = 0) => {
      if (!this.destroyed) this.deps.send({ type: 'fetch-result', id, ok: false, status, statusText: '', headers: [], body: null, error });
    };
    if (!this.networkEnabled) return fail('deck.fetch needs the network permission');
    if (this.pendingFetches >= BRIDGE_LIMITS.maxPendingFetches) return fail('Too many requests in flight');
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return fail('Invalid URL');
    }
    if (url.username || url.password) return fail('URLs with credentials are not allowed');
    const origin = normalizeOrigin(url.origin);
    if (origin === null || !this.deps.networkOrigins.some((allowed) => normalizeOrigin(allowed) === origin)) {
      return fail(`${url.origin} is not an allowed origin`);
    }
    const method = (init.method ?? 'GET').toUpperCase();
    if (!FETCH_METHODS.includes(method)) return fail(`Method ${method} is not allowed`);
    if (init.body !== undefined && NO_BODY.has(method)) return fail(`${method} requests have no body`);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      if (!/^[A-Za-z0-9-]{1,128}$/.test(name) || FORBIDDEN_HEADER.test(name)) return fail(`Header "${name}" is not allowed`);
      headers[name] = value;
    }
    const controller = new AbortController();
    this.aborts.add(controller);
    this.pendingFetches++;
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await (this.deps.fetchImpl ?? fetch)(url.href, {
        method,
        headers,
        body: init.body,
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: controller.signal,
      });
      const body = await readCapped(response, BRIDGE_LIMITS.maxFetchResponseBytes);
      if (body === null) return fail('The response is too large');
      if (this.destroyed) return;
      const list: [string, string][] = [];
      response.headers.forEach((value, name) => {
        if (name.toLowerCase() !== 'set-cookie') list.push([name, value]);
      });
      this.deps.send({ type: 'fetch-result', id, ok: response.ok, status: response.status, statusText: response.statusText, headers: list, body }, [body]);
    } catch (error) {
      fail(controller.signal.aborted ? 'The request timed out or was cancelled' : error instanceof Error ? error.message : 'The request failed');
    } finally {
      clearTimeout(timer);
      this.aborts.delete(controller);
      this.pendingFetches--;
    }
  }
}

/** The body of `response`, or `null` once it exceeds `max` bytes (the rest is not read). */
async function readCapped(response: Response, max: number): Promise<ArrayBuffer | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
