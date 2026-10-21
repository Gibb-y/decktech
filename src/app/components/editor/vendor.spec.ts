import { MAX_LIBRARY_BYTES, accessibilityHints, cdnUrl, externalImports, fetchLibrary, networkDependencies, readLibraryFile, type Fetcher } from './vendor';

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
  ])('builds the address for %s %s', (name, version, url) => {
    expect(cdnUrl(name, version)).toEqual({ ok: true, value: url });
  });

  it.each(['', 'D3', '../x', 'a/b', 'https://evil.example/x', 'a b', '@scope', '@/x', 'x'.repeat(215), 'a..b/../c', '?x'])('rejects the package name %j', (name) => {
    expect(cdnUrl(name, '1.0.0').ok).toBe(false);
  });

  it.each(['1.0.0/../../x', '1 0', '^1', '1.0.0?x=1', '#x', 'a'.repeat(65)])('rejects the version %j', (version) => {
    expect(cdnUrl('d3', version)).toMatchObject({ ok: false, error: expect.stringContaining('not a valid version') });
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
