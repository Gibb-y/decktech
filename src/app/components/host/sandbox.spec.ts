import { createTheme } from '../../core/model';
import { themeVars } from '../../renderer';
import { buildDocument, contentSecurityPolicy } from './document-builder';
import { FORBIDDEN_SANDBOX_TOKENS, SANDBOX_TOKENS, assertSafeSandbox, createSandboxFrame } from './sandbox';

describe('sandbox policy', () => {
  it('is exactly allow-scripts', () => {
    expect(SANDBOX_TOKENS).toEqual(['allow-scripts']);
  });

  it('never contains a forbidden flag, in particular allow-same-origin', () => {
    expect(FORBIDDEN_SANDBOX_TOKENS).toContain('allow-same-origin');
    for (const token of SANDBOX_TOKENS) expect(FORBIDDEN_SANDBOX_TOKENS).not.toContain(token);
  });

  it.each(FORBIDDEN_SANDBOX_TOKENS.map((token) => [token]))('refuses a sandbox list with %s', (token) => {
    expect(() => assertSafeSandbox(['allow-scripts', token])).toThrow(/Unsafe sandbox flag/);
    expect(() => assertSafeSandbox([token])).toThrow(/Unsafe sandbox flag/);
  });

  it('refuses any list that is not exactly the approved one', () => {
    expect(() => assertSafeSandbox([])).toThrow(/exactly/);
    expect(() => assertSafeSandbox(['allow-scripts', 'allow-unknown-future-flag'])).toThrow(/exactly/);
  });

  it('creates a frame with only allow-scripts, an empty feature policy and a title', () => {
    const frame = createSandboxFrame(document, '<p>hi</p>', 'Code component: Counter');
    expect(frame.getAttribute('sandbox')?.split(/\s+/)).toEqual(['allow-scripts']);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('allow')).toBe('');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.title).toBe('Code component: Counter');
    expect(frame.srcdoc).toBe('<p>hi</p>');
    expect(frame.hasAttribute('src')).toBe(false);
  });
});

describe('contentSecurityPolicy', () => {
  it('blocks the network by default', () => {
    const csp = contentSecurityPolicy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval' blob:");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain('img-src blob: data:;');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('widens connect-src and img-src to the listed origins only', () => {
    const csp = contentSecurityPolicy(['https://api.example.com/path', 'http://localhost:3000', 'http://evil.example.org', 'javascript:x', 'https://api.example.com']);
    expect(csp).toContain('connect-src https://api.example.com http://localhost:3000;');
    expect(csp).toContain('img-src blob: data: https://api.example.com http://localhost:3000;');
    expect(csp).not.toContain('evil');
    expect(csp).not.toContain("connect-src 'none'");
    expect(csp).not.toMatch(/(script|default|style)-src[^;]*https:/);
  });
});

describe('buildDocument', () => {
  const vars = themeVars(createTheme('light'));
  const build = (def: { html?: string; css?: string; js?: string } = {}, extra: { runtime?: string; networkOrigins?: string[] } = {}) =>
    buildDocument({ def: { html: '', css: '', js: '', ...def }, runtime: extra.runtime ?? '/*runtime*/', themeVars: vars, networkOrigins: extra.networkOrigins });
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

  it('puts the CSP first in the head, then the theme, the user CSS, the runtime and the user HTML', () => {
    const doc = parse(build({ html: '<p id="x">hi</p>', css: '#x{color:red}', js: 'deck.log(1)' }, { runtime: 'window.__r=1' }));
    const head = Array.from(doc.head.children);
    const csp = head.find((e) => e.getAttribute('http-equiv') === 'Content-Security-Policy')!;
    expect(csp.getAttribute('content')).toContain("connect-src 'none'");
    // Only the charset may come before it; every style and script comes after.
    expect(head.indexOf(csp)).toBeLessThanOrEqual(1);
    expect(head.filter((e) => /^(STYLE|SCRIPT|LINK)$/.test(e.tagName)).every((e) => head.indexOf(e) > head.indexOf(csp))).toBe(true);
    expect(doc.getElementById('deck-base')?.textContent).toContain('--deck-color-text');
    expect(doc.getElementById('deck-user-css')?.textContent).toBe('#x{color:red}');
    expect(doc.getElementById('deck-runtime')?.textContent).toBe('window.__r=1');
    expect(doc.getElementById('x')?.textContent).toBe('hi');
    const ids = Array.from(doc.querySelectorAll('[id]'), (e) => e.id);
    expect(ids.indexOf('deck-runtime')).toBeLessThan(ids.indexOf('x'));
  });

  it('carries the user script as inert JSON and round-trips awkward source', () => {
    const js = 'const s = "</script><script>alert(1)</script>"; /* <!-- */ const t = ` ${1}`;\nexport {};';
    const doc = parse(build({ js }));
    const holder = doc.getElementById('deck-user-js')!;
    expect(holder.getAttribute('type')).toBe('application/json');
    expect(JSON.parse(holder.textContent!)).toBe(js);
    expect(doc.querySelectorAll('script')).toHaveLength(2); // runtime and the JSON holder: nothing broke out
  });

  it('keeps user CSS inside its style element', () => {
    const doc = parse(build({ css: 'a{}</style><script id="evil">1</script>' }));
    expect(doc.getElementById('evil')).toBeNull();
    expect(doc.getElementById('deck-user-css')?.textContent).toContain('a{}');
  });

  it('refuses a runtime that would close its script element', () => {
    expect(() => build({}, { runtime: 'x</script><script>alert(1)' })).toThrow(/closing script tag/);
    expect(() => build({}, { runtime: 'x</SCRIPT >' })).toThrow(/closing script tag/);
  });

  it('only writes well-formed theme variables', () => {
    const html = buildDocument({
      def: { html: '', css: '', js: '' },
      runtime: '',
      themeVars: { '--deck-color-ok': '#fff', 'x;}</style><b>': '1', '--deck-color-bad': 'red;}</style><script id="evil">1</script>', '--deck-font-ok': 'Georgia, serif' },
    });
    const doc = parse(html);
    expect(doc.getElementById('evil')).toBeNull();
    const base = doc.getElementById('deck-base')!.textContent!;
    expect(base).toContain('--deck-color-ok:#fff;');
    expect(base).toContain('--deck-font-ok:Georgia, serif;');
    expect(base).not.toContain('bad');
  });

  it('widens the CSP only for the origins it is given', () => {
    expect(build().includes("connect-src 'none'")).toBe(true);
    expect(build({}, { networkOrigins: ['https://api.example.com'] })).toContain('connect-src https://api.example.com');
  });

  it('never mentions a way to load a script from outside the document', () => {
    const html = build();
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<(iframe|link|base|object|embed)\b/i);
  });
});
