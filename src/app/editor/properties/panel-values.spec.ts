import { createElement, ELEMENT_SCHEMAS, ELEMENT_TYPES, type Element } from '../../core/model';
import { BASE_FIELDS, fieldsOf, sectionsOf, typeFields } from './field-defs';
import { toHex } from './color-control';
import { changesFrom, numberProblem, valuesOf } from './panel-values';

const text = (extra: Partial<Parameters<typeof createElement<'text'>>[1]> = {}) => createElement('text', { x: 10, y: 20, w: 300, h: 100, text: 'Hi', ...extra });

describe('field definitions', () => {
  it('cover every editable field of every element type, straight from the schema', () => {
    const skipped = new Set(['asset', 'component', 'table', 'props', 'rich']);
    for (const type of ELEMENT_TYPES) {
      const expected = Object.entries(ELEMENT_SCHEMAS[type].fields).filter(([, spec]) => !skipped.has(spec.kind)).map(([key]) => key);
      expect(typeFields(type).map((f) => f.key), type).toEqual(expected);
    }
  });

  it('give every field a label, a known control and a section', () => {
    for (const type of ELEMENT_TYPES) {
      for (const f of fieldsOf(createElement(type))) {
        expect(f.label, `${type}.${f.key}`).toMatch(/\S/);
        expect(['number', 'text', 'textarea', 'checkbox', 'select', 'font', 'color', 'fill']).toContain(f.control);
        expect(['geometry', 'content', 'text', 'appearance', 'arrange']).toContain(f.section);
        if (f.control === 'select') expect(f.options?.length).toBeGreaterThan(0);
      }
    }
  });

  it('humanize labels that have no entry of their own', () => {
    expect(typeFields('image').find((f) => f.key === 'fit')?.label).toBe('Fit');
    expect(typeFields('video').map((f) => f.label)).toEqual(['Autoplay', 'Loop']);
  });

  it('keep numbers within what the document validator accepts', () => {
    for (const f of BASE_FIELDS.filter((f) => f.control === 'number')) {
      expect(f.max, f.key).toBeLessThanOrEqual(1_000_000);
    }
    expect(typeFields('text').find((f) => f.key === 'fontSize')).toMatchObject({ min: 0, max: 1_000_000 });
  });

  it('group fields into non-empty sections in display order', () => {
    expect(sectionsOf(fieldsOf(text())).map((s) => s.id)).toEqual(['geometry', 'text', 'arrange']);
    expect(sectionsOf([])).toEqual([]);
  });
});

describe('valuesOf / changesFrom', () => {
  const fields = fieldsOf(text());

  it('round-trips: a form filled from an element asks for no change', () => {
    for (const type of ELEMENT_TYPES) {
      const e = createElement(type);
      expect(changesFrom(valuesOf(e, fieldsOf(e)), e, fieldsOf(e)), type).toEqual({});
    }
  });

  it('maps absent optional values to neutral form values', () => {
    const v = valuesOf(text(), fields);
    expect(v.numbers['step']).toBe(0);
    expect(v.texts['font']).toBe('');
    expect(v.flags['locked']).toBe(false);
    expect(v.numbers['x']).toBe(10);
    expect(v.texts['text']).toBe('Hi');
  });

  it('reports only what differs', () => {
    const e = text({ font: 'heading' });
    const v = valuesOf(e, fields);
    v.numbers['w'] = 500;
    v.texts['align'] = 'right';
    v.flags['hidden'] = true;
    expect(changesFrom(v, e, fields)).toEqual({ w: 500, align: 'right', hidden: true });
  });

  it('turns an emptied optional text into a removal, but keeps a required one as typed', () => {
    const e = text({ font: 'heading' });
    const v = valuesOf(e, fields);
    v.texts['font'] = '';
    v.texts['text'] = '';
    expect(changesFrom(v, e, fields)).toEqual({ font: undefined, text: '' });
  });

  it('does not write an optional number or flag that is merely at its neutral value', () => {
    const e = text();
    const v = valuesOf(e, fields);
    v.numbers['step'] = 0;
    v.flags['locked'] = false;
    expect(changesFrom(v, e, fields)).toEqual({});
  });

  it('skips fields it is told to skip, and numbers that are not finite', () => {
    const e = text();
    const v = valuesOf(e, fields);
    v.numbers['x'] = 99;
    v.numbers['y'] = Number.NaN;
    v.numbers['w'] = Number.POSITIVE_INFINITY;
    v.texts['text'] = 'new';
    expect(changesFrom(v, e, fields, new Set(['x']))).toEqual({ text: 'new' });
  });

  it('ignores values of the wrong type', () => {
    const e = text();
    const v = valuesOf(e, fields) as unknown as { numbers: Record<string, unknown>; texts: Record<string, unknown>; flags: Record<string, unknown> };
    v.numbers['x'] = '5';
    v.texts['text'] = 7;
    v.flags['hidden'] = 'yes';
    expect(changesFrom(v as never, e, fields)).toEqual({});
  });

  it('never proposes changes to id or type', () => {
    const e = text();
    const v = valuesOf(e, fields);
    v.texts['id'] = 'el_other';
    v.texts['type'] = 'shape';
    expect(changesFrom(v, e, fields)).toEqual({});
  });

  it('leaves colours and fills to their own controls', () => {
    const shape = createElement('shape');
    const f = fieldsOf(shape);
    const v = valuesOf(shape, f);
    expect(Object.keys(v.texts).sort()).toEqual(['shape']);
    expect(changesFrom(v, shape, f)).toEqual({});
  });

  it('copes with an element that lacks a field the schema lists', () => {
    const broken = { ...text() } as Record<string, unknown>;
    delete broken['fontSize'];
    const v = valuesOf(broken as unknown as Element, fields);
    expect(v.numbers['fontSize']).toBe(0);
  });
});

describe('numberProblem', () => {
  const f = { label: 'Width', min: 0, max: 100, integer: false };
  it.each([
    [5, undefined],
    [0, undefined],
    [100, undefined],
    [-1, 'Width must be at least 0'],
    [101, 'Width must be at most 100'],
    [Number.NaN, 'Width must be a number'],
    [Number.POSITIVE_INFINITY, 'Width must be a number'],
  ])('%s → %s', (value, message) => {
    expect(numberProblem(value, f)).toBe(message);
  });

  it('checks whole numbers before bounds, and accepts unbounded fields', () => {
    expect(numberProblem(1.5, { label: 'Step', integer: true, min: 0 })).toBe('Step must be a whole number');
    expect(numberProblem(-1e9, { label: 'X' })).toBeUndefined();
    expect(numberProblem('3' as unknown as number, f)).toBe('Width must be a number');
  });
});

describe('toHex', () => {
  it.each([
    ['#ABCDEF', '#abcdef'],
    ['#abc', '#aabbcc'],
    ['red', '#000000'],
    ['rgb(1,2,3)', '#000000'],
    [{ token: 'accent' }, '#000000'],
    [undefined, '#000000'],
    ['#12345', '#000000'],
  ])('%j → %s', (input, expected) => {
    expect(toHex(input)).toBe(expected);
  });
});
