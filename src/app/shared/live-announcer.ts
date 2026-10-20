import { Component, DestroyRef, Service, inject, signal } from '@angular/core';

/**
 * Speaks short status messages ("Deck deleted") to assistive technology through the single
 * `app-live-region` in the app shell.
 */
@Service()
export class LiveAnnouncer {
  private readonly messageState = signal('');
  readonly message = this.messageState.asReadonly();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  /** Re-announcing the same text works: the region is cleared first and filled on the next task. */
  announce(message: string): void {
    clearTimeout(this.timer);
    this.messageState.set('');
    this.timer = setTimeout(() => this.messageState.set(message), 50);
  }
}

@Component({
  selector: 'app-live-region',
  template: `<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ announcer.message() }}</div>`,
})
export class LiveRegion {
  protected readonly announcer = inject(LiveAnnouncer);
}
