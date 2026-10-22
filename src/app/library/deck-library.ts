import { Service, computed, inject, signal } from '@angular/core';
import { createDeck, err, generateId, ok, type Deck, type Result } from '../core/model';
import { DeckRepository, toPersistenceError, type DeckSummary } from '../core/persistence';
import { DeckArchive, type ExportOutcome, type ImportedDeck } from './archive';
import { BUILT_IN_TEMPLATES, instantiateTemplate } from './templates';

export const MAX_TITLE_LENGTH = 200;

/** Why a library operation did not happen; `message` is fit to show to the user. */
export interface LibraryError {
  message: string;
}

export type LibraryStatus = 'loading' | 'ready' | 'error';

const fail = (message: string) => err<LibraryError>({ message });

/** Title as stored: trimmed, non-empty and not absurdly long. */
export function checkTitle(raw: string): Result<string, LibraryError> {
  const title = raw.trim();
  if (title === '') return fail('Enter a title.');
  if (title.length > MAX_TITLE_LENGTH) return fail(`Titles can be at most ${MAX_TITLE_LENGTH} characters.`);
  return ok(title);
}

/**
 * The deck list behind the home screen: reads summaries from the `DeckRepository` and creates,
 * renames, duplicates and deletes decks. Operations run one at a time, apply to storage first and
 * refresh the list only when storage accepted them, so a failure leaves the list as it was.
 */
@Service()
export class DeckLibrary {
  private readonly repository = inject(DeckRepository);
  private readonly archive = inject(DeckArchive);

  private readonly decksState = signal<DeckSummary[]>([]);
  private readonly statusState = signal<LibraryStatus>('loading');
  private readonly busyState = signal(false);

  /** Most recently modified first. */
  readonly decks = computed(() => [...this.decksState()].sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)));
  readonly status = this.statusState.asReadonly();
  readonly busy = this.busyState.asReadonly();
  readonly templates = BUILT_IN_TEMPLATES;

  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;

  /** Reads the list; the previous list stays visible while a later read fails. */
  refresh(): Promise<Result<void, LibraryError>> {
    return this.enqueue(() => this.reload());
  }

  createBlank(title = 'Untitled deck'): Promise<Result<Deck, LibraryError>> {
    return this.enqueue(() => this.store(createDeck(title)));
  }

  createFromTemplate(templateId: string): Promise<Result<Deck, LibraryError>> {
    return this.enqueue(async () => {
      const template = this.templates.find((t) => t.id === templateId);
      if (!template) return fail(`Unknown template "${templateId}".`);
      const deck = instantiateTemplate(template);
      return deck.ok ? this.store(deck.value) : fail(deck.error);
    });
  }

  rename(id: string, rawTitle: string): Promise<Result<void, LibraryError>> {
    return this.enqueue(async () => {
      const title = checkTitle(rawTitle);
      if (!title.ok) return title;
      const loaded = await this.writable(id);
      if (!loaded.ok) return loaded;
      const { deck, revision } = loaded.value;
      if (deck.title === title.value) return ok(undefined);
      const saved = await this.repository.save({ ...deck, title: title.value }, revision);
      if (!saved.ok) return fail(`Could not rename the deck: ${saved.error.message}`);
      return this.reloadAfter(undefined);
    });
  }

  duplicate(id: string): Promise<Result<Deck, LibraryError>> {
    return this.enqueue(async () => {
      const loaded = await this.writable(id);
      if (!loaded.ok) return loaded;
      const { deck } = loaded.value;
      // Only the deck id changes: other ids are scoped to their deck, and assets are shared by hash.
      const copy: Deck = { ...structuredClone(deck), id: generateId('deck'), title: `Copy of ${deck.title}`.slice(0, MAX_TITLE_LENGTH) };
      // The copy has the code of the original, so it has the original's decisions too: without
      // them duplicating an imported deck would switch its code on (arc42 §6.4).
      const trust = await this.repository.getTrust(id);
      if (!trust.ok) return fail(`Could not read your trust decisions: ${trust.error.message}`);
      if (trust.value) {
        const copied = await this.repository.putTrust({ ...trust.value, deckId: copy.id });
        if (!copied.ok) return fail(`Could not copy the trust decisions: ${copied.error.message}`);
      }
      const stored = await this.store(copy);
      if (!stored.ok && trust.value) await this.repository.deleteTrust(copy.id);
      return stored;
    });
  }

  /** Lets the user choose a `.deck` file. Not queued: a dialog can stay open for long and blocks nothing. */
  pickFile(): Promise<File | null> {
    return this.archive.pickFile();
  }

  /**
   * Imports a `.deck` file as a new, untrusted deck (arc42 §6.4). The file is verified completely
   * before anything is stored, so a rejected file leaves the library as it was.
   */
  importFile(file: File): Promise<Result<ImportedDeck, LibraryError>> {
    return this.enqueue(async () => {
      const imported = await this.archive.importFile(file);
      if (!imported.ok) return imported;
      // The deck is stored whatever the refresh does, like `store`.
      await this.reload();
      return imported;
    });
  }

  /** Writes one deck to a `.deck` file. */
  exportDeck(id: string): Promise<Result<ExportOutcome, LibraryError>> {
    return this.enqueue(() => this.archive.exportStored(id));
  }

  /** Writes every deck into one ZIP of `.deck` files. */
  exportAll(): Promise<Result<ExportOutcome, LibraryError>> {
    return this.enqueue(() => this.archive.exportAll());
  }

  /** Deleting a deck written by a newer version is allowed: the user may want it gone. */
  remove(id: string): Promise<Result<void, LibraryError>> {
    return this.enqueue(async () => {
      const deleted = await this.repository.delete(id);
      if (!deleted.ok) return fail(`Could not delete the deck: ${deleted.error.message}`);
      return this.reloadAfter(undefined);
    });
  }

  /** Saves a new deck, then refreshes the list. The deck is returned even if only the refresh failed. */
  private async store(deck: Deck): Promise<Result<Deck, LibraryError>> {
    const saved = await this.repository.save(deck, null);
    if (!saved.ok) return fail(`Could not save the deck: ${saved.error.message}`);
    await this.reload();
    return ok(deck);
  }

  private async reloadAfter<T>(value: T): Promise<Result<T, LibraryError>> {
    const reloaded = await this.reload();
    return reloaded.ok ? ok(value) : reloaded;
  }

  private async writable(id: string): Promise<Result<{ deck: Deck; revision: number }, LibraryError>> {
    const loaded = await this.repository.load(id);
    if (!loaded.ok) return fail(`Could not open the deck: ${loaded.error.message}`);
    const { outcome, revision } = loaded.value;
    if (outcome.readOnly) return fail('This deck was made with a newer version of DeckTech and cannot be changed here.');
    return ok({ deck: outcome.deck, revision });
  }

  private async reload(): Promise<Result<void, LibraryError>> {
    const listed = await this.repository.list();
    if (!listed.ok) {
      if (this.statusState() === 'loading') this.statusState.set('error');
      return fail(`Could not read your decks: ${listed.error.message}`);
    }
    this.decksState.set(listed.value);
    this.statusState.set('ready');
    return ok(undefined);
  }

  /** Runs `task` after everything queued before it; never rejects. */
  private enqueue<T>(task: () => Promise<Result<T, LibraryError>>): Promise<Result<T, LibraryError>> {
    const run = async (): Promise<Result<T, LibraryError>> => {
      try {
        return await task();
      } catch (e) {
        return fail(toPersistenceError(e).message);
      } finally {
        this.pending--;
        this.busyState.set(this.pending > 0);
      }
    };
    this.pending++;
    this.busyState.set(true);
    const result = this.chain.then(run, run);
    this.chain = result;
    return result;
  }
}
