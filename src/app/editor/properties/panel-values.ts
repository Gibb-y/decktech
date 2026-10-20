import type { Element } from '../../core/model';
import type { FieldDef } from './field-defs';

/** The values behind the panel's form controls, grouped by what kind of control edits them. */
export interface PanelValues {
  numbers: Record<string, number>;
  texts: Record<string, string>;
  flags: Record<string, boolean>;
}

export const EMPTY_VALUES: PanelValues = { numbers: {}, texts: {}, flags: {} };

const read = (element: Element, key: string): unknown => (element as unknown as Record<string, unknown>)[key];

/**
 * Form values for an element. A form control cannot hold "absent", so an optional number is 0, an
 * optional text is empty and an optional flag is false; `changesFrom` maps these back.
 */
export function valuesOf(element: Element, fields: readonly FieldDef[]): PanelValues {
  const values: PanelValues = { numbers: {}, texts: {}, flags: {} };
  for (const f of fields) {
    const value = read(element, f.key);
    switch (f.control) {
      case 'number':
        values.numbers[f.key] = typeof value === 'number' ? value : 0;
        break;
      case 'text':
      case 'textarea':
      case 'select':
      case 'font':
        values.texts[f.key] = typeof value === 'string' ? value : '';
        break;
      case 'checkbox':
        values.flags[f.key] = value === true;
        break;
      case 'color':
      case 'fill':
        break; // edited by their own controls, not through the form
    }
  }
  return values;
}

/**
 * The `SetProps` changes that make `element` match `values`. Fields in `skip` (invalid ones) and
 * non-finite numbers are left alone, and values that equal what the element already has produce
 * nothing, so a form that was just filled from the element dispatches no command.
 */
export function changesFrom(values: PanelValues, element: Element, fields: readonly FieldDef[], skip: ReadonlySet<string> = new Set()): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const f of fields) {
    if (skip.has(f.key)) continue;
    const current = read(element, f.key);
    switch (f.control) {
      case 'number': {
        const value = values.numbers[f.key];
        if (typeof value !== 'number' || !Number.isFinite(value)) break;
        if (value !== (typeof current === 'number' ? current : 0)) changes[f.key] = value;
        break;
      }
      case 'text':
      case 'textarea':
      case 'select':
      case 'font': {
        const value = values.texts[f.key];
        if (typeof value !== 'string' || value === (typeof current === 'string' ? current : '')) break;
        changes[f.key] = value === '' && f.optional ? undefined : value;
        break;
      }
      case 'checkbox': {
        const value = values.flags[f.key];
        if (typeof value === 'boolean' && value !== (current === true)) changes[f.key] = value;
        break;
      }
      case 'color':
      case 'fill':
        break;
    }
  }
  return changes;
}

/** A message for a number outside what the field accepts, or `undefined` when it is fine. */
export function numberProblem(value: number, f: Pick<FieldDef, 'label' | 'min' | 'max' | 'integer'>): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${f.label} must be a number`;
  if (f.integer && !Number.isInteger(value)) return `${f.label} must be a whole number`;
  if (f.min !== undefined && value < f.min) return `${f.label} must be at least ${f.min}`;
  if (f.max !== undefined && value > f.max) return `${f.label} must be at most ${f.max}`;
  return undefined;
}
