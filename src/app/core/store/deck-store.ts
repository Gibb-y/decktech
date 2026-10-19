import { InjectionToken, Service, computed, inject, signal } from '@angular/core';
import { createDeck, type Deck, type Slide } from '../model';
import type { Command } from './command';
import { History, type HistoryOptions } from './history';
import { applyPatch } from './patch';

/** Time source for coalescing; replace it in tests. */
export const CLOCK = new InjectionToken<() => number>('DeckStore clock', {
  providedIn: 'root',
  factory: () => () => Date.now(),
});

export const HISTORY_OPTIONS = new InjectionToken<HistoryOptions>('DeckStore history options', {
  providedIn: 'root',
  factory: () => ({}),
});

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Holds the current deck as an immutable value. The only way to change it is `execute(command)`
 * (plus `undo`/`redo`, which replay recorded patches, and `load`, which swaps the whole document
 * and resets history). Selection and the current slide are UI state and not part of history.
 */
@Service()
export class DeckStore {
  private readonly clock = inject(CLOCK);
  private readonly history = new History(inject(HISTORY_OPTIONS));

  private readonly deckState = signal<Deck>(createDeck());
  private readonly currentSlideIdState = signal<string>(this.deckState().slides[0].id);
  private readonly selectionState = signal<readonly string[]>([]);

  readonly deck = this.deckState.asReadonly();
  readonly slides = computed(() => this.deck().slides);
  readonly currentSlideId = this.currentSlideIdState.asReadonly();
  readonly currentSlideIndex = computed(() => {
    const index = this.slides().findIndex((s) => s.id === this.currentSlideIdState());
    return Math.max(index, 0);
  });
  readonly currentSlide = computed<Slide>(() => this.slides()[this.currentSlideIndex()]);

  /** Ids of the selected elements that are on the current slide, in z-order. */
  readonly selection = computed(
    () => {
      const selected = new Set(this.selectionState());
      return this.currentSlide()
        .elements.filter((e) => selected.has(e.id))
        .map((e) => e.id);
    },
    { equal: sameIds },
  );
  readonly selectedElements = computed(() => {
    const ids = new Set(this.selection());
    return this.currentSlide().elements.filter((e) => ids.has(e.id));
  });

  readonly canUndo = this.history.canUndo;
  readonly canRedo = this.history.canRedo;

  /** Replaces the whole document (open, import) and starts a fresh history. */
  load(deck: Deck): void {
    if (deck.slides.length === 0) throw new RangeError('A deck needs at least one slide');
    this.history.clear();
    this.selectionState.set([]);
    this.currentSlideIdState.set(deck.slides[0].id);
    this.deckState.set(deck);
  }

  /** Runs a command and records it in history. If the command throws, nothing changes. */
  execute(command: Command): void {
    const before = this.deckState();
    const result = command.do(before);
    if (result.deck === before) return;
    this.history.record({
      name: command.name,
      forward: result.patch,
      inverse: result.inverse,
      coalesceKey: command.coalesceKey,
      time: this.clock(),
    });
    this.commit(result.deck, before);
  }

  undo(): void {
    const entry = this.history.undo();
    if (entry) this.commit(applyPatch(this.deckState(), entry.inverse), this.deckState());
  }

  redo(): void {
    const entry = this.history.redo();
    if (entry) this.commit(applyPatch(this.deckState(), entry.forward), this.deckState());
  }

  selectSlide(slideId: string): void {
    if (!this.slides().some((s) => s.id === slideId)) return;
    if (slideId !== this.currentSlideIdState()) this.selectionState.set([]);
    this.currentSlideIdState.set(slideId);
  }

  select(elementIds: readonly string[]): void {
    this.selectionState.set([...elementIds]);
  }

  clearSelection(): void {
    this.selectionState.set([]);
  }

  private commit(next: Deck, previous: Deck): void {
    this.deckState.set(next);
    // Keep the current slide valid: if it vanished, land on the neighbour at the same position.
    const current = this.currentSlideIdState();
    if (!next.slides.some((s) => s.id === current)) {
      const index = Math.min(Math.max(previous.slides.findIndex((s) => s.id === current), 0), next.slides.length - 1);
      this.currentSlideIdState.set(next.slides[index].id);
    }
  }
}
