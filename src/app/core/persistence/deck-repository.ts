import type { MigrationError, MigrationOutcome } from '../migrations';
import type { AssetRef, Deck, Result } from '../model';
import type { PersistenceError } from './errors';
import type { LibraryComponent } from './library';

/** What the library needs to list a deck without reading its body. */
export interface DeckSummary {
  id: string;
  title: string;
  /** Epoch milliseconds of the last save. */
  updatedAt: number;
  /** Increases by one on every save; used to detect concurrent writers. */
  revision: number;
}

export interface LoadedDeck {
  /** Migrated deck, or a read-only report for a deck written by a newer app. */
  outcome: MigrationOutcome;
  /** Pass this to `save` as `expectedRevision`. */
  revision: number;
}

export interface StoredAsset {
  /** Ready to put into `Deck.assets`; `blobKey` and `hash` are the SHA-256 hex digest. */
  ref: AssetRef;
  /** False when identical content was already stored (nothing was written). */
  created: boolean;
}

/** A deck with changes that were never exported to a `.deck` file. */
export interface UnexportedDeck {
  id: string;
  /** Epoch milliseconds of the first save after the last export. */
  since: number;
}

/** A pre-migration copy of a stored deck. */
export interface StoredBackup {
  /** Increases with every backup; oldest first. */
  seq: number;
  deckId: string;
  fromVersion: number;
  toVersion: number;
  createdAt: number;
  raw: unknown;
}

export type LoadError = PersistenceError | MigrationError;

/**
 * Local-first storage of decks and assets (arc42 §8.5). Methods never reject: failures come back
 * as `PersistenceError` so callers (autosave) can react without try/catch.
 */
export abstract class DeckRepository {
  abstract list(): Promise<Result<DeckSummary[], PersistenceError>>;

  /** Loads and migrates a deck (`migrateStored`); the pre-migration version is backed up first. */
  abstract load(id: string): Promise<Result<LoadedDeck, LoadError>>;

  /**
   * Stores the deck and returns its new revision. `expectedRevision` is the revision it was loaded
   * with, or `null` for a deck that is not stored yet; any other stored state is a `conflict`.
   * A stored deck from a newer schema is never overwritten (`read-only`).
   */
  abstract save(deck: Deck, expectedRevision: number | null): Promise<Result<number, PersistenceError>>;

  /** Removes the deck, its backups and export bookkeeping. Assets are shared and stay. */
  abstract delete(id: string): Promise<Result<void, PersistenceError>>;

  /** Stores a blob under its SHA-256 digest; identical content is stored once. */
  abstract putAsset(blob: Blob): Promise<Result<StoredAsset, PersistenceError>>;
  abstract getAsset(id: string): Promise<Result<Blob, PersistenceError>>;

  /** Decks with saved changes that were not exported since, oldest first. */
  abstract listUnexported(): Promise<Result<UnexportedDeck[], PersistenceError>>;
  /**
   * Clears the un-exported mark. With `revision`, only if that is still the stored revision, so
   * a save that happened after the exported snapshot keeps the deck marked.
   */
  abstract markExported(id: string, revision?: number): Promise<Result<void, PersistenceError>>;

  /** Pre-migration backups of a deck, oldest first. */
  abstract listBackups(deckId: string): Promise<Result<StoredBackup[], PersistenceError>>;

  /** The component library (5.3), oldest first: components saved for reuse across decks. */
  abstract listComponents(): Promise<Result<LibraryComponent[], PersistenceError>>;
  /** Adds the component or replaces the one with the same definition id. An invalid entry is an `invalid` error. */
  abstract putComponent(entry: LibraryComponent): Promise<Result<void, PersistenceError>>;
  /** Removes a component from the library; an unknown id is not an error. */
  abstract deleteComponent(id: string): Promise<Result<void, PersistenceError>>;
}
