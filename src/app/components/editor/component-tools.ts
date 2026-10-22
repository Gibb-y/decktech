import { Component, input, output } from '@angular/core';
import { CodeEditorDialog } from './code-editor-dialog';
import { TrustDialog } from '../trust/trust-dialog';
import { LibraryDialog } from './library-dialog';

/**
 * What `COMPONENT_TOOLS` loads: one lazy component that shows the code editor of a code
 * element, the component library or the trust dialog with its code inspector. Everything that needs CodeMirror hangs off this one chunk.
 */
@Component({
  selector: 'app-component-tools',
  imports: [CodeEditorDialog, LibraryDialog, TrustDialog],
  template: `
    @if (view() === 'library') {
      <app-library-dialog (closed)="closed.emit()" />
    } @else if (view() === 'trust') {
      <app-trust-dialog (closed)="closed.emit()" />
    } @else if (elementId(); as id) {
      <app-code-editor-dialog [elementId]="id" (closed)="closed.emit()" />
    }
  `,
})
export class ComponentTools {
  readonly view = input<'edit' | 'library' | 'trust'>('edit');
  readonly elementId = input<string | null>(null);
  readonly closed = output<void>();
}
