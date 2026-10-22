import { Component, computed, inject, signal } from '@angular/core';
import { AutosaveService } from './autosave';

const DETAIL: Record<string, string> = {
  quota: 'The browser storage is full. Free up space, or download the deck as a file.',
  conflict: 'This deck was changed in another tab or window. Reload to continue, or download your version.',
  'read-only': 'This deck was created by a newer version of DeckTech and cannot be saved.',
};

/** Persistent notice shown while autosave is failing (arc42 §6.5). */
@Component({
  selector: 'app-persistence-banner',
  template: `
    @if (autosave.status() === 'error') {
      <section class="banner" aria-label="Save status">
        <div class="content" role="alert">
        <p class="message">
          <strong>Your changes are not saved.</strong>
          {{ detail() }}
        </p>
        @if (exportFailed()) {
          <p class="message">The download failed. Try again.</p>
        }
        <div class="actions">
          <button class="btn" type="button" (click)="retry()">Try again</button>
          @if (autosave.canExport()) {
            <button class="btn" type="button" (click)="download()">Download .deck</button>
          }
        </div>
        </div>
      </section>
    }
  `,
  styles: `
    .banner {
      position: sticky;
      top: 0;
      z-index: var(--z-toast);
    }
    .content {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 1rem;
      padding: 0.75rem 1rem;
      background: var(--danger-subtle);
      color: var(--text);
      border-bottom: 2px solid var(--danger-ink);
    }
    .message {
      margin: 0;
      flex: 1 1 20rem;
    }
    .actions {
      display: flex;
      gap: 0.5rem;
    }
  `,
})
export class PersistenceBanner {
  protected readonly autosave = inject(AutosaveService);
  protected readonly exportFailed = signal(false);

  protected readonly detail = computed(() => {
    const error = this.autosave.error();
    return error ? (DETAIL[error.kind] ?? error.message) : '';
  });

  protected retry(): void {
    void this.autosave.flush();
  }

  protected async download(): Promise<void> {
    this.exportFailed.set(false);
    try {
      await this.autosave.exportDeck();
    } catch {
      this.exportFailed.set(true);
    }
  }
}
