import { Component, computed, output, signal } from '@angular/core';
import { FocusTrap } from '../../shared';
import { INSERT_ITEMS, type InsertKind } from '../insert-actions';

/**
 * The insert menu (opened with `/` or the toolbar): a filter box over the list of things that can be
 * added to a slide. Typing narrows the list, Enter takes the first match, Arrow Down moves into it.
 */
@Component({
  selector: 'app-insert-menu',
  imports: [FocusTrap],
  template: `
    <div class="backdrop" aria-hidden="true" (click)="closed.emit()"></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="insert-title" appFocusTrap (keydown.escape)="closed.emit(); $event.preventDefault()">
      <h2 id="insert-title">Insert</h2>
      <label for="insert-filter">Find an element</label>
      <input class="input"
        id="insert-filter"
        type="search"
        autocomplete="off"
        data-autofocus
        aria-describedby="insert-count"
        [value]="query()"
        (input)="onQuery($event)"
        (keydown)="onFilterKey($event)"
      />
      <p id="insert-count" class="count" aria-live="polite">{{ matches().length === 0 ? 'No element matches' : matches().length + ' to choose from' }}</p>
      <ul aria-label="Elements" (keydown)="onListKey($event)">
        @for (item of matches(); track item.kind) {
          <li>
            <button class="btn" type="button" (click)="chosen.emit(item.kind)">
              <span class="label">{{ item.label }}</span>
              <span class="description">{{ item.description }}</span>
            </button>
          </li>
        }
      </ul>
      <div class="actions">
        <button class="btn" type="button" (click)="closed.emit()">Cancel</button>
      </div>
    </div>
  `,
  styleUrl: '../dialog.css',
  styles: `
    label {
      display: block;
      font-weight: 600;
    }
    .count {
      margin: 0.35rem 0;
      color: var(--text-muted);
      font-size: 0.875rem;
    }
    ul {
      display: grid;
      gap: 0.35rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li button {
      display: grid;
      justify-content: stretch;
      justify-items: start;
      width: 100%;
      min-height: 0;
      padding: var(--space-2) var(--space-3);
      text-align: left;
      white-space: normal;
    }
    .label {
      font-weight: 600;
    }
    .description {
      color: var(--text-muted);
      font-size: 0.875rem;
    }
  `,
})
export class InsertMenu {
  readonly chosen = output<InsertKind>();
  readonly closed = output<void>();

  protected readonly query = signal('');
  protected readonly matches = computed(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    return INSERT_ITEMS.filter((i) => words.every((w) => `${i.label} ${i.kind}`.toLowerCase().includes(w)));
  });

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected onFilterKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      const [first] = this.matches();
      if (first) this.chosen.emit(first.kind);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.buttons(event)[0]?.focus();
    }
  }

  protected onListKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = this.buttons(event);
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (event.key === 'ArrowDown') buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
    else if (index > 0) buttons[index - 1].focus();
    else (event.currentTarget as HTMLElement).closest('.dialog')?.querySelector<HTMLInputElement>('#insert-filter')?.focus();
  }

  private buttons(event: Event): HTMLButtonElement[] {
    const root = (event.currentTarget as HTMLElement).closest('.dialog') ?? (event.currentTarget as HTMLElement);
    return Array.from(root.querySelectorAll<HTMLButtonElement>('ul button'));
  }
}
