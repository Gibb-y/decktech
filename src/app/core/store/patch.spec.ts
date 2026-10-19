import { applyPatch, diff, PatchError } from './patch';

describe('patch', () => {
  it('diff then apply reproduces the target, and the inverse restores the source', () => {
    const a = { n: 1, list: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }], opt: 'x', nested: { k: [1, 2, 3] } };
    const b = { n: 2, list: [{ id: 'a', v: 1 }, { id: 'c', v: 3 }, { id: 'd', v: 4 }], nested: { k: [1], extra: true } };
    expect(applyPatch(a, diff(a, b))).toEqual(b);
    expect(applyPatch(b, diff(b, a))).toEqual(a);
  });

  it('produces no operations for referentially equal subtrees', () => {
    const shared = { big: [1, 2, 3] };
    expect(diff({ shared, n: 1 }, { shared, n: 2 })).toEqual([{ op: 'replace', path: '/n', value: 2 }]);
  });

  it('does not mutate its input and keeps untouched branches by identity', () => {
    const doc = Object.freeze({ a: Object.freeze({ x: 1 }), b: Object.freeze({ y: 2 }) });
    const next = applyPatch(doc, [{ op: 'replace', path: '/a/x', value: 5 }]);
    expect(next.a.x).toBe(5);
    expect(doc.a.x).toBe(1);
    expect(next.b).toBe(doc.b);
  });

  it('treats undefined properties as absent', () => {
    expect(diff({ a: 1, b: undefined }, { a: 1 })).toEqual([]);
    expect(applyPatch({ a: 1 }, diff({ a: 1 }, { a: 1, b: undefined }))).toEqual({ a: 1 });
  });

  it('escapes keys containing "/" and "~"', () => {
    const a = { 'a/b': { '~': 1 } };
    const b = { 'a/b': { '~': 2 } };
    expect(diff(a, b)[0].path).toBe('/a~1b/~0');
    expect(applyPatch(a, diff(a, b))).toEqual(b);
  });

  it('replaces the root', () => {
    expect(applyPatch({ a: 1 }, [{ op: 'replace', path: '', value: 7 }])).toBe(7);
  });

  it.each([
    ['missing key', { op: 'replace', path: '/nope', value: 1 }],
    ['missing parent', { op: 'add', path: '/nope/child', value: 1 }],
    ['remove of missing key', { op: 'remove', path: '/nope' }],
    ['array index out of range', { op: 'replace', path: '/list/5', value: 1 }],
    ['non-numeric array index', { op: 'replace', path: '/list/x', value: 1 }],
    ['path without leading slash', { op: 'replace', path: 'list', value: 1 }],
    ['removing the root', { op: 'remove', path: '' }],
  ] as const)('rejects %s', (_, op) => {
    expect(() => applyPatch({ list: [1] }, [op])).toThrow(PatchError);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('refuses to write through "%s"', (key) => {
    expect(() => applyPatch({}, [{ op: 'add', path: `/${key}`, value: 1 }])).toThrow(/Forbidden key/);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
