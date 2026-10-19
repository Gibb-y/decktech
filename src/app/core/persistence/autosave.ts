import { Service, computed, effect, inject, signal, untracked } from '@angular/core';
import type { MigrationOutcome } from '../migrations';
import { err, ok, type Deck, type Result } from '../model';
import { DeckStore } from '../store';
import { DeckRepository, type LoadError } from './deck-repository';
import { toPersistenceError, type PersistenceError } from './errors';
import { AUTOSAVE_OPTIONS, DECK_EXPORT_HANDLER, STORAGE_MANAGER } from './tokens';

export type AutosaveStatus = 'saved' | 'saving' | 'error';

/** The deck being kept in sync, and what the repository is known to hold. */
interface Tracked {
  id: string;
  /** Revision of the stored copy; `null` while the deck has never been saved. */
  revision: number | null;
  /** The deck value last written (or loaded); changes are detected by identity. */
  saved: Deck | null;
  /** Latest deck value seen, waiting to be written. */
  pending: Deck | null;
}

/**
 * Writes the open deck to the `DeckRepository` 500 ms after the last change (arc42 §6.1). Only the
 * deck handed over with `open` / `create` is tracked, so loading a deck never rewrites it by itself
 * and a deck swapped in behind its back is ignored. Writes are serialised, and a failed write
 * leaves `status` at `error` until a later write succeeds.
 */
@Service()
export class AutosaveService {
  private readonly store = inject(DeckStore);
  private readonly repository = inject(DeckRepository);
  private readonly options = inject(AUTOSAVE_OPTIONS);
  private readonly exportHandler = inject(DECK_EXPORT_HANDLER);
  private readonly storage = inject(STORAGE_MANAGER);

  private readonly statusState = signal<AutosaveStatus>('saved');
  private readonly errorState = signal<PersistenceError | null>(null);
  private readonly persistedState = signal(false);

  readonly status = this.statusState.asReadonly();
  /** The failure behind `status() === 'error'`. */
  readonly error = this.errorState.asReadonly();
  /** Whether the browser granted persistent storage (`navigator.storage.persist()`). */
  readonly persisted = this.persistedState.asReadonly();
  /** Whether a "Download .deck" handler is available. */
  readonly canExport = computed(() => this.exportHandler !== null);

  private tracked: Tracked | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<boolean> = Promise.resolve(true);

  constructor() {
    effect(() => {
      const deck = this.store.deck();
      untracked(() => this.onDeckChanged(deck));
    });
  }

  /** Asks the browser not to evict our storage; resolves to whether it is persistent. */
  async requestPersistence(): Promise<boolean> {
    try {
      const storage = this.storage;
      const granted = (await storage?.persisted?.()) || (await storage?.persist?.()) || false;
      this.persistedState.set(granted);
      return granted;
    } catch {
      return false;
    }
  }

  /** Makes `deck` the open document and schedules its first save. */
  create(deck: Deck): void {
    this.store.load(deck);
    this.track(null, false);
  }

  /**
   * Saves pending changes, then loads and opens the stored deck. A newer-schema deck comes back as
   * a read-only outcome and leaves the open deck alone. If pending changes cannot be saved the open
   * deck stays (unless `force`), so edits are never dropped silently.
   */
  async open(id: string, options: { force?: boolean } = {}): Promise<Result<MigrationOutcome, LoadError | PersistenceError>> {
    if (!(await this.flush()) && !options.force) {
      return err(this.errorState() ?? { kind: 'storage', message: 'pending changes could not be saved' });
    }
    const loaded = await this.repository.load(id);
    if (!loaded.ok) return loaded;
    const { outcome, revision } = loaded.value;
    if (outcome.readOnly) return ok(outcome);
    this.store.load(outcome.deck);
    // A migrated deck is saved right away so the upgrade (already backed up) is not repeated.
    this.track(revision, outcome.migrated);
    return ok(outcome);
  }

  /**
   * Writes any pending change now (call before import, migration, closing). Resolves to `true`
   * when everything is stored.
   */
  flush(): Promise<boolean> {
    this.clearTimers();
    const tracked = this.tracked;
    this.chain = this.chain.then(() => this.write(tracked));
    return this.chain;
  }

  /** Runs the "Download .deck" hook on the open deck. */
  async exportDeck(): Promise<void> {
    await this.exportHandler?.(this.store.deck());
  }

  private track(revision: number | null, dirty: boolean): void {
    const deck = this.store.deck();
    this.clearTimers();
    this.errorState.set(null);
    this.statusState.set('saved');
    const needsSave = revision === null || dirty;
    this.tracked = { id: deck.id, revision, saved: needsSave ? null : deck, pending: needsSave ? deck : null };
    if (needsSave) this.schedule();
  }

  private onDeckChanged(deck: Deck): void {
    const tracked = this.tracked;
    if (!tracked || deck.id !== tracked.id || deck === tracked.saved) return;
    tracked.pending = deck;
    this.schedule();
  }

  private schedule(): void {
    this.statusState.set('saving');
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), this.options.debounceMs);
    // A gesture that never pauses must still reach storage.
    this.maxWaitTimer ??= setTimeout(() => void this.flush(), this.options.maxWaitMs);
  }

  private clearTimers(): void {
    clearTimeout(this.debounceTimer);
    clearTimeout(this.maxWaitTimer);
    this.debounceTimer = undefined;
    this.maxWaitTimer = undefined;
  }

  /** One write of the latest pending value; state is committed only after the repository accepted it. */
  private async write(tracked: Tracked | null): Promise<boolean> {
    if (!tracked) return true;
    const deck = tracked.pending;
    if (!deck || deck === tracked.saved) return true;

    // Repositories report failures as results; a custom one that rejects must not poison the chain.
    const result = await this.repository.save(deck, tracked.revision).catch((e: unknown) => err(toPersistenceError(e)));
    if (result.ok) {
      tracked.saved = deck;
      tracked.revision = result.value;
    }
    if (this.tracked !== tracked) return result.ok;

    if (result.ok) {
      if (tracked.pending === deck) {
        this.errorState.set(null);
        if (this.debounceTimer === undefined) this.statusState.set('saved');
      }
      return true;
    }
    // Newer edits already scheduled another attempt, which will report its own outcome.
    if (tracked.pending === deck) {
      this.errorState.set(result.error);
      this.statusState.set('error');
    }
    return false;
  }
}
