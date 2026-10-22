import { Component, computed, effect, inject, input, linkedSignal, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { propValueProblem, resolveProps, type CodeEl, type PropSpec } from '../../core/model';
import { CommandError, DeckStore, DetachComponent, SetCodeProps, componentUses } from '../../core/store';
import { LiveAnnouncer } from '../../shared';
import { CodeTools } from '../code-tools';
import { EMPTY_VALUES, type PanelValues } from './panel-values';

/** The form values for the declared props of `spec`s, from what the component would currently get. */
function valuesOf(specs: readonly PropSpec[], props: Record<string, unknown>): PanelValues {
  const values: PanelValues = { numbers: {}, texts: {}, flags: {} };
  for (const spec of specs) {
    const value = props[spec.key];
    if (spec.type === 'number') values.numbers[spec.key] = typeof value === 'number' ? value : 0;
    else if (spec.type === 'boolean') values.flags[spec.key] = value === true;
    else values.texts[spec.key] = typeof value === 'string' ? value : '';
  }
  return values;
}

const read = (values: PanelValues, spec: PropSpec): unknown => (spec.type === 'number' ? values.numbers[spec.key] : spec.type === 'boolean' ? values.flags[spec.key] : values.texts[spec.key]);

/**
 * The properties panel's part for a code element (arc42 §5.4): which component it runs, how many
 * elements share it, "Edit code" and "Detach", and a form generated from the component's
 * `propSchema` (a Signal Form, like the rest of the panel). The form shows what the component
 * actually gets (stored value or default). A value that does not fit the schema is flagged and not
 * sent; the rest become one `SetCodeProps`, which checks them again, and the running frame gets
 * them with `props` messages, with no reload (6.2).
 */
@Component({
  selector: 'app-code-props',
  imports: [FormField],
  template: `
    @if (def(); as component) {
      <fieldset [disabled]="locked()">
        <legend>Code component</legend>
        <p class="name">{{ component.name }}</p>
        <p class="note">
          @if (uses() > 1) {
            Shared by {{ uses() }} elements. Editing the code changes all of them.
          } @else {
            Used only here.
          }
        </p>
        <div class="buttons">
          <button class="btn" type="button" (click)="editCode()" [attr.aria-disabled]="tools.available() ? null : 'true'">Edit code…</button>
          @if (uses() > 1) {
            <button class="btn" type="button" (click)="detach()">Detach (make unique)</button>
          }
        </div>
      </fieldset>
      @if (specs().length > 0) {
        <fieldset [disabled]="locked()">
          <legend>{{ component.name }} properties</legend>
          @for (spec of specs(); track spec.key; let i = $index) {
            <div class="field" [class.check]="spec.type === 'boolean'">
              @switch (spec.type) {
                @case ('number') {
                  <label [for]="'code-prop-' + i">{{ spec.label }}</label>
                  <input class="input" type="number" [id]="'code-prop-' + i" [formField]="form.numbers[spec.key]" [attr.aria-invalid]="problems()[spec.key] ? 'true' : null" [attr.aria-describedby]="problems()[spec.key] ? 'code-prop-error-' + i : null" />
                }
                @case ('boolean') {
                  <input type="checkbox" [id]="'code-prop-' + i" [formField]="form.flags[spec.key]" />
                  <label [for]="'code-prop-' + i">{{ spec.label }}</label>
                }
                @case ('select') {
                  <label [for]="'code-prop-' + i">{{ spec.label }}</label>
                  <select class="input" [id]="'code-prop-' + i" [formField]="form.texts[spec.key]">
                    @for (option of options(spec); track option.value) {
                      <option [value]="option.value">{{ option.label }}</option>
                    }
                  </select>
                }
                @case ('asset') {
                  <label [for]="'code-prop-' + i">{{ spec.label }}</label>
                  <select class="input" [id]="'code-prop-' + i" [formField]="form.texts[spec.key]">
                    <option value="">None</option>
                    @for (asset of assets(); track asset.id) {
                      <option [value]="asset.id">{{ asset.label }}</option>
                    }
                  </select>
                }
                @default {
                  <label [for]="'code-prop-' + i">{{ spec.label }}{{ spec.type === 'color' ? ' (a colour such as #336699)' : '' }}</label> <!-- token-check-ignore -->
                  <input class="input" type="text" [id]="'code-prop-' + i" [formField]="form.texts[spec.key]" [attr.aria-invalid]="problems()[spec.key] ? 'true' : null" [attr.aria-describedby]="problems()[spec.key] ? 'code-prop-error-' + i : null" />
                }
              }
              @if (problems()[spec.key]; as message) {
                <span class="error" role="alert" [id]="'code-prop-error-' + i">{{ message }}</span>
              }
            </div>
          }
        </fieldset>
      }
    } @else {
      <p class="note" role="alert">The component of this element is missing from the deck.</p>
    }
  `,
  styles: `
    fieldset {
      margin: 0 0 0.75rem;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.25rem;
    }
    legend {
      font-weight: 600;
    }
    .name {
      margin: 0;
      font-weight: 600;
    }
    .note {
      margin: 0.15rem 0 0.5rem;
      font-size: 0.875rem;
      color: var(--text-muted);
    }
    .buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
    }
    .field {
      display: grid;
      gap: 0.15rem;
      margin-bottom: 0.5rem;
    }
    .field.check {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    input,
    select,
    :is(input, select, button):focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 2px;
    }
    .error {
      color: var(--danger-ink);
      font-size: 0.875rem;
    }
  `,
})
export class CodeProps {
  readonly element = input.required<CodeEl>();

  protected readonly store = inject(DeckStore);
  protected readonly tools = inject(CodeTools);
  private readonly announcer = inject(LiveAnnouncer);

  protected readonly def = computed(() => this.store.deck().components.find((c) => c.id === this.element().componentId));
  protected readonly specs = computed(() => this.def()?.propSchema ?? []);
  protected readonly uses = computed(() => componentUses(this.store.deck(), this.element().componentId));
  protected readonly locked = computed(() => this.element().locked === true);
  protected readonly assets = computed(() =>
    Object.entries(this.store.deck().assets).map(([id, ref]) => ({ id, label: `${ref.mime} ${id.slice(0, 8)}` })),
  );

  /** What the component gets now: the stored value, or the default where it does not fit. */
  private readonly current = computed(() => {
    const def = this.def();
    return def ? resolveProps(def, this.element().props) : {};
  });

  protected readonly model = linkedSignal<PanelValues>(() => (this.def() ? valuesOf(this.specs(), this.current()) : EMPTY_VALUES));
  protected readonly form = form(this.model);

  protected readonly problems = computed(() => {
    const values = this.model();
    const found: Record<string, string> = {};
    for (const spec of this.specs()) {
      const problem = propValueProblem(spec, read(values, spec));
      if (problem) found[spec.key] = `Must be ${problem}`;
    }
    return found;
  });

  constructor() {
    effect(() => {
      const values = this.model();
      const element = this.element();
      if (!this.def() || element.locked) return;
      untracked(() => this.commit(values, element));
    });
  }

  protected options(spec: PropSpec): readonly { value: string; label: string }[] {
    return spec.type === 'select' ? spec.options : [];
  }

  private commit(values: PanelValues, element: CodeEl): void {
    const problems = this.problems();
    const current = this.current();
    const changes: Record<string, unknown> = {};
    for (const spec of this.specs()) {
      if (problems[spec.key]) continue;
      const value = read(values, spec);
      if (value !== current[spec.key]) changes[spec.key] = value;
    }
    const keys = Object.keys(changes);
    if (keys.length === 0) return;
    this.run(() => this.store.execute(new SetCodeProps(element.id, changes, { coalesceKey: `code-props:${element.id}:${keys.join(',')}` })));
  }

  protected editCode(): void {
    this.tools.edit(this.element().id);
  }

  protected detach(): void {
    if (this.run(() => this.store.execute(new DetachComponent(this.element().id)))) this.announcer.announce('This element now has its own copy of the component');
  }

  private run(change: () => void): boolean {
    try {
      change();
      return true;
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      this.announcer.announce(e.message);
      return false;
    }
  }
}
