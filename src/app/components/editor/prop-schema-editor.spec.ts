import { TestBed } from '@angular/core/testing';
import { validateComponent, type ComponentDef, type PropSpec } from '../../core/model';
import { PropSchemaEditor, changeSpec, formatOptions, newSpec, parseOptions } from './prop-schema-editor';

const wrap = (propSchema: PropSpec[]): ComponentDef => ({ id: 'cp_1', name: 'x', html: '', css: '', js: '', propSchema, permissions: [], files: [], libs: [] });

describe('newSpec', () => {
  it.each(['string', 'number', 'boolean', 'color', 'asset', 'select'] as const)('makes a valid %s spec', (type) => {
    expect(validateComponent(wrap([newSpec(type, 'k', 'K')]), []).ok).toBe(true);
  });
});

describe('options text', () => {
  it('parses "value: label" lines, dropping blanks, and round-trips', () => {
    const options = parseOptions('a: Alpha\n\n  b  \nc:   \nd: with: colon');
    expect(options).toEqual([
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'b' },
      { value: 'c', label: 'c' },
      { value: 'd', label: 'with: colon' },
    ]);
    expect(parseOptions(formatOptions(options))).toEqual(options);
  });
});

describe('changeSpec', () => {
  it('replaces a spec by one of the new type, keeping key and label and a default that fits', () => {
    const next = changeSpec({ key: 'k', type: 'number', label: 'K', default: 5, min: 1, max: 9 }, { type: 'select' });
    expect(next).toEqual(newSpec('select', 'k', 'K'));
    expect(validateComponent(wrap([next]), []).ok).toBe(true);
  });

  it('drops an emptied bound and keeps the default of a select inside its options', () => {
    expect(changeSpec({ key: 'k', type: 'number', label: 'K', default: 5, min: 1 }, { min: undefined })).not.toHaveProperty('min');
    const select = newSpec('select', 's', 'S');
    const next = changeSpec(select, { options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] });
    expect(next).toMatchObject({ default: 'x' });
    expect(changeSpec(select, { options: [] })).toMatchObject({ default: '' });
  });

  it('does not change its input', () => {
    const spec = Object.freeze(newSpec('string', 'k', 'K'));
    expect(changeSpec(spec, { label: 'New' })).toMatchObject({ label: 'New' });
    expect(spec.label).toBe('K');
  });
});

describe('PropSchemaEditor', () => {
  function render(specs: PropSpec[]) {
    const fixture = TestBed.createComponent(PropSchemaEditor);
    fixture.componentRef.setInput('specs', specs);
    const changed: PropSpec[][] = [];
    fixture.componentInstance.changed.subscribe((c) => changed.push(c));
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement, changed };
  }

  it('adds a property with a key that is not taken, and removes one by its label', () => {
    const { root, changed } = render([newSpec('string', 'prop2', 'Two')]);
    root.querySelector<HTMLButtonElement>(':scope > button')!.click();
    expect(changed[0].map((s) => s.key)).toEqual(['prop2', 'prop3']);
    root.querySelector<HTMLButtonElement>('button[aria-label="Remove property Two"]')!.click();
    expect(changed[1]).toEqual([]);
  });

  it('reports edits without touching the list it was given', () => {
    const specs = [newSpec('number', 'n', 'N')];
    const { root, changed } = render(specs);
    const [key] = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="text"]'));
    key.value = 'renamed';
    key.dispatchEvent(new Event('input'));
    expect(changed[0][0]).toMatchObject({ key: 'renamed', type: 'number' });
    expect(specs[0].key).toBe('n');
  });
});
