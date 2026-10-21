import { Component, input, output } from '@angular/core';
import { CodeEditorDialog } from './code-editor-dialog';
import { LibraryDialog } from './library-dialog';

/**
 * What `COMPONENT_TOOLS` loads: one lazy component that shows either the code editor of a code
 * element or the component library. Everything that needs CodeMirror hangs off this one chunk.
 */
@Component({
  selector: 'app-component-tools',
  imports: [CodeEditorDialog, LibraryDialog],
  template: `
    @if (view() === 'library') {
      <app-library-dialog (closed)="closed.emit()" />
    } @else if (elementId(); as id) {
      <app-code-editor-dialog [elementId]="id" (closed)="closed.emit()" />
    }
  `,
})
export class ComponentTools {
  readonly view = input<'edit' | 'library'>('edit');
  readonly elementId = input<string | null>(null);
  readonly closed = output<void>();
}
