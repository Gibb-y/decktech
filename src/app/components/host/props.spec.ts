import type { PropSpec } from '../../core/model';
import { resolveProps } from './props';

const schema: PropSpec[] = [
  { key: 'label', type: 'string', label: 'Label', default: 'Add' },
  { key: 'count', type: 'number', label: 'Count', default: 3, min: 0, max: 10 },
  { key: 'on', type: 'boolean', label: 'On', default: true },
  { key: 'tint', type: 'color', label: 'Tint', default: '#ff0000' },
  { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'a' },
];

describe('resolveProps', () => {
  it('uses the defaults for missing props', () => {
    expect(resolveProps({ propSchema: schema }, {})).toEqual({ label: 'Add', count: 3, on: true, tint: '#ff0000', mode: 'a' });
  });

  it('keeps stored values that fit the declared type', () => {
    expect(resolveProps({ propSchema: schema }, { label: 'x', count: 7, on: false, tint: '#00ff00', mode: 'b' })).toEqual({
      label: 'x',
      count: 7,
      on: false,
      tint: '#00ff00',
      mode: 'b',
    });
  });

  it.each([
    ['a string where a number is declared', { count: '7' }, 'count', 3],
    ['a number out of range', { count: 11 }, 'count', 3],
    ['below the minimum', { count: -1 }, 'count', 3],
    ['NaN', { count: Number.NaN }, 'count', 3],
    ['Infinity', { count: Number.POSITIVE_INFINITY }, 'count', 3],
    ['a number for a string', { label: 5 }, 'label', 'Add'],
    ['a string for a boolean', { on: 'false' }, 'on', true],
    ['an object for a colour', { tint: { token: 'x' } }, 'tint', '#ff0000'],
    ['an option that is not offered', { mode: 'c' }, 'mode', 'a'],
    ['an inherited name as a select value', { mode: 'toString' }, 'mode', 'a'],
  ])('falls back to the default for %s', (_name, stored, key, expected) => {
    expect(resolveProps({ propSchema: schema }, stored)[key]).toBe(expected);
  });

  it('drops undeclared props, including hostile keys', () => {
    const stored = JSON.parse('{"label":"x","extra":1,"__proto__":{"polluted":true},"constructor":2}') as Record<string, unknown>;
    const props = resolveProps({ propSchema: schema }, stored);
    expect(Object.keys(props)).toEqual(['label', 'count', 'on', 'tint', 'mode']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('does not read inherited properties as stored values', () => {
    const props = resolveProps({ propSchema: [{ key: 'toString', type: 'string', label: 'x', default: 'd' }] }, {});
    expect(props['toString']).toBe('d');
  });

  it('returns copies, so a component cannot change the defaults', () => {
    const spec: PropSpec[] = [{ key: 'obj', type: 'string', label: 'x', default: { a: 1 } }];
    const first = resolveProps({ propSchema: spec }, {});
    (first['obj'] as { a: number }).a = 2;
    expect((resolveProps({ propSchema: spec }, {})['obj'] as { a: number }).a).toBe(1);
  });
});
