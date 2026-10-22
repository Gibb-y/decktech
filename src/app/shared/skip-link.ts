import { Component, input } from '@angular/core';

/**
 * First focusable element of the page: jumps over the chrome to the main region. A button-like
 * link that focuses the target directly, because `#fragment` links fight the router's base href.
 */
@Component({
  selector: 'app-skip-link',
  template: `<a class="skip" href="#" (click)="skip($event)">Skip to main content</a>`,
  styles: `
    .skip {
      position: absolute;
      top: 0;
      left: 0;
      z-index: var(--z-skip-link);
      padding: var(--space-2) var(--space-4);
      border-radius: 0 0 var(--radius-md) 0;
      background: var(--accent);
      color: var(--accent-text);
      transform: translateY(-100%);
    }
    .skip:focus {
      transform: none;
      outline: 2px solid var(--accent-text);
      outline-offset: -4px;
    }
  `,
})
export class SkipLink {
  /** Id of the element to focus; it needs `tabindex="-1"`. */
  readonly target = input('main-content');

  protected skip(event: Event): void {
    event.preventDefault();
    document.getElementById(this.target())?.focus();
  }
}
