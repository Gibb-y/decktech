import { Service, computed, inject, signal } from '@angular/core';
import { CODE_TRUST, COMPONENT_TOOLS } from '../renderer';
import { DeckStore } from '../core/store';
import { LiveAnnouncer } from '../shared';

export type CodeToolsRequest = { view: 'edit'; elementId: string } | { view: 'library' } | { view: 'trust' };

/**
 * Opens the dialogs for code components (arc42 §5.3): the code editor of one element, or the
 * component library. The dialogs live in the `components` feature, which the editor may not import,
 * so this only holds the request; the shell draws what `COMPONENT_TOOLS` loads. `available` is false
 * where the app does not provide that loader.
 */
@Service()
export class CodeTools {
  private readonly store = inject(DeckStore);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly loader = inject(COMPONENT_TOOLS, { optional: true });

  readonly request = signal<CodeToolsRequest | null>(null);
  readonly available = computed(() => this.loader !== null);
  private readonly trust = inject(CODE_TRUST, { optional: true });
  /** The open deck has code the user has not decided on (arc42 §6.4): the shell then asks. */
  readonly reviewNeeded = computed(() => {
    const deck = this.store.deck();
    return this.loader !== null && (this.trust?.needsReview(deck.id, deck.components) ?? false);
  });

  /** Re-reads the trust decision of a deck that is being opened, before its slides are drawn. */
  refreshTrust(deckId: string): Promise<void> {
    return this.trust?.refresh(deckId) ?? Promise.resolve();
  }

  /** Opens the trust dialog: what the deck's code is and what it asks for, with the choice to run it. */
  review(): void {
    if (!this.loader) return void this.announcer.announce('The code review is not available');
    this.request.set({ view: 'trust' });
  }

  /** Loads the dialogs component; the shell calls this once a request is made. */
  load(): Promise<import('@angular/core').Type<unknown>> | null {
    return this.loader?.() ?? null;
  }

  /** Opens the code editor for a code element; returns whether it opened (false for other elements, locked ones are fine: the definition is not locked). */
  edit(elementId: string): boolean {
    const element = this.store.deck().slides.flatMap((s) => s.elements).find((e) => e.id === elementId);
    if (element?.type !== 'code') return false;
    if (!this.loader) {
      this.announcer.announce('The code editor is not available');
      return false;
    }
    this.request.set({ view: 'edit', elementId });
    return true;
  }

  openLibrary(): void {
    if (!this.loader) return void this.announcer.announce('The component library is not available');
    this.request.set({ view: 'library' });
  }

  close(): void {
    this.request.set(null);
  }
}
