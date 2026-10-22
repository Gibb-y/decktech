import { createDeck, createElement, createSlide, type CodeEl, type ComponentDef, type Deck } from '../../core/model';
import { BUNDLED_LIBRARIES, analyzeDeck, flagsOf } from './analysis';
import { foldUnchanged, hasChanges, lineDiff } from './diff';
import { MAX_FORMAT_LENGTH, formatForViewing } from './format';

const def = (over: Partial<ComponentDef> = {}): ComponentDef => ({ id: 'cmp_a', name: 'A', html: '<p>hi</p>', css: '', js: 'deck.ready(() => {})', propSchema: [], permissions: [], files: [], libs: [], ...over });

const kinds = (d: ComponentDef) => flagsOf(d).map((f) => f.kind);

describe('flagsOf', () => {
  it('has nothing to say about plain code', () => {
    expect(flagsOf(def())).toEqual([]);
  });

  it.each<[string, Partial<ComponentDef>, string]>([
    ['the network permission', { permissions: ['network'] }, 'permission'],
    ['the storage permission', { permissions: ['storage'] }, 'permission'],
    ['eval', { js: 'eval(code)' }, 'eval'],
    ['new Function', { js: 'const f = new Function("return 1")' }, 'eval'],
    ['Function()', { js: 'Function("return 1")()' }, 'eval'],
    ['a dynamic import', { js: 'const m = await import("x")' }, 'dynamic-import'],
    ['fetch', { js: 'fetch("/a")' }, 'network-api'],
    ['a WebSocket', { js: 'new WebSocket(u)' }, 'network-api'],
    ['an address in the HTML', { html: '<script src="https://cdn.example.com/x.js"></script>' }, 'external-url'],
    ['an address in the CSS', { css: '@import url(https://fonts.example.org/f.css)' }, 'external-url'],
    ['a protocol-relative address in the JS', { js: 'load("//cdn.example.com/lib.js")' }, 'external-url'],
    ['a very long line', { js: 'a'.repeat(600) }, 'minified'],
    ['a long file on two lines', { js: `${'x=1;'.repeat(400)}\ny=2` }, 'minified'],
  ])('flags %s', (_name, over, kind) => {
    expect(kinds(def(over))).toContain(kind);
  });

  it('does not flag a method called evaluate, a property named Function, or a comment slash', () => {
    expect(kinds(def({ js: 'obj.evaluate(1); obj.Function(2); // done\nconst x = a / b;' }))).toEqual([]);
  });

  it('names the permission, lists addresses and caps them', () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://h${i}.example.com/a`).join(' ');
    const flags = flagsOf(def({ permissions: ['network'], js: `// ${urls}` }));
    expect(flags[0].text).toMatch(/network permission/);
    const external = flags.find((f) => f.kind === 'external-url')!;
    expect(external.text).toContain('https://h0.example.com/a');
    expect(external.text).toMatch(/…$/);
    expect(external.text).not.toContain('https://h7.example.com');
  });

  it('is fast on a large minified file', () => {
    const start = performance.now();
    flagsOf(def({ js: 'a=1;'.repeat(500_000) }));
    expect(performance.now() - start).toBeLessThan(5000);
  });
});

describe('analyzeDeck', () => {
  const LIB = 'a'.repeat(64);
  const FILE = 'b'.repeat(64);

  function deck(): Deck {
    const d = createDeck('Talk');
    d.assets[LIB] = { blobKey: LIB, hash: LIB, mime: 'text/javascript', size: 1234 };
    d.assets[FILE] = { blobKey: FILE, hash: FILE, mime: 'image/png', size: 55 };
    d.components.push(def({ id: 'cmp_a', name: 'Chart', libs: [LIB], files: [FILE], permissions: ['network'] }), def({ id: 'cmp_unused', name: 'Unused' }));
    d.slides = [createSlide('l'), createSlide('l'), createSlide('l')];
    d.slides[0].elements.push(createElement('code', { componentId: 'cmp_a' }) as CodeEl);
    d.slides[2].elements.push(createElement('code', { componentId: 'cmp_a' }) as CodeEl, createElement('code', { componentId: 'cmp_a' }) as CodeEl);
    return d;
  }

  it('lists every component with the slides that use it, once each and in order', () => {
    const report = analyzeDeck(deck());
    expect(report.components.map((c) => [c.name, c.slides])).toEqual([['Chart', [1, 3]], ['Unused', []]]);
  });

  it('reports permissions, size, libraries and files with their sizes', () => {
    const [chart] = analyzeDeck(deck()).components;
    expect(chart.permissions).toEqual(['network']);
    expect(chart.size).toBe('<p>hi</p>'.length + 'deck.ready(() => {})'.length);
    expect(chart.libs).toEqual([{ id: LIB, size: 1234, mime: 'text/javascript', known: false }]);
    expect(chart.files).toEqual([{ id: FILE, size: 55, mime: 'image/png' }]);
    expect(chart.flags.map((f) => f.kind)).toEqual(['permission']);
  });

  it('marks a library as known when a trusted deck used the same file, or the app bundles it', () => {
    expect(analyzeDeck(deck(), new Set([LIB])).components[0].libs[0].known).toBe(true);
    expect(BUNDLED_LIBRARIES.has(LIB)).toBe(false);
  });

  it('copes with a library the deck has no asset entry for', () => {
    const d = deck();
    delete d.assets[LIB];
    expect(analyzeDeck(d).components[0].libs[0]).toMatchObject({ size: 0, mime: 'unknown', known: false });
  });

  it.each(['constructor', 'toString', '__proto__'])('does not find an inherited property for the library id "%s"', (id) => {
    const d = deck();
    d.components[0].libs = [id];
    expect(analyzeDeck(d).components[0].libs[0]).toEqual({ id, size: 0, mime: 'unknown', known: false });
  });

  it('reads the deck and nothing else', () => {
    const d = structuredClone(deck());
    const frozen = JSON.stringify(d);
    analyzeDeck(d);
    expect(JSON.stringify(d)).toBe(frozen);
  });
});

describe('lineDiff', () => {
  const view = (a: string, b: string) => lineDiff(a, b).map((l) => `${l.kind === 'same' ? ' ' : l.kind === 'add' ? '+' : '-'}${l.text}`);

  it('shows an unchanged text as unchanged', () => {
    expect(view('a\nb', 'a\nb')).toEqual([' a', ' b']);
    expect(hasChanges(lineDiff('a\nb', 'a\nb'))).toBe(false);
  });

  it('shows a changed line as removed then added, and keeps the lines around it', () => {
    expect(view('a\nb\nc', 'a\nB\nc')).toEqual([' a', '-b', '+B', ' c']);
  });

  it('shows inserts and deletes', () => {
    expect(view('a\nc', 'a\nb\nc')).toEqual([' a', '+b', ' c']);
    expect(view('a\nb\nc', 'a\nc')).toEqual([' a', '-b', ' c']);
  });

  it('handles an empty side', () => {
    expect(view('', 'x\ny')).toEqual(['+x', '+y']);
    expect(view('x\ny', '')).toEqual(['-x', '-y']);
    expect(view('', '')).toEqual([]);
  });

  it('finds the common lines in a scrambled middle', () => {
    expect(view('1\n2\n3\n4\n5', '1\n3\n2\n4\n5').filter((l) => l[0] !== ' ')).toHaveLength(2);
  });

  it('reapplies: the "same" and "add" lines are the new text, the "same" and "del" lines the old', () => {
    const a = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const b = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? `changed ${i}` : `line ${i}`)).concat(['tail']).join('\n');
    const lines = lineDiff(a, b);
    expect(lines.filter((l) => l.kind !== 'del').map((l) => l.text).join('\n')).toBe(b);
    expect(lines.filter((l) => l.kind !== 'add').map((l) => l.text).join('\n')).toBe(a);
  });

  it('stays bounded for a huge changed middle: coarser, still correct', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    const start = performance.now();
    const lines = lineDiff(a, b);
    expect(performance.now() - start).toBeLessThan(4000);
    expect(lines.filter((l) => l.kind === 'del')).toHaveLength(3000);
    expect(lines.filter((l) => l.kind === 'add')).toHaveLength(3000);
  });

  it('diffs one minified line against another as a replacement', () => {
    expect(view('a=1;b=2;', 'a=1;b=3;')).toEqual(['-a=1;b=2;', '+a=1;b=3;']);
  });
});

describe('foldUnchanged', () => {
  const numbers = Array.from({ length: 30 }, (_, i) => `l${i}`);

  it('keeps the context around a change and folds the rest', () => {
    const changed = [...numbers];
    changed[15] = 'X';
    const folded = foldUnchanged(lineDiff(numbers.join('\n'), changed.join('\n')), 2);
    expect(folded.map((l) => (l.kind === 'fold' ? `fold ${l.count}` : l.kind))).toEqual(['fold 13', 'same', 'same', 'del', 'add', 'same', 'same', 'fold 12']);
  });

  it('folds an unchanged text into one note and shows a changed short text whole', () => {
    expect(foldUnchanged(lineDiff('a\nb', 'a\nb'))).toEqual([{ kind: 'fold', count: 2 }]);
    expect(foldUnchanged(lineDiff('a\nb', 'a\nc')).some((l) => l.kind === 'fold')).toBe(false);
  });
});

describe('formatForViewing', () => {
  it('puts a minified script on lines, indented by its blocks', () => {
    const out = formatForViewing('function f(a){if(a){return 1}else{return 2}}for(let i=0;i<3;i++){f(i)}', 'js');
    expect(out).toBe(['function f(a){', '  if(a){', '    return 1', '  }else{', '    return 2', '  }', '}', 'for(let i=0;i<3;i++){', '  f(i)', '}', ''].join('\n'));
  });

  it('leaves strings, comments and template text alone', () => {
    const out = formatForViewing('const s="a;b{c}";/* x;y{ */const t=`;{`;// z;w\nconst u=1;', 'js');
    expect(out).toContain('"a;b{c}"');
    expect(out).toContain('/* x;y{ */');
    expect(out).toContain('`;{`');
    expect(out).toContain('// z;w');
  });

  it('breaks CSS after each declaration and rule', () => {
    expect(formatForViewing('a{color:red;margin:0}b{x:url(data:image/png;base64,AA)}', 'css')).toBe(['a{', '  color:red;', '  margin:0', '}', 'b{', '  x:url(data:image/png;base64,AA)', '}', ''].join('\n'));
  });

  it('breaks HTML between tags', () => {
    expect(formatForViewing('<div><p>x</p></div>', 'html')).toBe('<div>\n<p>x</p>\n</div>');
  });

  it('survives unbalanced input and returns text as is for other kinds and huge input', () => {
    expect(() => formatForViewing('}}}{{{(((', 'js')).not.toThrow();
    expect(() => formatForViewing('"unterminated', 'js')).not.toThrow();
    expect(formatForViewing('a;b', 'text')).toBe('a;b');
    const huge = 'a;'.repeat(MAX_FORMAT_LENGTH);
    expect(formatForViewing(huge, 'js')).toBe(huge);
  });

  it('is a pure view: formatting twice gives the same copy', () => {
    const once = formatForViewing('a{b:c;d:e}', 'css');
    expect(formatForViewing(once, 'css')).toBe(once);
  });
});

describe('flagsOf, more addresses', () => {
  it.each(['ws://192.168.0.5/x', 'wss://sock.example.com/x'])('flags %s', (url) => {
    expect(flagsOf(def({ js: `new WebSocket("${url}")` })).map((f) => f.kind)).toContain('external-url');
  });
});
