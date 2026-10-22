import { Component, input, output } from '@angular/core';
import { FocusTrap } from './focus-trap';
import { Icon } from './icon';
import { Tooltip } from './tooltip';
import { uniqueId } from './unique-id';

/**
 * The shell of a modal dialog: backdrop, header with a title and a close button, a scrolling body and a footer
 * for the actions. Content goes in the default slot and the buttons in `[dialog-footer]`. Focus is trapped
 * (`FocusTrap`: the first control, or `[data-autofocus]`, gets it, and it returns to the opener), Escape and a
 * click on the backdrop emit `closed`; the consumer removes the dialog. Escape does not reach an outer dialog.
 */
@Component({
  selector: 'app-dialog',
  imports: [FocusTrap, Icon, Tooltip],
  template: `
    <div class="dialog-root">
      <div class="dialog-backdrop" aria-hidden="true" (click)="closed.emit()"></div>
      <div
        class="dialog-panel"
        [class.dialog-wide]="wide()"
        role="dialog"
        aria-modal="true"
        [attr.aria-labelledby]="titleId"
        appFocusTrap
        (keydown.escape)="onEscape($event)"
      >
        <div class="dialog-header">
          <h2 class="dialog-title" [id]="titleId">{{ heading() }}</h2>
          <button type="button" class="btn btn-quiet btn-icon btn-sm" appTooltip="Close" appTooltipShortcut="Esc" (click)="closed.emit()">
            <app-icon name="x" />
          </button>
        </div>
        <div class="dialog-body"><ng-content /></div>
        <div class="dialog-footer"><ng-content select="[dialog-footer]" /></div>
      </div>
    </div>
  `,
})
export class Dialog {
  readonly heading = input.required<string>();
  /** A wide panel for editors. */
  readonly wide = input(false);
  readonly closed = output<void>();

  protected readonly titleId = uniqueId('dialog-title');

  protected onEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.closed.emit();
  }
}
