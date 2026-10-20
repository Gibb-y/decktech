import { Component, inject, output } from '@angular/core';
import { SlideActions } from '../slide-actions';

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
      <button type="button" aria-haspopup="dialog" (click)="help.emit()">Keyboard shortcuts <kbd aria-hidden="true">?</kbd></button>
    </div>
  `,
  styles: `
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
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

  readonly insert = output<void>();
  readonly help = output<void>();
}
