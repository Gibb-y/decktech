import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AutosaveService } from '../core/persistence';
import { DeckStore } from '../core/store';
import { CODE_TRUST } from '../renderer';
import { PresentationView } from './presentation-view';

type PageState = { status: 'loading' } | { status: 'ready' } | { status: 'unavailable'; message: string };

/**
 * The route `deck/:id/present`: opens the deck the way the editor does (so a deck that is already
 * open is not read twice and pending edits are saved first), then hands it to `PresentationView`.
 * `?slide=3` starts on the third slide. Leaving the presentation returns to the editor.
 */
@Component({
  selector: 'app-presenter-page',
  imports: [RouterLink, PresentationView],
  template: `
    @switch (state().status) {
      @case ('ready') {
        <app-presentation-view [deck]="store.deck()" [start]="start()" (exited)="leave()" />
      }
      @case ('unavailable') {
        <h1 tabindex="-1">Presentation</h1>
        <p class="error" role="alert">{{ unavailableMessage() }}</p>
        <p><a routerLink="/">Back to your decks</a></p>
      }
      @default {
        <h1 tabindex="-1">Presentation</h1>
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
export class PresenterPage {
  /** Route parameter `:id`. */
  readonly id = input.required<string>();
  /** Query parameter `slide`: the 1-based slide to start on. */
  readonly slide = input<string | undefined>(undefined);

  protected readonly store = inject(DeckStore);
  private readonly autosave = inject(AutosaveService);
  private readonly router = inject(Router);
  private readonly trust = inject(CODE_TRUST, { optional: true });
  protected readonly state = signal<PageState>({ status: 'loading' });
  private opening = 0;

  protected readonly start = computed(() => {
    const number = Number.parseInt(this.slide() ?? '', 10);
    return Number.isFinite(number) && number > 1 ? number - 1 : 0;
  });

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

  protected leave(): void {
    void this.router.navigate(['/deck', this.id()]);
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
    // The decision about the deck's code is read before any slide is drawn (arc42 §6.4).
    await this.trust?.refresh(id);
    if (attempt !== this.opening) return;
    this.state.set({ status: 'ready' });
  }
}
