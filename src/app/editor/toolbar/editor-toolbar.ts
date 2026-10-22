import { Component, computed, inject, input, output } from '@angular/core';
import { BUILT_IN_THEMES } from '../../core/model';
import { DeckStore } from '../../core/store';
import { SlideActions } from '../slide-actions';
import { ThemeActions, builtInThemeId } from '../theme-actions';

/**
 * The editor's top bar: the actions that are about the deck rather than the selection (the canvas
 * has its own toolbar for those). The insert menu and the shortcut help are dialogs owned by the shell.
 */
@Component({
  selector: 'app-editor-toolbar',
  template: `
    <div class="toolbar" role="group" aria-label="Editor tools">
      <button type="button" aria-haspopup="dialog" (click)="insert.emit()">Insert <kbd aria-hidden="true">/</kbd></button>
      <button type="button" (click)="slides.addSlide()">Add slide</button>
      <label>
        New slide layout
        <select (change)="slides.newSlideLayout.set(layoutChoice($event))">
          <option value="" [selected]="slides.newSlideLayout() === null">Same as current slide</option>
          @for (layout of store.deck().layouts; track layout.id) {
            <option [value]="layout.id" [selected]="slides.newSlideLayout() === layout.id">{{ layout.name }}</option>
          }
        </select>
      </label>
      <label>
        Theme
        <select (change)="chooseTheme($event)">
          @if (current() === null) {
            <option value="" selected disabled>{{ store.deck().theme.name ?? 'Custom' }}</option>
          }
          @for (theme of builtIn; track theme.id) {
            <option [value]="theme.id" [selected]="current() === theme.id">{{ theme.name }}</option>
          }
        </select>
      </label>
      <button type="button" aria-haspopup="dialog" (click)="themeEditor.emit()">Edit theme…</button>
      <button type="button" aria-haspopup="dialog" (click)="layoutEditor.emit()">Layouts…</button>
      <button type="button" aria-haspopup="dialog" (click)="components.emit()">Components…</button>
      @if (canReview()) {
        <button type="button" aria-haspopup="dialog" (click)="review.emit()">Review code…</button>
      }
      <button type="button" (click)="themes.pickFont()">Add font…</button>
      <button type="button" (click)="present.emit()">Present <kbd aria-hidden="true">F5</kbd></button>
      <button type="button" aria-haspopup="dialog" (click)="help.emit()">Keyboard shortcuts <kbd aria-hidden="true">?</kbd></button>
    </div>
  `,
  styles: `
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
    }
    label {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }
    select {
      font: inherit;
      padding: 0.25rem 0.35rem;
      border: 1px solid #5a5a5a;
      border-radius: 0.25rem;
      background: #fff;
      color: #111;
    }
    select:focus-visible {
      outline: 3px solid #ffbf47;
      outline-offset: 2px;
    }
    button {
      font: inherit;
      padding: 0.3rem 0.65rem;
      border: 1px solid #5a5a5a;
      border-radius: 0.25rem;
      background: #fff;
      color: #111;
      cursor: pointer;
    }
    button:focus-visible {
      outline: 3px solid #ffbf47;
      outline-offset: 2px;
    }
    kbd {
      margin-left: 0.25rem;
      padding: 0 0.3rem;
      border: 1px solid #767676;
      border-radius: 0.2rem;
      font: 0.8rem ui-monospace, Consolas, monospace;
    }
  `,
})
export class EditorToolbar {
  protected readonly slides = inject(SlideActions);
  protected readonly themes = inject(ThemeActions);
  protected readonly store = inject(DeckStore);
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
