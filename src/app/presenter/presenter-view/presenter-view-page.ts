import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AutosaveService } from '../../core/persistence';
import { DeckStore } from '../../core/store';
import { PresenterView } from './presenter-view';

type PageState = { status: 'loading' } | { status: 'ready' } | { status: 'unavailable'; message: string };

/**
 * The route `deck/:id/presenter-view`: opens the deck the way the editor and the presentation do,
 * then hands it to `PresenterView`. It never edits the deck.
 */
@Component({
  selector: 'app-presenter-view-page',
  imports: [RouterLink, PresenterView],
  template: `
    @switch (state().status) {
      @case ('ready') {
        <app-presenter-view [deck]="store.deck()" />
      }
      @case ('unavailable') {
        <h1 tabindex="-1">Presenter view</h1>
        <p class="error" role="alert">{{ unavailableMessage() }}</p>
        <p><a routerLink="/">Back to your decks</a></p>
      }
      @default {
        <h1 tabindex="-1">Presenter view</h1>
        <p role="status">Opening deck…</p>
      }
    }
  `,
  styles: `
    :host {
      display: block;
      padding: 0 1rem;
    }
    .error {
      padding: 0.75rem 1rem;
      background: var(--danger-subtle);
      color: var(--text);
      border-left: 4px solid var(--danger-ink);
    }
  `,
})
export class PresenterViewPage {
  /** Route parameter `:id`. */
  readonly id = input.required<string>();

  protected readonly store = inject(DeckStore);
  private readonly autosave = inject(AutosaveService);
  protected readonly state = signal<PageState>({ status: 'loading' });
  private opening = 0;

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.open(id));
    });
  }

  protected unavailableMessage(): string {
    const state = this.state();
    return state.status === 'unavailable' ? state.message : '';
  }

  private async open(id: string): Promise<void> {
    const attempt = ++this.opening;
    this.state.set({ status: 'loading' });
    let result: Awaited<ReturnType<AutosaveService['open']>>;
    try {
      result = await this.autosave.open(id);
    } catch (e) {
      if (attempt === this.opening) this.state.set({ status: 'unavailable', message: `This deck could not be opened: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    if (attempt !== this.opening) return;
    if (!result.ok) return this.state.set({ status: 'unavailable', message: `This deck could not be opened: ${result.error.message}` });
    if (result.value.readOnly) return this.state.set({ status: 'unavailable', message: result.value.reason });
    this.state.set({ status: 'ready' });
  }
}
