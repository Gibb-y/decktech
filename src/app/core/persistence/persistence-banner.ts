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
      <div class="banner" role="alert">
        <p class="message">
          <strong>Your changes are not saved.</strong>
          {{ detail() }}
        </p>
        @if (exportFailed()) {
          <p class="message">The download failed. Try again.</p>
        }
        <div class="actions">
          <button type="button" (click)="retry()">Try again</button>
          @if (autosave.canExport()) {
            <button type="button" (click)="download()">Download .deck</button>
          }
        </div>
      </div>
    }
  `,
  styles: `
    .banner {
      position: sticky;
      top: 0;
      z-index: 1000;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 1rem;
      padding: 0.75rem 1rem;
      background: #fde8e6;
      color: #5c0f0a;
      border-bottom: 2px solid #8a1c14;
    }
    .message {
      margin: 0;
      flex: 1 1 20rem;
    }
    .actions {
      display: flex;
      gap: 0.5rem;
    }
    button {
      padding: 0.4rem 0.9rem;
      border: 0;
      border-radius: 0.25rem;
      background: #7a1d14;
      color: #fff;
      font: inherit;
      cursor: pointer;
    }
    button:focus-visible {
      outline: 3px solid #1a1a1a;
      outline-offset: 2px;
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
