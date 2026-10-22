import { DOCUMENT } from '@angular/common';
import { Component, Service, inject, signal } from '@angular/core';

export type ColorSchemeMode = 'light' | 'dark' | 'system';

export const COLOR_SCHEME_MODES: readonly ColorSchemeMode[] = ['system', 'light', 'dark'];

/** Where the manual choice is kept. The inline script in `index.html` reads the same key. */
export const COLOR_SCHEME_KEY = 'decktech.colorScheme';

/**
 * What a first visit gets. Light until every screen has moved to the design tokens (arc42 8.11); then
 * this becomes `'system'`. `index.html` repeats the value for the no-flash script (a spec keeps them equal).
 */
export const DEFAULT_COLOR_SCHEME: ColorSchemeMode = 'light';

export function isColorSchemeMode(value: unknown): value is ColorSchemeMode {
  return typeof value === 'string' && (COLOR_SCHEME_MODES as readonly string[]).includes(value);
}

/**
 * The colour scheme of the app chrome. The choice is stored locally and applied as `data-theme` on
 * `<html>`; `system` removes the attribute so the stylesheet follows `prefers-color-scheme`. It never
 * touches deck themes (arc42 8.11).
 */
@Service()
export class ColorScheme {
  private readonly root = inject(DOCUMENT).documentElement;
  private readonly modeState = signal<ColorSchemeMode>(this.stored() ?? DEFAULT_COLOR_SCHEME);
  readonly mode = this.modeState.asReadonly();

  constructor() {
    this.apply(this.modeState());
  }

  set(mode: ColorSchemeMode): void {
    if (!isColorSchemeMode(mode)) return;
    this.modeState.set(mode);
    this.apply(mode);
    try {
      this.root.ownerDocument.defaultView?.localStorage.setItem(COLOR_SCHEME_KEY, mode);
    } catch {
      // Storage blocked or full: the choice holds for this session only.
    }
  }

  private stored(): ColorSchemeMode | null {
    try {
      const value = this.root.ownerDocument.defaultView?.localStorage.getItem(COLOR_SCHEME_KEY);
      return isColorSchemeMode(value) ? value : null;
    } catch {
      return null;
    }
  }

  private apply(mode: ColorSchemeMode): void {
    if (mode === 'system') this.root.removeAttribute('data-theme');
    else this.root.setAttribute('data-theme', mode);
  }
}

const LABELS: Readonly<Record<ColorSchemeMode, string>> = { system: 'System', light: 'Light', dark: 'Dark' };

/** A labelled select for the colour scheme. */
@Component({
  selector: 'app-color-scheme-switch',
  template: `
    <label>
      <span class="sr-only">Colour scheme</span>
      <select [value]="scheme.mode()" (change)="choose($event)">
        @for (mode of modes; track mode) {
          <option [value]="mode" [selected]="mode === scheme.mode()">{{ labels[mode] }}</option>
        }
      </select>
    </label>
  `,
})
export class ColorSchemeSwitch {
  protected readonly scheme = inject(ColorScheme);
  protected readonly modes = COLOR_SCHEME_MODES;
  protected readonly labels = LABELS;

  protected choose(event: Event): void {
    this.scheme.set((event.target as HTMLSelectElement).value as ColorSchemeMode);
  }
}
