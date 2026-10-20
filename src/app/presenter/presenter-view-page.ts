import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Placeholder route target until the presenter view (notes, timer, next slide) is built. */
@Component({
  selector: 'app-presenter-view-page',
  imports: [RouterLink],
  template: `
    <h1 tabindex="-1">Presenter view</h1>
    <p>Notes and timer for deck {{ id() }} will be shown here.</p>
    <p><a routerLink="/">Back to your decks</a></p>
  `,
})
export class PresenterViewPage {
  /** Route parameter `:id`. */
  readonly id = input.required<string>();
}
