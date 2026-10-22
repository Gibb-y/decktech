import { migrateStored, type BackupEntry, type BackupSink } from '../migrations';
import { SCHEMA_VERSION, err, ok, type Deck, type Result } from '../model';
import { assetRef, checkMime, isAssetId, readBytes, sha256Hex } from './assets';
import { backupsToPrune, deckIdOf } from './backups';
import {
  DeckRepository,
  type DeckSummary,
  type LoadError,
  type LoadedDeck,
  type StoredAsset,
  type StoredBackup,
  type UnexportedDeck,
} from './deck-repository';
import { checkLibraryEntry, validLibraryEntries, type LibraryComponent } from './library';
import { toPersistenceError, type PersistenceError } from './errors';
import { readTrustRecord, trustOrPending, type TrustRecord } from './trust';

interface StoredDeck {
  summary: DeckSummary;
  schemaVersion: number;
  deck: unknown;
}

interface StoredBlob {
  mime: string;
  data: ArrayBuffer;
}

/**
 * `DeckRepository` that keeps everything in memory, for tests and as the contract reference for the
 * IndexedDB version. Like IndexedDB it stores structured clones, so callers cannot mutate stored data.
 */
export class InMemoryDeckRepository extends DeckRepository implements BackupSink {
  private readonly decks = new Map<string, StoredDeck>();
  private readonly assets = new Map<string, StoredBlob>();
  private readonly unexported = new Map<string, number>();
  private readonly trust = new Map<string, unknown>();
  private readonly backups: StoredBackup[] = [];
  private readonly library = new Map<string, { id: string; entry: LibraryComponent }>();
  private nextSeq = 1;

  constructor(private readonly now: () => number = () => Date.now()) {
    super();
  }

  /** Number of distinct blobs stored. */
  get assetCount(): number {
    return this.assets.size;
  }

  /** Test hook: stores `raw` as it would have been written by another app version. */
  seedRaw(raw: { id: string; title?: string; schemaVersion: number }): void {
    this.decks.set(raw.id, {
      summary: { id: raw.id, title: raw.title ?? '', updatedAt: this.now(), revision: 1 },
      schemaVersion: raw.schemaVersion,
      deck: structuredClone(raw),
    });
  }

  async list(): Promise<Result<DeckSummary[], PersistenceError>> {
    return ok([...this.decks.values()].map((d) => ({ ...d.summary })));
  }

  async load(id: string): Promise<Result<LoadedDeck, LoadError>> {
    const stored = this.decks.get(id);
    if (!stored) return err({ kind: 'not-found', message: `deck "${id}" does not exist` });
    const outcome = await migrateStored(structuredClone(stored.deck), this);
    if (!outcome.ok) return outcome;
    return ok({ outcome: outcome.value, revision: stored.summary.revision });
  }

  async save(deck: Deck, expectedRevision: number | null): Promise<Result<number, PersistenceError>> {
    if (deck.schemaVersion !== SCHEMA_VERSION) {
      return err({ kind: 'invalid', message: `cannot save schema version ${deck.schemaVersion}; current is ${SCHEMA_VERSION}` });
    }
    const existing = this.decks.get(deck.id);
    if (existing && existing.schemaVersion > SCHEMA_VERSION) {
      return err({ kind: 'read-only', message: `deck "${deck.id}" was written by a newer version and is read-only` });
    }
    if (existing ? expectedRevision !== existing.summary.revision : expectedRevision !== null) {
      return err({ kind: 'conflict', message: `deck "${deck.id}" was changed elsewhere since it was loaded` });
    }
    let copy: unknown;
    try {
      copy = structuredClone(deck);
    } catch (e) {
      return err(toPersistenceError(e));
    }
    const revision = (existing?.summary.revision ?? 0) + 1;
    const updatedAt = this.now();
    this.decks.set(deck.id, {
      summary: { id: deck.id, title: deck.title, updatedAt, revision },
      schemaVersion: deck.schemaVersion,
      deck: copy,
    });
    if (!this.unexported.has(deck.id)) this.unexported.set(deck.id, updatedAt);
    return ok(revision);
  }

  async delete(id: string): Promise<Result<void, PersistenceError>> {
    this.decks.delete(id);
    this.unexported.delete(id);
    this.trust.delete(id);
    for (let i = this.backups.length - 1; i >= 0; i--) {
      if (this.backups[i].deckId === id) this.backups.splice(i, 1);
    }
    return ok(undefined);
  }

  async putAsset(blob: Blob): Promise<Result<StoredAsset, PersistenceError>> {
    const mime = checkMime(blob.type);
    if (!mime.ok) return mime;
    const data = await readBytes(blob);
    const hash = await sha256Hex(data);
    const existing = this.assets.get(hash);
    if (existing) return ok({ ref: assetRef(hash, existing.mime, data.byteLength), created: false });
    this.assets.set(hash, { mime: mime.value, data: data.slice(0) });
    return ok({ ref: assetRef(hash, mime.value, data.byteLength), created: true });
  }

  async getAsset(id: string): Promise<Result<Blob, PersistenceError>> {
    const stored = isAssetId(id) ? this.assets.get(id) : undefined;
    if (!stored) return err({ kind: 'not-found', message: `asset "${id}" does not exist` });
    return ok(new Blob([stored.data.slice(0)], { type: stored.mime }));
  }

  async listComponents(): Promise<Result<LibraryComponent[], PersistenceError>> {
    return ok(validLibraryEntries([...this.library.values()]).sort((a, b) => a.savedAt - b.savedAt));
  }

  async putComponent(entry: LibraryComponent): Promise<Result<void, PersistenceError>> {
    const checked = checkLibraryEntry(entry);
    if (!checked.ok) return checked;
    this.library.set(entry.def.id, { id: entry.def.id, entry: structuredClone(entry) });
    return ok(undefined);
  }

  async deleteComponent(id: string): Promise<Result<void, PersistenceError>> {
    this.library.delete(id);
    return ok(undefined);
  }

  async getTrust(deckId: string): Promise<Result<TrustRecord | null, PersistenceError>> {
    const stored = this.trust.get(deckId);
    return ok(stored === undefined ? null : trustOrPending(deckId, stored));
  }

  async listTrust(): Promise<Result<TrustRecord[], PersistenceError>> {
    return ok([...this.trust].map(([id, stored]) => trustOrPending(id, stored)));
  }

  async putTrust(record: TrustRecord): Promise<Result<void, PersistenceError>> {
    const checked = readTrustRecord(record);
    if (!checked) return err({ kind: 'invalid', message: 'This trust record is not valid.' });
    this.trust.set(checked.deckId, checked);
    return ok(undefined);
  }

  async deleteTrust(deckId: string): Promise<Result<void, PersistenceError>> {
    this.trust.delete(deckId);
    return ok(undefined);
  }

  async listUnexported(): Promise<Result<UnexportedDeck[], PersistenceError>> {
    const all = [...this.unexported].map(([id, since]) => ({ id, since }));
    return ok(all.sort((a, b) => a.since - b.since));
  }

  async markExported(id: string, revision?: number): Promise<Result<void, PersistenceError>> {
    if (revision === undefined || this.decks.get(id)?.summary.revision === revision) this.unexported.delete(id);
    return ok(undefined);
  }

  async listBackups(deckId: string): Promise<Result<StoredBackup[], PersistenceError>> {
    return ok(this.backups.filter((b) => b.deckId === deckId).map((b) => ({ ...b, raw: structuredClone(b.raw) })));
  }

  /** `BackupSink`: rejects when the document has no id to file it under. */
  async backup(entry: BackupEntry): Promise<void> {
    const deckId = deckIdOf(entry.raw);
    if (deckId === undefined) throw new Error('cannot back up a document without an id');
    this.backups.push({
      seq: this.nextSeq++,
      deckId,
      fromVersion: entry.fromVersion,
      toVersion: entry.toVersion,
      createdAt: this.now(),
      raw: structuredClone(entry.raw),
    });
    const mine = this.backups.filter((b) => b.deckId === deckId);
    const doomed = new Set(backupsToPrune(mine));
    if (doomed.size > 0) {
      const kept = this.backups.filter((b) => !doomed.has(b));
      this.backups.length = 0;
      this.backups.push(...kept);
    }
  }
}
