import { HostApi, type HostApiDeps } from './host-api';
import { BRIDGE_LIMITS, type FrameMessage, type HostMessage, type JsonValue } from './protocol';

function setup(overrides: Partial<HostApiDeps> = {}) {
  const sent: { message: HostMessage; transfer?: Transferable[] }[] = [];
  const saved: Record<string, JsonValue>[] = [];
  const logs: [string, JsonValue[]][] = [];
  const navigations: unknown[] = [];
  const links: string[] = [];
  const timers: (() => void)[] = [];
  const deps: HostApiDeps = {
    send: (message, transfer) => sent.push({ message, transfer }),
    mode: 'present',
    state: {},
    saveState: (state) => saved.push(state),
    allowedAssets: new Set(['asset-a']),
    readAsset: async () => ({ mime: 'image/png', data: new ArrayBuffer(8) }),
    networkOrigins: [],
    onHeartbeat: vi.fn(),
    onSteps: vi.fn(),
    onNavigate: (request) => navigations.push(request),
    onLog: (level, args) => logs.push([level, args]),
    onError: vi.fn(),
    onSnapshot: vi.fn(),
    onLink: (url) => links.push(url),
    setTimer: (callback) => timers.push(callback) - 1,
    clearTimer: (handle) => void (timers[handle as number] = () => undefined),
    ...overrides,
  };
  const api = new HostApi(deps);
  return { api, deps, sent, saved, logs, navigations, links, timers, fire: () => timers.splice(0).forEach((t) => t()) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

describe('HostApi state', () => {
  it('persists after a short delay, once for a burst', () => {
    const { api, saved, fire } = setup();
    api.handle({ type: 'state-set', key: 'n', value: 1 });
    api.handle({ type: 'state-set', key: 'n', value: 2 });
    api.handle({ type: 'state-set', key: 'm', value: [1] });
    expect(saved).toEqual([]);
    fire();
    expect(saved).toEqual([{ n: 2, m: [1] }]);
  });

  it('starts from the stored state and removes keys', () => {
    const { api, saved, fire } = setup({ state: { a: 1, b: 2 } });
    api.handle({ type: 'state-remove', key: 'a' });
    fire();
    expect(saved).toEqual([{ b: 2 }]);
  });

  it('does not save when removing a key that is not there', () => {
    const { api, saved, fire } = setup();
    api.handle({ type: 'state-remove', key: 'zzz' });
    fire();
    expect(saved).toEqual([]);
  });

  it('refuses a new key beyond the key limit but still updates existing ones', () => {
    const state = Object.fromEntries(Array.from({ length: BRIDGE_LIMITS.maxStateKeys }, (_, i) => [`k${i}`, i]));
    const { api, saved, logs, fire } = setup({ state });
    api.handle({ type: 'state-set', key: 'one-too-many', value: 1 });
    api.handle({ type: 'state-set', key: 'k0', value: 'changed' });
    fire();
    expect(logs).toEqual([['warn', [expect.stringMatching(/at most 64 keys/)]]]);
    expect(saved[0]['k0']).toBe('changed');
    expect(saved[0]['one-too-many']).toBeUndefined();
  });

  it('refuses state beyond the size cap and keeps what fits', () => {
    const { api, saved, logs, fire } = setup();
    api.handle({ type: 'state-set', key: 'small', value: 'ok' });
    api.handle({ type: 'state-set', key: 'big', value: 'x'.repeat(BRIDGE_LIMITS.maxStateBytes) });
    fire();
    expect(logs).toEqual([['warn', [expect.stringMatching(/64 KiB/)]]]);
    expect(saved).toEqual([{ small: 'ok' }]);
  });

  it('writes pending state when destroyed and ignores later messages', () => {
    const { api, saved, logs } = setup();
    api.handle({ type: 'state-set', key: 'n', value: 7 });
    api.destroy();
    api.handle({ type: 'state-set', key: 'n', value: 8 });
    api.handle({ type: 'log', level: 'log', args: ['late'] });
    expect(saved).toEqual([{ n: 7 }]);
    expect(logs).toEqual([]);
  });

  it('does not alias the stored state object', () => {
    const initial: Record<string, JsonValue> = { a: 1 };
    const { api, saved, fire } = setup({ state: initial });
    api.handle({ type: 'state-set', key: 'b', value: 2 });
    fire();
    expect(initial).toEqual({ a: 1 });
    expect(saved[0]).not.toBe(initial);
  });
});

describe('HostApi navigation, links and passthrough', () => {
  it('forwards navigation only while presenting', () => {
    const present = setup({ mode: 'present' });
    present.api.handle({ type: 'navigate', action: 'next' });
    present.api.handle({ type: 'navigate', action: 'goTo', slideId: 'sl_2' });
    expect(present.navigations).toEqual([{ action: 'next' }, { action: 'goTo', slideId: 'sl_2' }]);

    const edit = setup({ mode: 'edit' });
    edit.api.handle({ type: 'navigate', action: 'prev' });
    expect(edit.navigations).toEqual([]);
    expect(edit.logs[0][1][0]).toMatch(/only works while presenting/);
  });

  it.each([['javascript:alert(1)'], ['data:text/html,x'], ['file:///etc/passwd'], ['https://exa mple.com'], ['vbscript:x']])('refuses the link %s', (url) => {
    const { api, links, logs } = setup();
    api.handle({ type: 'link', url });
    expect(links).toEqual([]);
    expect(logs[0][0]).toBe('warn');
  });

  it.each([['https://example.com/a?b=1'], ['http://example.com'], ['mailto:me@example.com']])('forwards the link %s', (url) => {
    const { api, links } = setup();
    api.handle({ type: 'link', url });
    expect(links).toEqual([url]);
  });

  it('passes steps, heartbeats, errors, logs and snapshots on', () => {
    const { api, deps, logs } = setup();
    const blob = new Blob(['x'], { type: 'image/png' });
    api.handle({ type: 'steps', count: 4 });
    api.handle({ type: 'heartbeat' });
    api.handle({ type: 'error', message: 'boom', stack: 's' });
    api.handle({ type: 'log', level: 'info', args: ['a', 1] });
    api.handle({ type: 'snapshot', blob });
    expect(deps.onSteps).toHaveBeenCalledWith(4);
    expect(deps.onHeartbeat).toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith('boom', 's');
    expect(logs).toEqual([['info', ['a', 1]]]);
    expect(deps.onSnapshot).toHaveBeenCalledWith(blob);
  });
});

describe('HostApi assets', () => {
  it('answers a declared asset with its bytes, transferred', async () => {
    const { api, sent } = setup();
    api.handle({ type: 'asset-request', id: 5, assetId: 'asset-a' });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toEqual({ type: 'asset', id: 5, mime: 'image/png', data: expect.any(ArrayBuffer) });
    expect(sent[0].transfer).toHaveLength(1);
  });

  it.each([['an undeclared asset', 'asset-b'], ['a path', '../asset-a'], ['an inherited name', 'toString']])('refuses %s without reading it', async (_name, assetId) => {
    const readAsset = vi.fn();
    const { api, sent } = setup({ readAsset });
    api.handle({ type: 'asset-request', id: 1, assetId });
    await flush();
    expect(readAsset).not.toHaveBeenCalled();
    expect(sent[0].message).toEqual({ type: 'asset', id: 1, mime: '', data: null });
  });

  it('answers null for a missing asset and for a read that throws', async () => {
    const { api, sent } = setup({ readAsset: async () => null });
    api.handle({ type: 'asset-request', id: 1, assetId: 'asset-a' });
    const failing = setup({
      readAsset: async () => {
        throw new Error('db');
      },
    });
    failing.api.handle({ type: 'asset-request', id: 2, assetId: 'asset-a' });
    await flush();
    expect(sent[0].message).toEqual({ type: 'asset', id: 1, mime: '', data: null });
    expect(failing.sent[0].message).toEqual({ type: 'asset', id: 2, mime: '', data: null });
  });

  it('limits the reads in flight', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const readAsset = vi.fn(async () => {
      await gate;
      return { mime: 'a/b', data: new ArrayBuffer(1) };
    });
    const { api, sent } = setup({ readAsset });
    for (let i = 0; i < BRIDGE_LIMITS.maxPendingAssets + 3; i++) api.handle({ type: 'asset-request', id: i, assetId: 'asset-a' });
    expect(readAsset).toHaveBeenCalledTimes(BRIDGE_LIMITS.maxPendingAssets);
    expect(sent.filter((s) => (s.message as { data: unknown }).data === null)).toHaveLength(3);
    release?.();
    await flush();
    expect(sent).toHaveLength(BRIDGE_LIMITS.maxPendingAssets + 3);
  });
});

describe('HostApi fetch', () => {
  const request = (url: string, init: Extract<FrameMessage, { type: 'fetch' }>['init'] = {}, id = 1): FrameMessage => ({ type: 'fetch', id, url, init });
  const okResponse = () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': 'a=b' } });

  it('is off without the network permission', async () => {
    const fetchImpl = vi.fn();
    const { api, sent } = setup({ fetchImpl, networkOrigins: [] });
    api.handle(request('https://api.example.com/x'));
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sent[0].message).toMatchObject({ type: 'fetch-result', ok: false, error: expect.stringMatching(/network permission/) });
  });

  it('proxies an allowed origin with credentials and redirects off and returns the body', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const { api, sent } = setup({ fetchImpl, networkOrigins: ['https://api.example.com'] });
    api.handle(request('https://api.example.com/x?y=1', { method: 'post', headers: { Accept: 'text/plain' }, body: 'b' }));
    await flush();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/x?y=1',
      expect.objectContaining({ method: 'POST', headers: { Accept: 'text/plain' }, body: 'b', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }),
    );
    const result = sent[0].message as Extract<HostMessage, { type: 'fetch-result' }>;
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(new TextDecoder().decode(result.body!)).toBe('hello');
    expect(result.headers).toEqual([['content-type', 'text/plain']]);
    expect(sent[0].transfer).toEqual([result.body]);
  });

  it.each([
    ['another origin', 'https://evil.example.org/x', /not an allowed origin/],
    ['another port', 'https://api.example.com:8443/x', /not an allowed origin/],
    ['a lookalike host', 'https://api.example.com.evil.org/x', /not an allowed origin/],
    ['plain http', 'http://api.example.com/x', /not an allowed origin/],
    ['credentials in the URL', 'https://user:pw@api.example.com/x', /credentials/],
    ['a relative URL', '/x', /Invalid URL/],
    ['a data URL', 'data:text/plain,hi', /not an allowed origin/],
  ])('refuses %s', async (_name, url, error) => {
    const fetchImpl = vi.fn(async () => okResponse());
    const { api, sent } = setup({ fetchImpl, networkOrigins: ['https://api.example.com'] });
    api.handle(request(url));
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sent[0].message).toMatchObject({ ok: false, error: expect.stringMatching(error) });
  });

  it.each([
    ['a forbidden method', { method: 'CONNECT' }, /Method CONNECT/],
    ['a body on GET', { body: 'x' }, /no body/],
    ['a cookie header', { headers: { Cookie: 'a=b' } }, /Header "Cookie"/],
    ['a sec- header', { headers: { 'Sec-Fetch-Mode': 'x' } }, /not allowed/],
    ['a malformed header name', { headers: { 'A B': 'x' } }, /not allowed/],
  ])('refuses %s', async (_name, init, error) => {
    const fetchImpl = vi.fn(async () => okResponse());
    const { api, sent } = setup({ fetchImpl, networkOrigins: ['https://api.example.com'] });
    api.handle(request('https://api.example.com/x', init));
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sent[0].message).toMatchObject({ ok: false, error: expect.stringMatching(error) });
  });

  it('refuses a response over the size cap', async () => {
    const big = new Response(new Uint8Array(BRIDGE_LIMITS.maxFetchResponseBytes + 1));
    const { api, sent } = setup({ fetchImpl: async () => big, networkOrigins: ['https://api.example.com'] });
    api.handle(request('https://api.example.com/x'));
    await flush();
    expect(sent[0].message).toMatchObject({ ok: false, error: expect.stringMatching(/too large/) });
  });

  it('reports a failing request and limits requests in flight', async () => {
    const failing = setup({
      fetchImpl: async () => {
        throw new TypeError('network down');
      },
      networkOrigins: ['https://api.example.com'],
    });
    failing.api.handle(request('https://api.example.com/x'));
    await flush();
    expect(failing.sent[0].message).toMatchObject({ ok: false, error: 'network down' });

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return okResponse();
    });
    const busy = setup({ fetchImpl, networkOrigins: ['https://api.example.com'] });
    for (let i = 0; i < BRIDGE_LIMITS.maxPendingFetches + 2; i++) busy.api.handle(request('https://api.example.com/x', {}, i));
    expect(fetchImpl).toHaveBeenCalledTimes(BRIDGE_LIMITS.maxPendingFetches);
    expect(busy.sent.filter((s) => (s.message as { error?: string }).error?.match(/Too many/))).toHaveLength(2);
    release?.();
    await flush();
  });

  it('aborts requests in flight when destroyed and does not answer', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const { api, sent } = setup({ fetchImpl: fetchImpl as unknown as typeof fetch, networkOrigins: ['https://api.example.com'] });
    api.handle(request('https://api.example.com/x'));
    api.destroy();
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(sent).toEqual([]);
  });
});
