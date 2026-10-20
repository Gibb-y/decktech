import { Component, Service, inject, signal } from '@angular/core';

/**
 * Speaks short status messages ("Deck deleted") to assistive technology through the single
 * `app-live-region` in the app shell.
 */
@Service()
export class LiveAnnouncer {
  private readonly messageState = signal('');
  readonly message = this.messageState.asReadonly();

  /** Re-announcing the same text works: the region is cleared first and filled on the next task. */
  announce(message: string): void {
    this.messageState.set('');
    setTimeout(() => this.messageState.set(message), 50);
  }
}

@Component({
  selector: 'app-live-region',
  template: `<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ announcer.message() }}</div>`,
  styles: `
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }
  `,
})
export class LiveRegion {
  protected readonly announcer = inject(LiveAnnouncer);
}
