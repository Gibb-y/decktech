import { Component, ElementRef, Injector, afterNextRender, computed, inject, output, signal } from '@angular/core';
import { LITERAL_COLOR, MAX_THEME_NAME, ID_PATTERN, AA_TEXT_CONTRAST, themeContrast, themeRefs, REQUIRED_COLOR_TOKENS, REQUIRED_FONT_KEYS, type Theme } from '../core/model';
import { DeckStore } from '../core/store';
import { FocusTrap } from '../shared';
import { ThemeActions } from './theme-actions';

type Group = 'colors' | 'fonts' | 'typeScale' | 'spacing';
interface Row {
  key: string;
  value: string;
}
type Rows = Record<Group, Row[]>;

interface GroupDef {
  id: Group;
  label: string;
  numeric: boolean;
  valueLabel: string;
}

const GROUPS: readonly GroupDef[] = [
  { id: 'colors', label: 'Colours', numeric: false, valueLabel: 'colour' },
  { id: 'fonts', label: 'Font stacks', numeric: false, valueLabel: 'font stack' },
  { id: 'typeScale', label: 'Type scale (px)', numeric: true, valueLabel: 'size in px' },
  { id: 'spacing', label: 'Spacing (px)', numeric: true, valueLabel: 'spacing in px' },
];

const HEX6 = /^#[0-9a-f]{6}$/i;
/** Same rule as the renderer: a token name ends up in a CSS custom property. */
const KEY = ID_PATTERN;
/** The renderer refuses a font stack with these (it ends up in a custom property). */
const UNSAFE_FONT = /[;{}<>\\]|url\s*\(|expression\s*\(|\/\*/i;
const MAX_KEY = 64;
/** Names the validator refuses as keys of a theme map. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

const rowsOf = (theme: Theme): Rows => ({
  colors: Object.entries(theme.colors).map(([key, value]) => ({ key, value })),
  fonts: Object.entries(theme.fonts).map(([key, value]) => ({ key, value })),
  typeScale: Object.entries(theme.typeScale).map(([key, value]) => ({ key, value: String(value) })),
  spacing: Object.entries(theme.spacing).map(([key, value]) => ({ key, value: String(value) })),
});

/**
 * The theme editor (arc42 §8.7): a draft of the deck's theme (name, colours, font stacks, type scale,
 * spacing) that is applied as one `SetTheme`, so it is one undo step and `SetTheme` still refuses
 * dropping a token that slides use. The contrast of the text, muted and accent colours against the
 * background is shown as the draft changes, with a warning below WCAG AA (4.5:1). Embedded fonts
 * (`fontFaces`) are not edited here; they stay as they are.
 */
@Component({
  selector: 'app-theme-editor',
  imports: [FocusTrap],
  template: `
    <div class="backdrop" aria-hidden="true" (click)="requestClose()"></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="theme-editor-title" appFocusTrap (keydown.escape)="onEscape($event)">
      <h2 id="theme-editor-title">Edit theme</h2>
      <div class="field">
        <label for="theme-name">Theme name</label>
        <input id="theme-name" type="text" [maxLength]="maxName" [value]="name()" (input)="name.set(value($event))" data-autofocus />
      </div>

      @for (group of groups; track group.id) {
        <fieldset>
          <legend>{{ group.label }}</legend>
          @for (row of rows()[group.id]; track row.key) {
            <div class="row">
              <span class="key" [id]="'row-' + group.id + '-' + row.key">{{ row.key }}</span>
              @if (group.id === 'colors' && isHex(row.value)) {
                <input type="color" [attr.aria-label]="row.key + ', pick a colour'" [value]="row.value" (input)="setValue(group.id, row.key, value($event))" />
              }
              <input
                [type]="group.numeric ? 'number' : 'text'"
                [attr.aria-labelledby]="'row-' + group.id + '-' + row.key"
                [value]="row.value"
                [attr.aria-invalid]="problem(group.id, row.key) ? 'true' : null"
                [attr.aria-describedby]="problem(group.id, row.key) ? 'problem-' + group.id + '-' + row.key : null"
                (input)="setValue(group.id, row.key, value($event))"
              />
              @if (inUse(group.id, row.key)) {
                <span class="note">in use</span>
              }
              <button type="button" [attr.aria-label]="'Remove ' + row.key" [attr.aria-disabled]="canRemove(group.id, row.key) ? null : 'true'" (click)="remove(group.id, row.key)">Remove</button>
              @if (problem(group.id, row.key); as message) {
                <span class="error" role="alert" [id]="'problem-' + group.id + '-' + row.key">{{ message }}</span>
              }
            </div>
          }
          <div class="row add">
            <input type="text" [attr.aria-label]="'New ' + group.label.toLowerCase() + ' name'" placeholder="name" [value]="adding()[group.id].key" (input)="setAdding(group.id, 'key', value($event))" />
            <input [type]="group.numeric ? 'number' : 'text'" [attr.aria-label]="'Value of the new ' + group.valueLabel" placeholder="value" [value]="adding()[group.id].value" (input)="setAdding(group.id, 'value', value($event))" />
            <button type="button" (click)="add(group.id)">Add</button>
          </div>
          @if (addProblem()[group.id]; as message) {
            <p class="error" role="alert">{{ message }}</p>
          }
        </fieldset>
      }

      <section aria-labelledby="theme-contrast-title">
        <h3 id="theme-contrast-title">Contrast against the background</h3>
        <ul class="contrast">
          @for (check of contrast(); track check.token) {
            <li [class.warn]="check.passes === false">
              <span class="swatch" aria-hidden="true" [style.background]="draft().colors['background']" [style.color]="draft().colors[check.token]">Aa</span>
              <strong>{{ check.token }}</strong>:
              @if (check.ratio === null) {
                not measured (use a hex colour such as #112233 to check it)
              } @else if (check.passes) {
                {{ ratio(check.ratio) }}:1, meets WCAG AA ({{ minimum }}:1)
              } @else {
                <span class="warning">Warning: {{ ratio(check.ratio) }}:1 is below WCAG AA ({{ minimum }}:1)</span>
              }
            </li>
          }
        </ul>
      </section>

      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      @if (confirming()) {
        <div class="question" role="alertdialog" aria-labelledby="theme-discard" aria-modal="true">
          <p id="theme-discard">Discard your changes to the theme?</p>
          <button type="button" data-keep (click)="confirming.set(false)">Keep editing</button>
          <button type="button" (click)="closed.emit()">Discard</button>
        </div>
      }
      <div class="actions">
        <button type="button" (click)="requestClose()">Cancel</button>
        <button type="button" class="primary" [attr.aria-disabled]="canApply() ? null : 'true'" (click)="apply()">Apply theme</button>
      </div>
    </div>
  `,
  styleUrl: './dialog.css',
  styles: `
    .dialog {
      width: min(46rem, calc(100vw - 2rem));
    }
    fieldset {
      margin: 0.75rem 0 0;
      padding: 0.5rem 0.75rem;
      border: 1px solid #c3c6cc;
    }
    legend {
      font-weight: 600;
    }
    .field {
      display: grid;
      gap: 0.25rem;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.35rem 0.5rem;
      margin: 0.25rem 0;
    }
    .key {
      min-width: 7rem;
      font-family: ui-monospace, Consolas, monospace;
    }
    .row input[type='text'],
    .row input[type='number'] {
      flex: 1 1 8rem;
      min-width: 0;
      padding: 0.2rem 0.35rem;
    }
    input[type='color'] {
      width: 2.5rem;
      height: 2rem;
      padding: 0;
    }
    .note {
      font-size: 0.8rem;
      color: #4d5560;
    }
    .error {
      flex: 1 1 100%;
      margin: 0;
      color: #8a1c14;
      font-size: 0.875rem;
    }
    .contrast {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .contrast li {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin: 0.25rem 0;
    }
    .swatch {
      display: inline-grid;
      place-items: center;
      width: 2.5rem;
      height: 1.75rem;
      border: 1px solid #767676;
      font-weight: 700;
    }
    .warning {
      color: #8a1c14;
      font-weight: 600;
    }
    .question {
      margin-top: 0.75rem;
      padding: 0.5rem 0.75rem;
      background: #fff4e0;
      border-left: 4px solid #8a5a00;
    }
    .actions {
      gap: 0.5rem;
    }
    button[aria-disabled='true'] {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .primary {
      background: #1d3f9c;
      border-color: #1d3f9c;
      color: #fff;
    }
  `,
})
export class ThemeEditor {
  private readonly store = inject(DeckStore);
  private readonly themes = inject(ThemeActions);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly groups = GROUPS;
  protected readonly maxName = MAX_THEME_NAME;
  protected readonly minimum = AA_TEXT_CONTRAST;

  private readonly start: Theme = this.store.deck().theme;
  protected readonly name = signal(this.start.name ?? '');
  protected readonly rows = signal<Rows>(rowsOf(this.start));
  protected readonly adding = signal<Record<Group, Row>>({
    colors: { key: '', value: '#000000' },
    fonts: { key: '', value: '' },
    typeScale: { key: '', value: '' },
    spacing: { key: '', value: '' },
  });
  protected readonly addProblem = signal<Partial<Record<Group, string>>>({});
  protected readonly error = signal<string | null>(null);
  protected readonly confirming = signal(false);
  private readonly initial = JSON.stringify([this.name(), this.rows()]);

  /** The theme the rows describe; a number that is not a number yet is NaN (and flagged). */
  protected readonly draft = computed<Theme>(() => {
    const rows = this.rows();
    const entries = (group: Group, numeric: boolean) =>
      Object.fromEntries(rows[group].map((r) => [r.key, numeric ? (r.value.trim() === '' ? NaN : Number(r.value)) : r.value]));
    const name = this.name().trim();
    return {
      ...(name ? { name } : {}),
      colors: entries('colors', false) as Record<string, string>,
      fonts: entries('fonts', false) as Record<string, string>,
      typeScale: entries('typeScale', true) as Record<string, number>,
      spacing: entries('spacing', true) as Record<string, number>,
      ...(this.start.fontFaces ? { fontFaces: this.start.fontFaces } : {}),
    };
  });
  protected readonly contrast = computed(() => themeContrast(this.draft()));
  private readonly dirty = computed(() => JSON.stringify([this.name(), this.rows()]) !== this.initial);
  private readonly used = computed(() => themeRefs(this.store.deck()));

  /** Problems per `group:key` that stop "Apply", with the text shown next to the row. */
  private readonly problems = computed(() => {
    const found = new Map<string, string>();
    const rows = this.rows();
    for (const r of rows.colors) {
      if (!LITERAL_COLOR.test(r.value)) found.set(`colors:${r.key}`, 'Use a hex colour such as #112233, rgb(), hsl() or a colour name');
    }
    for (const r of rows.fonts) {
      if (r.value.trim() === '' || UNSAFE_FONT.test(r.value)) found.set(`fonts:${r.key}`, 'Use a plain font family list such as "Inter", sans-serif');
    }
    for (const group of ['typeScale', 'spacing'] as const) {
      for (const r of rows[group]) {
        const n = r.value.trim() === '' ? NaN : Number(r.value);
        if (!Number.isFinite(n) || n < 0 || n > 1_000_000) found.set(`${group}:${r.key}`, 'Enter a number of pixels, 0 or more');
      }
    }
    return found;
  });
  protected readonly canApply = computed(() => this.problems().size === 0);

  readonly closed = output<void>();

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected isHex(value: string): boolean {
    return HEX6.test(value);
  }

  protected ratio(value: number): string {
    return (Math.floor(value * 100) / 100).toFixed(2); // never rounds 4.496 up to a pass
  }

  protected problem(group: Group, key: string): string | undefined {
    return this.problems().get(`${group}:${key}`);
  }

  protected inUse(group: Group, key: string): boolean {
    const used = this.used();
    return (group === 'colors' && used.colors.has(key)) || (group === 'fonts' && used.fonts.has(key)) || (group === 'typeScale' && used.sizes.has(key));
  }

  private required(group: Group, key: string): boolean {
    return (group === 'colors' && (REQUIRED_COLOR_TOKENS as readonly string[]).includes(key)) || (group === 'fonts' && (REQUIRED_FONT_KEYS as readonly string[]).includes(key));
  }

  protected canRemove(group: Group, key: string): boolean {
    return !this.required(group, key) && !this.inUse(group, key);
  }

  protected setValue(group: Group, key: string, value: string): void {
    this.rows.update((rows) => ({ ...rows, [group]: rows[group].map((r) => (r.key === key ? { key, value } : r)) }));
  }

  protected remove(group: Group, key: string): void {
    if (!this.canRemove(group, key)) {
      this.error.set(this.required(group, key) ? `“${key}” is needed by every theme` : `“${key}” is still used by the deck; change what uses it first`);
      return;
    }
    this.error.set(null);
    this.rows.update((rows) => ({ ...rows, [group]: rows[group].filter((r) => r.key !== key) }));
  }

  protected setAdding(group: Group, field: 'key' | 'value', value: string): void {
    this.adding.update((a) => ({ ...a, [group]: { ...a[group], [field]: value } }));
  }

  protected add(group: Group): void {
    const { key, value } = this.adding()[group];
    const def = GROUPS.find((g) => g.id === group)!;
    const fail = (message: string) => this.addProblem.update((p) => ({ ...p, [group]: message }));
    const name = key.trim();
    if (!KEY.test(name) || name.length > MAX_KEY || FORBIDDEN.has(name)) return fail('A name is 1 to 64 letters, digits, "_" or "-"');
    if (this.rows()[group].some((r) => r.key === name)) return fail(`“${name}” exists already`);
    const text = value.trim();
    if (def.numeric ? text === '' || !Number.isFinite(Number(text)) || Number(text) < 0 : text === '') return fail(`Enter a ${def.valueLabel}`);
    if (group === 'colors' && !LITERAL_COLOR.test(text)) return fail('Use a hex colour such as #112233, rgb(), hsl() or a colour name');
    if (group === 'fonts' && UNSAFE_FONT.test(text)) return fail('Use a plain font family list such as "Inter", sans-serif');
    this.addProblem.update((p) => ({ ...p, [group]: undefined }));
    this.rows.update((rows) => ({ ...rows, [group]: [...rows[group], { key: name, value: text }] }));
    this.adding.update((a) => ({ ...a, [group]: { key: '', value: group === 'colors' ? '#000000' : '' } }));
  }

  protected apply(): void {
    if (!this.canApply()) {
      this.error.set('Fix the highlighted values first');
      return;
    }
    const message = this.themes.applyCustom(this.draft());
    if (message === null) this.closed.emit();
    else this.error.set(message);
  }

  protected onEscape(event: Event): void {
    event.preventDefault();
    this.requestClose();
  }

  /** Closes at once, or asks first when there are unapplied changes (the question takes the focus). */
  protected requestClose(): void {
    if (!this.dirty()) return this.closed.emit();
    this.confirming.set(true);
    afterNextRender(() => this.host.querySelector<HTMLElement>('[data-keep]')?.focus(), { injector: this.injector });
  }
}
