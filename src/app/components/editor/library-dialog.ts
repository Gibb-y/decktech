import { Component, inject, output } from '@angular/core';
import type { AssetRef, ComponentDef } from '../../core/model';
import { FocusTrap } from '../../shared';
import { ComponentLibrary } from './component-library';

/**
 * The component library (arc42 §5.3): the built-in examples and the components the author saved.
 * "Insert" puts a copy on the current slide and closes the dialog; saved components can be removed
 * from the library (decks that already use them keep their copy).
 */
@Component({
  selector: 'app-library-dialog',
  imports: [FocusTrap],
  template: `
    <div class="backdrop" aria-hidden="true" (click)="closed.emit()"></div>
    <div class="dialog narrow" role="dialog" aria-modal="true" aria-labelledby="library-title" appFocusTrap (keydown.escape)="closed.emit(); $event.preventDefault()">
      <h2 id="library-title">Component library</h2>
      <section aria-labelledby="library-builtin">
        <h3 id="library-builtin">Examples</h3>
        <ul class="entries">
          @for (def of library.builtIn; track def.id) {
            <li>
              <span class="name">{{ def.name }}</span>
              <button class="btn" type="button" (click)="insert(def)" [attr.aria-label]="'Insert ' + def.name" [attr.data-autofocus]="$first ? '' : null">Insert</button>
            </li>
          }
        </ul>
      </section>
      <section aria-labelledby="library-saved">
        <h3 id="library-saved">Your components</h3>
        @if (library.error(); as message) {
          <p class="errors" role="alert">{{ message }}</p>
        }
        <ul class="entries">
          @for (entry of library.saved(); track entry.def.id) {
            <li>
              <span class="name">{{ entry.def.name }}</span>
              <button class="btn" type="button" (click)="insert(entry.def, entry.assets)" [attr.aria-label]="'Insert ' + entry.def.name">Insert</button>
              <button class="btn" type="button" (click)="library.remove(entry.def.id)" [attr.aria-label]="'Remove ' + entry.def.name + ' from the library'">Remove</button>
            </li>
          } @empty {
            <li class="muted">Nothing saved yet. Use “Save to library” in the code editor.</li>
          }
        </ul>
      </section>
      <footer>
        <span class="spacer"></span>
        <button class="btn" type="button" (click)="closed.emit()">Close</button>
      </footer>
    </div>
  `,
  styleUrl: './tools-dialog.css',
  styles: `
    .entries {
      margin: 0 0 0.75rem;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 0.35rem;
    }
    .entries li {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .name {
      flex: 1 1 auto;
    }
  `,
})
export class LibraryDialog {
  protected readonly library = inject(ComponentLibrary);
  readonly closed = output<void>();

  constructor() {
    void this.library.refresh();
  }

  protected insert(def: ComponentDef, assets?: Record<string, AssetRef>): void {
    if (this.library.insert({ def, assets })) this.closed.emit();
  }
}
