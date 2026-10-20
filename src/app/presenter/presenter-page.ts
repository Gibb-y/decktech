import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Placeholder route target until the presentation view is built. */
@Component({
  selector: 'app-presenter-page',
  imports: [RouterLink],
  template: `
    <h1 tabindex="-1">Presentation</h1>
    <p>Deck {{ id() }} will be presented here.</p>
    <p><a routerLink="/">Back to your decks</a></p>
  `,
})
export class PresenterPage {
  /** Route parameter `:id`. */
  readonly id = input.required<string>();
}
