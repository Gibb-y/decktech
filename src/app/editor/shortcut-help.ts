import { Component, inject, output } from '@angular/core';
import { FocusTrap } from '../shared';
import { SCOPE_LABELS, ShortcutRegistry } from './shortcut-registry';

/**
 * The "Keyboard shortcuts" dialog: everything in `ShortcutRegistry`, grouped by where it works.
 * A modal dialog that traps focus, closes on Escape and gives focus back to what opened it.
 */
@Component({
  selector: 'app-shortcut-help',
  imports: [FocusTrap],
  template: `
    <div class="backdrop" aria-hidden="true" (click)="closed.emit()"></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title" appFocusTrap (keydown.escape)="closed.emit()">
      <h2 id="shortcut-help-title">Keyboard shortcuts</h2>
      @for (scope of registry.scopes(); track scope) {
        <section [attr.aria-labelledby]="'shortcut-scope-' + scope">
          <h3 [id]="'shortcut-scope-' + scope">{{ labels[scope] }}</h3>
          <dl>
            @for (s of shortcutsOf(scope); track s.id) {
              <dt>
                <kbd>{{ s.keys }}</kbd>
              </dt>
              <dd>{{ s.description }}</dd>
            }
          </dl>
        </section>
      }
      <div class="actions">
        <button type="button" data-autofocus (click)="closed.emit()">Close</button>
      </div>
    </div>
  `,
  styleUrl: './dialog.css',
  styles: `
    h3 {
      margin: 1rem 0 0.35rem;
      font-size: 1rem;
    }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.25rem 1rem;
      margin: 0;
    }
    dt,
    dd {
      margin: 0;
    }
    kbd {
      padding: 0.1rem 0.4rem;
      border: 1px solid #5a5a5a;
      border-radius: 0.25rem;
      background: #f1f2f4;
      font: 0.875rem ui-monospace, Consolas, monospace;
    }
  `,
})
export class ShortcutHelp {
  protected readonly registry = inject(ShortcutRegistry);
  protected readonly labels = SCOPE_LABELS;

  readonly closed = output<void>();

  protected shortcutsOf(scope: keyof typeof SCOPE_LABELS) {
    return this.registry.shortcuts().filter((s) => s.scope === scope);
  }
}
