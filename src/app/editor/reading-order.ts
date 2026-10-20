import { Component, ElementRef, Injector, afterNextRender, inject } from '@angular/core';
import { DeckStore } from '../core/store';
import { describeElement } from './describe';
import { EditorActions } from './editor-actions';

type Direction = 'earlier' | 'later';

/**
 * The reading-order panel (arc42 §8.8). A slide's element array is its z-order, its DOM order and so
 * its tab and reading order, so fixing the order for assistive technology means moving an element
 * earlier or later in that array. Each step is one `ReorderElements` command.
 */
@Component({
  selector: 'app-reading-order',
  template: `
    <section class="order" aria-labelledby="reading-order-title">
      <h3 id="reading-order-title">Reading order</h3>
      @if (store.currentSlide().elements.length === 0) {
        <p class="note">This slide has no elements yet.</p>
      } @else {
        <p id="reading-order-hint" class="note">Screen readers and the Tab key follow this order, first to last. Earlier elements are also further back.</p>
        <ol aria-describedby="reading-order-hint">
          @for (element of store.currentSlide().elements; track element.id; let i = $index; let first = $first; let last = $last) {
            <li [class.selected]="isSelected(element.id)">
              <button type="button" class="name" [attr.aria-pressed]="isSelected(element.id)" (click)="store.select([element.id])">{{ describe(element) }}</button>
              <button
                type="button"
                [attr.data-move]="element.id + ':earlier'"
                [attr.aria-label]="'Move ' + describe(element) + ' earlier'"
                [attr.aria-disabled]="first ? 'true' : null"
                (click)="move(element.id, 'earlier')"
              >
                ↑
              </button>
              <button
                type="button"
                [attr.data-move]="element.id + ':later'"
                [attr.aria-label]="'Move ' + describe(element) + ' later'"
                [attr.aria-disabled]="last ? 'true' : null"
                (click)="move(element.id, 'later')"
              >
                ↓
              </button>
            </li>
          }
        </ol>
      }
    </section>
  `,
  styles: `
    .order {
      margin-top: 1rem;
      padding-top: 0.5rem;
      border-top: 1px solid #c3c6cc;
      color: #111;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    }
    h3 {
      margin: 0 0 0.25rem;
      font-size: 1rem;
    }
    .note {
      margin: 0.25rem 0 0.5rem;
      color: #4b4b4b;
      font-size: 0.85rem;
    }
    ol {
      display: grid;
      gap: 0.25rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 0.25rem;
    }
    button {
      font: inherit;
      padding: 0.2rem 0.5rem;
      border: 1px solid #5a5a5a;
      border-radius: 0.25rem;
      background: #fff;
      color: #111;
      cursor: pointer;
    }
    .name {
      overflow: hidden;
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    li.selected .name {
      border-color: #1f4fc4;
      box-shadow: 0 0 0 2px #1f4fc4;
    }
    button[aria-disabled='true'] {
      color: #595959;
      cursor: not-allowed;
    }
    button:focus-visible {
      outline: 3px solid #ffbf47;
      outline-offset: 2px;
    }
  `,
})
export class ReadingOrder {
  protected readonly store = inject(DeckStore);
  private readonly actions = inject(EditorActions);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected describe = describeElement;

  protected isSelected(id: string): boolean {
    return this.store.selection().includes(id);
  }

  protected move(id: string, direction: Direction): void {
    this.actions.moveInReadingOrder(id, direction);
    // Moving a row redraws the list; keep the keyboard on the button that was used (or the other
    // arrow, if this one just became unavailable at the end of the list).
    afterNextRender(
      () => {
        const row = (suffix: Direction) => this.host.querySelector<HTMLElement>(`[data-move="${CSS.escape(id)}:${suffix}"]`);
        const used = row(direction);
        (used?.getAttribute('aria-disabled') === 'true' ? row(direction === 'earlier' ? 'later' : 'earlier') : used)?.focus();
      },
      { injector: this.injector },
    );
  }
}
