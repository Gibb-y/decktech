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

  describe('arrays of identified objects', () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, v: i }));

    it('removing from the middle is one operation, not a rewrite of the tail', () => {
      const a = items(50);
      const b = a.filter((_, i) => i !== 10);
      expect(diff(a, b)).toEqual([{ op: 'remove', path: '/10' }]);
      expect(diff(b, a)).toEqual([{ op: 'add', path: '/10', value: a[10] }]);
    });

    it('inserting, removing and editing at once round-trips', () => {
      const a = items(6);
      const b = [a[0], { id: 'new', v: 99 }, { ...a[2], v: -2 }, a[4], a[5], { id: 'tail', v: 1 }];
      expect(applyPatch(a, diff(a, b))).toEqual(b);
      expect(applyPatch(b, diff(b, a))).toEqual(a);
    });

    it('reorders round-trip and keep the identity of the target items', () => {
      const a = items(5);
      const b = [a[3], a[1], a[0], a[4], a[2]];
      const next = applyPatch(a, diff(a, b));
      expect(next).toEqual(b);
      next.forEach((item, i) => expect(item).toBe(b[i]));
    });

    it('random edits round-trip in both directions', () => {
      let seed = 12345;
      const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
      for (let round = 0; round < 200; round++) {
        const a = items(1 + rnd(8));
        const b = a.map((x) => ({ ...x }));
        for (let k = rnd(5); k > 0; k--) {
          const op = rnd(4);
          if (op === 0 && b.length) b.splice(rnd(b.length), 1);
          else if (op === 1) b.splice(rnd(b.length + 1), 0, { id: `n${round}_${k}`, v: rnd(9) });
          else if (op === 2 && b.length > 1) b.splice(rnd(b.length), 0, ...b.splice(rnd(b.length), 1));
          else if (b.length) {
            const at = rnd(b.length);
            b[at] = { ...b[at], v: rnd(100) };
          }
        }
        expect(applyPatch(a, diff(a, b))).toEqual(b);
        expect(applyPatch(b, diff(b, a))).toEqual(a);
      }
    });

    it('falls back to index comparison when ids repeat', () => {
      const a = [{ id: 'x', v: 1 }, { id: 'x', v: 2 }];
      const b = [{ id: 'x', v: 1 }, { id: 'x', v: 3 }];
      expect(applyPatch(a, diff(a, b))).toEqual(b);
    });
  });

  describe('awkward keys', () => {
    it('treats inherited names such as toString as absent', () => {
      const a = { props: {} as Record<string, unknown> };
      const b = { props: { toString: 1, valueOf: 2, hasOwnProperty: 3 } };
      expect(applyPatch(a, diff(a, b))).toEqual(b);
      expect(applyPatch(b, diff(b, a))).toEqual(a);
    });

    it.each(['constructor', 'prototype', '__proto__'])('replaces objects holding "%s" as a whole instead of traversing it', (key) => {
      const a = { props: JSON.parse(`{"${key}": 1, "n": 1}`) as Record<string, unknown> };
      const b = { props: JSON.parse(`{"${key}": 2, "n": 1}`) as Record<string, unknown> };
      expect(diff(a, b)).toEqual([{ op: 'replace', path: '/props', value: b.props }]);
      expect(applyPatch(a, diff(a, b))).toEqual(b);
      expect(applyPatch(b, diff(b, a))).toEqual(a);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });
  });
});
