import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Placeholder route target until the editor (DT-07 onwards) is built. */
@Component({
  selector: 'app-editor-page',
  imports: [RouterLink],
  template: `
    <h1 tabindex="-1">Editor</h1>
    <p>Deck {{ id() }} will be edited here.</p>
    <p><a routerLink="/">Back to your decks</a></p>
  `,
})
export class EditorPage {
  /** Route parameter `:id`. */
  readonly id = input.required<string>();
}
