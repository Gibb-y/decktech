import { Component, input, output } from '@angular/core';
import type { PropSpec } from '../../core/model';

type PropType = PropSpec['type'];

export const PROP_TYPES: readonly { value: PropType; label: string }[] = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / no' },
  { value: 'color', label: 'Colour' },
  { value: 'asset', label: 'Picture or file' },
  { value: 'select', label: 'Choice' },
];

/** A new spec of `type` with a default that fits it. */
export function newSpec(type: PropType, key: string, label: string): PropSpec {
  switch (type) {
    case 'select':
      return { key, type, label, options: [{ value: 'a', label: 'A' }], default: 'a' };
    case 'number':
      return { key, type, label, default: 0 };
    case 'boolean':
      return { key, type, label, default: false };
    case 'color':
      return { key, type, label, default: '#336699' }; // token-check-ignore
    default:
      return { key, type, label, default: '' };
  }
}

/** "value: label" per line, the label optional. */
export function parseOptions(text: string): { value: string; label: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const at = line.indexOf(':');
      const value = (at < 0 ? line : line.slice(0, at)).trim();
      return { value, label: at < 0 ? value : line.slice(at + 1).trim() || value };
    });
}

export const formatOptions = (options: readonly { value: string; label: string }[]): string =>
  options.map((o) => (o.label === o.value ? o.value : `${o.value}: ${o.label}`)).join('\n');

/** The spec with `change` applied; the type-specific fields are dropped when the type changes. */
export function changeSpec(spec: PropSpec, change: Partial<Record<'key' | 'label' | 'type' | 'default' | 'min' | 'max' | 'options', unknown>>): PropSpec {
  if (change.type !== undefined && change.type !== spec.type) return newSpec(change.type as PropType, spec.key, spec.label);
  const next: Record<string, unknown> = { ...spec, ...change };
  for (const bound of ['min', 'max']) if (next[bound] === undefined) delete next[bound];
  if (spec.type === 'select' && change.options !== undefined) {
    const options = change.options as { value: string }[];
    if (!options.some((o) => o.value === next['default'])) next['default'] = options[0]?.value ?? '';
  }
  return next as unknown as PropSpec;
}

const numberOrUndefined = (text: string): number | undefined => (text.trim() === '' || !Number.isFinite(Number(text)) ? undefined : Number(text));

/**
 * Edits a component's property schema (`PropSpec[]`): one fieldset per property with its key, label,
 * type, default and, by type, range or choices. It only reports the new list; the dialog validates
 * it with the same rules as the deck (`validateComponent`) and shows the problems next to it.
 */
@Component({
  selector: 'app-prop-schema-editor',
  template: `
    <p class="hint">Properties appear as a form in the properties panel when the component is selected, and reach the code as <code>props</code> and <code>deck.onProps</code>.</p>
    @for (spec of specs(); track $index; let i = $index) {
      <fieldset>
        <legend>Property {{ i + 1 }}{{ spec.label ? ': ' + spec.label : '' }}</legend>
        <div class="grid">
          <label>Key <input class="input" type="text" [value]="spec.key" (input)="edit(i, { key: text($event) })" spellcheck="false" /></label>
          <label>Label <input class="input" type="text" [value]="spec.label" (input)="edit(i, { label: text($event) })" /></label>
          <label>
            Type
            <select class="input" (change)="edit(i, { type: text($event) })">
              @for (t of types; track t.value) {
                <option [value]="t.value" [selected]="t.value === spec.type">{{ t.label }}</option>
              }
            </select>
          </label>
          @switch (spec.type) {
            @case ('number') {
              <label>Default <input class="input" type="number" [value]="spec.default" (change)="edit(i, { default: num($event) ?? 0 })" /></label>
              <label>Smallest <input class="input" type="number" [value]="spec.min ?? ''" (change)="edit(i, { min: num($event) })" /></label>
              <label>Largest <input class="input" type="number" [value]="spec.max ?? ''" (change)="edit(i, { max: num($event) })" /></label>
            }
            @case ('boolean') {
              <label class="check"><input type="checkbox" [checked]="spec.default === true" (change)="edit(i, { default: checked($event) })" /> On by default</label>
            }
            @case ('select') {
              <label class="wide">
                Choices (one per line, <code>value: label</code>)
                <textarea class="input" rows="3" [value]="optionsText(spec)" (change)="edit(i, { options: options($event) })"></textarea>
              </label>
              <label>
                Default
                <select class="input" (change)="edit(i, { default: text($event) })">
                  @for (o of optionsOf(spec); track o.value) {
                    <option [value]="o.value" [selected]="o.value === spec.default">{{ o.label }}</option>
                  }
                </select>
              </label>
            }
            @default {
              <label>Default <input class="input" type="text" [value]="stringDefault(spec)" (input)="edit(i, { default: text($event) })" /></label>
            }
          }
        </div>
        <button class="btn" type="button" (click)="remove(i)" [attr.aria-label]="'Remove property ' + (spec.label || spec.key || i + 1)">Remove</button>
      </fieldset>
    }
    <button class="btn" type="button" (click)="add()">Add property</button>
  `,
  styles: `
    fieldset {
      margin: 0 0 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.25rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }
    .wide {
      grid-column: 1 / -1;
    }
    label {
      display: grid;
      gap: 0.15rem;
      font-size: 0.9rem;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .hint {
      margin: 0 0 0.75rem;
      font-size: 0.9rem;
    }
  `,
})
export class PropSchemaEditor {
  readonly specs = input.required<readonly PropSpec[]>();
  /** Fires per edit. Number boxes and the choices box report on `change` (when the field is left), because their text is normalised and writing it back while typing would eat half-typed values such as "-" or "red:". */
  readonly changed = output<PropSpec[]>();
  protected readonly types = PROP_TYPES;

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected num(event: Event): number | undefined {
    return numberOrUndefined((event.target as HTMLInputElement).value);
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected options(event: Event): { value: string; label: string }[] {
    return parseOptions((event.target as HTMLTextAreaElement).value);
  }

  protected optionsOf(spec: PropSpec): readonly { value: string; label: string }[] {
    return spec.type === 'select' ? spec.options : [];
  }

  protected optionsText(spec: PropSpec): string {
    return spec.type === 'select' ? formatOptions(spec.options) : '';
  }

  protected stringDefault(spec: PropSpec): string {
    return typeof spec.default === 'string' ? spec.default : '';
  }

  protected edit(index: number, change: Parameters<typeof changeSpec>[1]): void {
    this.changed.emit(this.specs().map((spec, i) => (i === index ? changeSpec(spec, change) : spec)));
  }

  protected remove(index: number): void {
    this.changed.emit(this.specs().filter((_, i) => i !== index));
  }

  protected add(): void {
    const taken = new Set(this.specs().map((s) => s.key));
    let n = this.specs().length + 1;
    while (taken.has(`prop${n}`)) n++;
    this.changed.emit([...this.specs(), newSpec('string', `prop${n}`, `Property ${n}`)]);
  }
}
