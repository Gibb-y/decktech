import { MAX_LIBRARY_BYTES, accessibilityHints, cdnUrl, checkLibraryText, externalImports, fetchLibrary, isLibraryName, networkDependencies, peerFor, readLibraryFile, resolvePeers, type Fetcher } from './vendor';

const response = (body: string, init: { ok?: boolean; status?: number; type?: string; length?: string } = {}): Awaited<ReturnType<Fetcher>> => ({
  ok: init.ok ?? true,
  status: init.status ?? 200,
  headers: { get: (name: string) => (name === 'content-type' ? (init.type ?? 'text/javascript') : name === 'content-length' ? (init.length ?? null) : null) },
  blob: async () => new Blob([body]),
});

describe('cdnUrl', () => {
  it.each([
    ['d3', '7.9.0', 'https://esm.sh/d3@7.9.0?bundle&target=es2022'],
    ['@observablehq/plot', '0.6.16', 'https://esm.sh/@observablehq/plot@0.6.16?bundle&target=es2022'],
    ['chart.js', '', 'https://esm.sh/chart.js@latest?bundle&target=es2022'],
    ['  three ', ' 0.170.0-beta.1 ', 'https://esm.sh/three@0.170.0-beta.1?bundle&target=es2022'],
    ['react-dom/client', '19.3.1', 'https://esm.sh/react-dom@19.3.1/client?bundle&target=es2022'],
    ['@scope/pkg/sub/path', '1.0.0', 'https://esm.sh/@scope/pkg@1.0.0/sub/path?bundle&target=es2022'],
  ])('builds the address for %s %s', (name, version, url) => {
    expect(cdnUrl(name, version)).toEqual({ ok: true, value: url });
  });

  it.each(['', 'D3', '../x', 'a/../b', 'a/./b', 'a//b', 'a/', '@scope/', 'https://evil.example/x', 'a b', '@scope', '@/x', 'x'.repeat(215), 'a..b/../c', '?x'])('rejects the package name %j', (name) => {
    expect(cdnUrl(name, '1.0.0').ok).toBe(false);
  });

  it.each(['1.0.0/../../x', '1 0', '^1', '1.0.0?x=1', '#x', 'a'.repeat(65)])('rejects the version %j', (version) => {
    expect(cdnUrl('d3', version)).toMatchObject({ ok: false, error: expect.stringContaining('not a valid version') });
  });
});

describe('isLibraryName', () => {
  it.each(['react', 'react-dom/client', '@observablehq/plot', 'my.lib_2'])('accepts %s', (name) => expect(isLibraryName(name)).toBe(true));
  it.each(['', 'React', '__proto__', 'a b', 'https://x', '/abs', 'a?b'])('rejects %j', (name) => expect(isLibraryName(name)).toBe(false));
});

describe('peerFor and resolvePeers', () => {
  const peers = new Map([['react', 'abc'], ['react/jsx-runtime', 'def'], ['@scope/pkg', 'ghi']]);

  it.each([
    ['/react@19.3.1/es2022/react.mjs', 'abc'],
    ['/v135/react@19.3.1/es2022/react.mjs', 'abc'],
    ['/react@19.3.1/es2022/jsx-runtime.mjs', 'def'],
    ['/@scope/pkg@1.0.0/es2022/pkg.js', 'ghi'],
    ['/react/es2022/react.mjs', 'abc'],
  ])('maps %s to its library', (path, id) => expect(peerFor(path, peers)).toBe(id));

  it.each(['/vue@3.0.0/es2022/vue.mjs', '/react@19.3.1/es2022/other.mjs', '/react', '/', '/react@1/a/b/react.mjs', '/constructor@1/es2022/constructor.mjs'])('finds no library for %s', (path) => expect(peerFor(path, peers)).toBeUndefined());

  it('rewrites every import syntax of a mapped path and leaves the rest alone', () => {
    const source = `import a from "/react@19.3.1/es2022/react.mjs"; import "/react@1/es2022/react.mjs"; export * from '/react@1/es2022/react.mjs'; const m = await import("/react@1/es2022/react.mjs"); import v from "/vue@3/es2022/vue.mjs"; import w from "//cdn.example/react@1/es2022/react.mjs"; const s = "/react@1/es2022/react.mjs";`;
    expect(resolvePeers(source, peers)).toBe(`import a from "abc"; import "abc"; export * from 'abc'; const m = await import("abc"); import v from "/vue@3/es2022/vue.mjs"; import w from "//cdn.example/react@1/es2022/react.mjs"; const s = "/react@1/es2022/react.mjs";`);
  });

  it('does nothing without peers', () => {
    const source = 'import a from "/react@1/es2022/react.mjs";';
    expect(resolvePeers(source, new Map())).toBe(source);
  });
});

describe('checkLibraryText', () => {
  it('accepts self-contained text and resolves peers', () => {
    expect(checkLibraryText('export const x = 1;')).toEqual({ ok: true, value: 'export const x = 1;' });
    expect(checkLibraryText('import r from "/react@1/es2022/react.mjs";', new Map([['react', 'abc']]))).toEqual({ ok: true, value: 'import r from "abc";' });
  });

  it('refuses what still imports from the network', () => {
    expect(checkLibraryText('import r from "/react@1/es2022/react.mjs";')).toMatchObject({ ok: false, error: expect.stringMatching(/imports from elsewhere/) });
  });
});

describe('externalImports', () => {
  it('finds imports from the network in every syntax', () => {
    const source = `import a from "https://cdn.example/a.js"; import "//cdn.example/b.js"; export * from '/npm/c'; const d = await import('http://x/d');`;
    expect(externalImports(source).sort()).toEqual(['//cdn.example/b.js', '/npm/c', 'http://x/d', 'https://cdn.example/a.js']);
  });

  it('ignores self-contained code and relative or bare names the import map resolves', () => {
    expect(externalImports('const url = "https://example.com"; export default function () {}')).toEqual([]);
    expect(externalImports('import x from "other-lib";')).toEqual([]);
  });
});

describe('fetchLibrary', () => {
  it('follows the stub a package address answers with, once, to a path on the CDN', async () => {
    const calls: string[] = [];
    const result = await fetchLibrary('chart.js', '4.4.0', async (url) => {
      calls.push(url);
      return response(calls.length === 1 ? 'export * from "/chart.js@4.4.0/es2022/chart.bundle.mjs";' : 'export const chart = 1;');
    });
    expect(calls).toEqual(['https://esm.sh/chart.js@4.4.0?bundle&target=es2022', 'https://esm.sh/chart.js@4.4.0/es2022/chart.bundle.mjs']);
    expect(result).toMatchObject({ ok: true });
  });

  it('does not follow a stub to another host, or a bundle that itself imports from the network', async () => {
    expect(await fetchLibrary('x', '1', async () => response('export * from "//evil.example/x.js";'))).toMatchObject({ ok: false });
    const calls: string[] = [];
    const nested = await fetchLibrary('x', '1', async (url) => (calls.push(url), response('export * from "/x@1/a.mjs";')));
    expect(nested).toMatchObject({ ok: false, error: expect.stringMatching(/imports from the network/) });
    expect(calls).toHaveLength(2);
  });

  it('points the imports of a vendored package at it, also when the stub names it next to the bundle', async () => {
    const peers = new Map([['react', 'abc123']]);
    const calls: string[] = [];
    const result = await fetchLibrary('react-dom/client', '19.3.1', async (url) => {
      calls.push(url);
      return response(calls.length === 1 ? 'import "/react@19.3.1/es2022/react.mjs"; export * from "/react-dom@19.3.1/es2022/client.bundle.mjs";' : 'import { a } from "/react@19.3.1/es2022/react.mjs"; export const b = a;');
    }, peers);
    expect(calls).toEqual(['https://esm.sh/react-dom@19.3.1/client?bundle&target=es2022', 'https://esm.sh/react-dom@19.3.1/es2022/client.bundle.mjs']);
    expect(result).toMatchObject({ ok: true, value: { label: 'react-dom/client@19.3.1', shared: ['/react@19.3.1/es2022/react.mjs'] } });
    if (result.ok) expect(await result.value.blob.text()).toBe('import { a } from "abc123"; export const b = a;');
  });

  it('without the peer it fails and says to add the other library first', async () => {
    const result = await fetchLibrary('react-dom/client', '19.3.1', async () => response('import { a } from "/react@19.3.1/es2022/react.mjs"; export const b = a;'));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/add that one first/) });
  });

  it('returns the module as a JavaScript blob labelled with name and version', async () => {
    const calls: string[] = [];
    const result = await fetchLibrary('d3', '7.9.0', async (url) => (calls.push(url), response('export const x = 1;')));
    expect(calls).toEqual(['https://esm.sh/d3@7.9.0?bundle&target=es2022']);
    expect(result).toMatchObject({ ok: true, value: { label: 'd3@7.9.0' } });
    if (result.ok) {
      expect(result.value.blob.type).toBe('text/javascript');
      expect(await result.value.blob.text()).toBe('export const x = 1;');
    }
  });

  it('does not ask the network for an invalid name', async () => {
    const fetcher = vi.fn();
    expect(await fetchLibrary('../x', '1', fetcher)).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each<[string, () => Promise<Awaited<ReturnType<Fetcher>>>, RegExp]>([
    ['offline', () => Promise.reject(new Error('Failed to fetch')), /online once/],
    ['an unknown package', async () => response('', { ok: false, status: 404 }), /\(404\)/],
    ['an advertised size past the limit', async () => response('x', { length: String(MAX_LIBRARY_BYTES + 1) }), /larger than 5 MiB/],
    ['a body past the limit', async () => response('x'.repeat(MAX_LIBRARY_BYTES + 1)), /larger than 5 MiB/],
    ['html', async () => response('<html><body>nope</body></html>', { type: 'text/html' }), /not JavaScript/],
    ['a module that imports from the CDN', async () => response('import "/npm/dep@1/+esm"; export default 1;'), /imports from the network.*offline/],
  ])('refuses %s', async (_name, fetcher, message) => {
    expect(await fetchLibrary('d3', '1.0.0', fetcher)).toMatchObject({ ok: false, error: expect.stringMatching(message) });
  });
});

describe('readLibraryFile', () => {
  it('accepts a self-contained module', async () => {
    const result = await readLibraryFile(new File(['export const a = 1;'], 'lib.mjs'));
    expect(result).toMatchObject({ ok: true });
  });

  it.each<[string, File, RegExp]>([
    ['another type of file', new File(['x'], 'lib.exe'), /\.js or \.mjs/],
    ['an import from elsewhere', new File(['import x from "https://cdn.example/x.js";'], 'lib.js'), /imports from elsewhere/],
  ])('refuses %s', async (_name, file, message) => {
    expect(await readLibraryFile(file)).toMatchObject({ ok: false, error: expect.stringMatching(message) });
  });

  it('refuses a file past the size limit', async () => {
    const file = new File(['x'], 'big.js');
    Object.defineProperty(file, 'size', { value: MAX_LIBRARY_BYTES + 1 });
    expect(await readLibraryFile(file)).toMatchObject({ ok: false, error: expect.stringContaining('5 MiB') });
  });
});

describe('networkDependencies', () => {
  const none = { html: '', css: '', js: '' };

  it('flags addresses in markup, styles and scripts', () => {
    expect(
      networkDependencies({
        html: '<script src="https://cdn.example/a.js"></script><link href=\'http://x.example/s.css\'><img src="local.png">',
        css: '@import "https://fonts.example/f.css"; .a { background: url(https://img.example/b.png) }',
        js: 'import d3 from "https://esm.example/d3"; const m = await import("https://esm.example/m"); fetch("https://api.example/data")',
      }).sort(),
    ).toEqual(['http://x.example/s.css', 'https://api.example/data', 'https://cdn.example/a.js', 'https://esm.example/d3', 'https://esm.example/m', 'https://fonts.example/f.css', 'https://img.example/b.png']);
  });

  it('does not flag plain text, relative paths, data urls or bare library names', () => {
    expect(
      networkDependencies({ html: '<a href="#top">https://example.com</a><img src="data:image/png;base64,AA==">', css: '.a { background: url(data:image/png;base64,AA==) }', js: 'import * as lib from "abc123"; const text = "see https://example.com";' }),
    ).toEqual([]);
    expect(networkDependencies(none)).toEqual([]);
  });

  it('lists each address once', () => {
    expect(networkDependencies({ ...none, html: '<img src="https://a.example/x"><img src="https://a.example/x">' })).toEqual(['https://a.example/x']);
  });
});

describe('accessibilityHints', () => {
  const hints = (html: string, css = '') => accessibilityHints({ html, css, js: '' });

  it('is quiet for a sensible component', () => {
    expect(hints('<button type="button">Go</button><img src="a.png" alt="A chart"><label for="n">N</label><input id="n">', 'a { color: red }')).toEqual([]);
  });

  it.each<[string, string, string, RegExp]>([
    ['an image without alt', '<img src="a.png">', '', /no alt/],
    ['a clickable div', '<div onclick="go()">Go</div>', '', /<button>/],
    ['an empty button', '<button></button>', '', /no text/],
    ['an unlabelled control', '<input type="text">', '', /no label/],
    ['animation without reduced motion', '<p>x</p>', '@keyframes spin { to { transform: rotate(1turn) } }', /prefers-reduced-motion/],
    ['no focus outline', '<p>x</p>', 'button:focus { outline: none }', /focus outline/],
  ])('flags %s', (_name, html, css, message) => {
    expect(hints(html, css).join(' ')).toMatch(message);
  });

  it('accepts animation that respects reduced motion', () => {
    expect(hints('<p>x</p>', '@keyframes s { to { opacity: 0 } } @media (prefers-reduced-motion: reduce) { * { animation: none } }')).toEqual([]);
  });
});
