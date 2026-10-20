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
      z-index: 2000;
      padding: 0.6rem 1rem;
      background: #111;
      color: #fff;
      transform: translateY(-100%);
    }
    .skip:focus {
      transform: none;
      outline: 3px solid #ffbf47;
      outline-offset: -3px;
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
