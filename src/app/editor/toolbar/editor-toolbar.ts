import { Component, computed, inject, input, output } from '@angular/core';
import { BUILT_IN_THEMES } from '../../core/model';
import { DeckStore } from '../../core/store';
import { COLOR_SCHEME_MODES, ColorScheme, Icon, Menu, Tooltip, type ColorSchemeMode } from '../../shared';
import { SlideActions } from '../slide-actions';
import { ThemeActions, builtInThemeId } from '../theme-actions';

const SCHEME_LABELS: Readonly<Record<ColorSchemeMode, string>> = { system: 'System', light: 'Light', dark: 'Dark' };

/**
 * The editor's top bar: the actions that are about the deck rather than the selection (the canvas
 * has its own toolbar for those). Grouped as insert / slide, design, present; the rarer actions sit in
 * the overflow menu. One row at 1280 px. The insert menu and the shortcut help are dialogs owned by the shell.
 */
@Component({
  selector: 'app-editor-toolbar',
  imports: [Icon, Menu, Tooltip],
  template: `
    <div class="toolbar" role="group" aria-label="Editor tools">
      <div class="btn-group">
        <button type="button" class="btn btn-quiet" aria-haspopup="dialog" appTooltip="Insert an element" appTooltipShortcut="/" (click)="insert.emit()">
          <app-icon name="plus" />Insert
        </button>
        <button type="button" class="btn btn-quiet" appTooltip="Add a slide after the current one" (click)="slides.addSlide()">
          <app-icon name="layers" />Add slide
        </button>
      </div>
      <label class="picker">
        <span class="sr-only">New slide layout</span>
        <app-icon class="picker-icon" name="layout" />
        <select class="input input-sm" (change)="slides.newSlideLayout.set(layoutChoice($event))">
          <option value="" [selected]="slides.newSlideLayout() === null">Same as current slide</option>
          @for (layout of store.deck().layouts; track layout.id) {
            <option [value]="layout.id" [selected]="slides.newSlideLayout() === layout.id">{{ layout.name }}</option>
          }
        </select>
      </label>
      <span class="toolbar-separator" aria-hidden="true"></span>
      <label class="picker">
        <span class="sr-only">Theme</span>
        <app-icon class="picker-icon" name="palette" />
        <select class="input input-sm" (change)="chooseTheme($event)">
          @if (current() === null) {
            <option value="" selected disabled>{{ store.deck().theme.name ?? 'Custom' }}</option>
          }
          @for (theme of builtIn; track theme.id) {
            <option [value]="theme.id" [selected]="current() === theme.id">{{ theme.name }}</option>
          }
        </select>
      </label>
      <div class="btn-group">
        <button type="button" class="btn btn-quiet btn-icon" aria-haspopup="dialog" aria-label="Edit theme…" appTooltip="Edit theme…" (click)="themeEditor.emit()">
          <app-icon name="palette" />
        </button>
        <button type="button" class="btn btn-quiet btn-icon" aria-haspopup="dialog" aria-label="Layouts…" appTooltip="Layouts…" (click)="layoutEditor.emit()">
          <app-icon name="layout" />
        </button>
      </div>
      <span class="spacer"></span>
      <button type="button" class="btn btn-primary" appTooltip="Present from the current slide" appTooltipShortcut="F5" (click)="present.emit()">
        <app-icon name="play" />Present
      </button>
      <app-menu label="More actions">
        <button type="button" class="menu-item" role="menuitem" aria-haspopup="dialog" (click)="components.emit()"><app-icon name="component" />Components…</button>
        @if (canReview()) {
          <button type="button" class="menu-item" role="menuitem" aria-haspopup="dialog" (click)="review.emit()"><app-icon name="code" />Review code…</button>
        }
        <button type="button" class="menu-item" role="menuitem" (click)="themes.pickFont()"><app-icon name="type" />Add font…</button>
        <button type="button" class="menu-item" role="menuitem" aria-haspopup="dialog" (click)="help.emit()"><app-icon name="keyboard" />Keyboard shortcuts<kbd class="kbd" aria-hidden="true">?</kbd></button>
        <div class="menu-separator" role="separator"></div>
        <div class="menu-heading" aria-hidden="true">Colour scheme</div>
        @for (mode of schemeModes; track mode) {
          <button type="button" class="menu-item" role="menuitemradio" [attr.aria-checked]="scheme.mode() === mode" (click)="scheme.set(mode)">
            <app-icon [name]="mode === 'dark' ? 'moon' : mode === 'light' ? 'sun' : 'monitor'" />{{ schemeLabels[mode] }}
          </button>
        }
      </app-menu>
    </div>
  `,
  styles: `
    :host {
      display: block;
      flex: 1 1 auto;
      min-width: 0;
    }
    .toolbar {
      display: flex;
      flex-wrap: nowrap;
      align-items: center;
      gap: var(--space-2);
    }
    .picker {
      display: inline-flex;
      min-width: 0;
    }
    .picker-icon {
      align-self: center;
      margin-right: var(--space-1);
      color: var(--text-muted);
    }
    .picker select {
      max-width: 12rem;
    }
    .spacer {
      flex: 1 1 auto;
    }
  `,
})
export class EditorToolbar {
  protected readonly slides = inject(SlideActions);
  protected readonly themes = inject(ThemeActions);
  protected readonly store = inject(DeckStore);
  protected readonly scheme = inject(ColorScheme);
  protected readonly schemeModes = COLOR_SCHEME_MODES;
  protected readonly schemeLabels = SCHEME_LABELS;
  protected readonly builtIn = BUILT_IN_THEMES;
  protected readonly current = computed(() => builtInThemeId(this.store.deck().theme));

  protected choice(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  /** Applies the theme, then puts the select back on what the deck has, which differs if the change was refused. */
  protected chooseTheme(event: Event): void {
    this.themes.applyBuiltIn(this.choice(event));
    (event.target as HTMLSelectElement).value = this.current() ?? '';
  }

  protected layoutChoice(event: Event): string | null {
    return this.choice(event) || null;
  }

  readonly insert = output<void>();
  readonly help = output<void>();
  readonly components = output<void>();
  readonly review = output<void>();
  readonly canReview = input(false);
  readonly themeEditor = output<void>();
  readonly layoutEditor = output<void>();
  readonly present = output<void>();
}
