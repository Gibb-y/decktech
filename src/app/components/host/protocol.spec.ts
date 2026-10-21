import { BRIDGE_LIMITS, isSupportedApiVersion, measureJson, normalizeOrigin, parseFrameMessage, supportedApiVersions, API_VERSION } from './protocol';

const valid: [string, unknown][] = [
  ['heartbeat', { type: 'heartbeat' }],
  ['steps', { type: 'steps', count: 3 }],
  ['steps zero', { type: 'steps', count: 0 }],
  ['state-set', { type: 'state-set', key: 'n', value: { a: [1, 'x', null, true] } }],
  ['state-set null', { type: 'state-set', key: 'n', value: null }],
  ['state-remove', { type: 'state-remove', key: 'n' }],
  ['navigate next', { type: 'navigate', action: 'next' }],
  ['navigate prev', { type: 'navigate', action: 'prev' }],
  ['navigate goTo', { type: 'navigate', action: 'goTo', slideId: 'sl_1' }],
  ['asset-request', { type: 'asset-request', id: 1, assetId: 'a'.repeat(64) }],
  ['log', { type: 'log', level: 'warn', args: ['x', 1, { a: 1 }] }],
  ['error', { type: 'error', message: 'boom', stack: 'at x' }],
  ['error without stack', { type: 'error', message: 'boom' }],
  ['link', { type: 'link', url: 'https://example.com/' }],
  ['fetch', { type: 'fetch', id: 2, url: 'https://api.example.com/x', init: { method: 'POST', headers: { Accept: 'x' }, body: '{}' } }],
  ['fetch without init', { type: 'fetch', id: 2, url: 'https://api.example.com/x' }],
  ['snapshot', { type: 'snapshot', blob: new Blob(['x'], { type: 'image/png' }) }],
];

const invalid: [string, unknown, RegExp][] = [
  ['null', null, /object/],
  ['an array', [], /object/],
  ['a string', 'ready', /object/],
  ['no type', {}, /unknown message type/],
  ['unknown type', { type: 'eval', code: '1' }, /unknown message type/],
  ['inherited type name', { type: 'toString' }, /unknown message type/],
  ['__proto__ as type', { type: '__proto__' }, /unknown message type/],
  ['constructor as type', { type: 'constructor' }, /unknown message type/],
  ['init (host-only)', { type: 'init' }, /unknown message type/],
  ['extra field', { type: 'heartbeat', extra: 1 }, /unexpected field "extra"/],
  ['steps negative', { type: 'steps', count: -1 }, /steps\.count/],
  ['steps fractional', { type: 'steps', count: 1.5 }, /steps\.count/],
  ['steps too large', { type: 'steps', count: 1001 }, /steps\.count/],
  ['steps NaN', { type: 'steps', count: Number.NaN }, /plain JSON/],
  ['steps string', { type: 'steps', count: '3' }, /steps\.count/],
  ['state-set without value', { type: 'state-set', key: 'n' }, /state-set/],
  ['state-set empty key', { type: 'state-set', key: '', value: 1 }, /state-set/],
  ['state-set long key', { type: 'state-set', key: 'k'.repeat(65), value: 1 }, /state-set/],
  ['state-set __proto__ key', { type: 'state-set', key: '__proto__', value: 1 }, /state-set/],
  ['state-set hostile nested key', JSON.parse('{"type":"state-set","key":"a","value":{"__proto__":{"x":1}}}'), /plain JSON/],
  ['state-set undefined value', { type: 'state-set', key: 'a', value: undefined }, /plain JSON/],
  ['state-set function', { type: 'state-set', key: 'a', value: () => 1 }, /plain JSON/],
  ['state-set Date', { type: 'state-set', key: 'a', value: new Date() }, /plain JSON/],
  ['state-set Map', { type: 'state-set', key: 'a', value: new Map() }, /plain JSON/],
  ['state-set class instance', { type: 'state-set', key: 'a', value: new (class X {})() }, /plain JSON/],
  ['state-set Infinity', { type: 'state-set', key: 'a', value: Number.POSITIVE_INFINITY }, /plain JSON/],
  ['navigate unknown action', { type: 'navigate', action: 'jump' }, /navigate\.action/],
  ['navigate goTo without id', { type: 'navigate', action: 'goTo' }, /slideId/],
  ['navigate goTo bad id', { type: 'navigate', action: 'goTo', slideId: '../x' }, /slideId/],
  ['navigate next with id', { type: 'navigate', action: 'next', slideId: 'sl_1' }, /slideId/],
  ['asset-request bad id', { type: 'asset-request', id: -1, assetId: 'a' }, /asset-request/],
  ['asset-request path', { type: 'asset-request', id: 1, assetId: '../../x' }, /asset-request/],
  ['log bad level', { type: 'log', level: 'debug', args: [] }, /log needs/],
  ['log too many args', { type: 'log', level: 'log', args: new Array(11).fill(1) }, /log needs/],
  ['log args not array', { type: 'log', level: 'log', args: 'x' }, /log needs/],
  ['error long message', { type: 'error', message: 'x'.repeat(4001) }, /error\.message/],
  ['error non-string stack', { type: 'error', message: 'x', stack: 1 }, /error\.stack/],
  ['link not string', { type: 'link', url: 5 }, /link\.url/],
  ['fetch bad init', { type: 'fetch', id: 1, url: 'https://a.example', init: 'x' }, /init must be an object/],
  ['fetch init extra', { type: 'fetch', id: 1, url: 'https://a.example', init: { credentials: 'include' } }, /unexpected field "credentials"/],
  ['fetch non-string header', { type: 'fetch', id: 1, url: 'https://a.example', init: { headers: { A: 1 } } }, /headers/],
  ['fetch non-string body', { type: 'fetch', id: 1, url: 'https://a.example', init: { body: { a: 1 } } }, /body/],
  ['snapshot string', { type: 'snapshot', blob: 'data:image/png;base64,AAAA' }, /Blob/],
  ['snapshot wrong type', { type: 'snapshot', blob: new Blob(['x'], { type: 'text/html' }) }, /PNG, JPEG or WebP/],
  ['snapshot empty', { type: 'snapshot', blob: new Blob([], { type: 'image/png' }) }, /between 1 byte and 2 MiB/],
  ['snapshot extra field', { type: 'snapshot', blob: new Blob(['x'], { type: 'image/png' }), url: 'x' }, /unexpected field/],
];

describe('parseFrameMessage', () => {
  it.each(valid)('accepts %s', (_name, data) => {
    const result = parseFrameMessage(data);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.type).toBe((data as { type: string }).type);
  });

  it.each(invalid)('rejects %s', (_name, data, message) => {
    const result = parseFrameMessage(data);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });

  it('rejects a payload over the size cap', () => {
    const result = parseFrameMessage({ type: 'state-set', key: 'big', value: 'x'.repeat(BRIDGE_LIMITS.maxMessageBytes) });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/64 KiB/) });
  });

  it('rejects a snapshot over the size cap', () => {
    const blob = new Blob([new Uint8Array(BRIDGE_LIMITS.maxSnapshotBytes + 1)], { type: 'image/png' });
    expect(parseFrameMessage({ type: 'snapshot', blob })).toEqual({ ok: false, error: expect.stringMatching(/2 MiB/) });
  });

  it('rejects values nested deeper than the limit and survives a cycle', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { a: deep };
    expect(parseFrameMessage({ type: 'state-set', key: 'a', value: deep }).ok).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(parseFrameMessage({ type: 'state-set', key: 'a', value: cycle }).ok).toBe(false);
  });

  it('keeps the parsed value free of fields the frame added', () => {
    const result = parseFrameMessage({ type: 'steps', count: 2 });
    expect(result).toEqual({ ok: true, value: { type: 'steps', count: 2 } });
  });
});

describe('measureJson', () => {
  it('measures plain JSON and counts keys', () => {
    expect(measureJson({ a: [1, 'two', null] }, 1000)).toBeGreaterThan(10);
    expect(measureJson('x'.repeat(100), 50)).toBeNull();
  });

  it.each([[undefined], [Symbol('x')], [10n], [() => 1], [new Uint8Array(1)], [Number.NaN]])('refuses %s', (value) => {
    expect(measureJson({ v: value }, 1000)).toBeNull();
  });

  it('accepts objects without a prototype', () => {
    expect(measureJson(Object.assign(Object.create(null), { a: 1 }), 100)).not.toBeNull();
  });
});

describe('API versions', () => {
  it('supports the current major and, once there is one, the previous', () => {
    expect(isSupportedApiVersion(API_VERSION)).toBe(true);
    expect(supportedApiVersions(1)).toEqual([1]);
    expect(supportedApiVersions(3)).toEqual([2, 3]);
  });

  it.each([[0], [2], [-1], [1.5], ['1'], [null], [undefined], [Number.NaN]])('refuses %s', (version) => {
    expect(isSupportedApiVersion(version)).toBe(false);
  });
});

describe('normalizeOrigin', () => {
  it.each([
    ['https://api.example.com', 'https://api.example.com'],
    ['https://api.example.com/some/path?q=1', 'https://api.example.com'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://127.0.0.1:3000/x', 'http://127.0.0.1:3000'],
  ])('keeps %s as %s', (input, expected) => expect(normalizeOrigin(input)).toBe(expected));

  it.each([['http://example.com'], ['ftp://example.com'], ['javascript:alert(1)'], ['data:text/html,x'], ['https://user:pw@example.com'], ['not a url'], [''], [5], [null]])(
    'refuses %s',
    (input) => expect(normalizeOrigin(input)).toBeNull(),
  );
});
