import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
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

export const DB_NAME = 'decktech';
export const DB_VERSION = 1;

interface DeckRecord {
  id: string;
  deck: unknown;
}

interface AssetRecord {
  hash: string;
  mime: string;
  /** Raw bytes rather than a Blob: structured-cloning Blobs is unreliable in some browsers. */
  data: ArrayBuffer;
}

/**
 * Small per-deck records in the `meta` store, so `list` and the concurrency check never read deck
 * bodies: `summary:<id>` and `unexported:<id>`.
 */
type MetaRecord =
  | { key: string; kind: 'summary'; summary: DeckSummary; schemaVersion: number }
  | { key: string; kind: 'unexported'; id: string; since: number }
  | { key: string; kind: 'trust'; record: TrustRecord };

type BackupRecord = StoredBackup;

interface DeckTechDB extends DBSchema {
  decks: { key: string; value: DeckRecord };
  assets: { key: string; value: AssetRecord };
  /** The component library: `{ id, entry }` per saved component. */
  components: { key: string; value: { id: string; entry: LibraryComponent } };
  meta: { key: string; value: MetaRecord };
  backups: { key: number; value: BackupRecord; indexes: { byDeck: string } };
}

type Db = IDBPDatabase<DeckTechDB>;

const SUMMARY = 'summary:';
const UNEXPORTED = 'unexported:';
const TRUST = 'trust:';
/**
 * Runs `work` on a transaction and aborts it if `work` throws, so a failure halfway through cannot
 * commit the writes that were already queued.
 */
async function abortOnError<T>(tx: { abort(): void; done: Promise<void> }, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    tx.done.catch(() => undefined);
    try {
      tx.abort();
    } catch {
      // already finished
    }
    throw e;
  }
}

/**
 * Starts several requests on one transaction. If one throws synchronously, those already started
 * are silenced (they will reject with the abort) so they cannot surface as unhandled rejections.
 */
function queueAll(requests: (() => Promise<unknown>)[]): Promise<unknown>[] {
  const started: Promise<unknown>[] = [];
  try {
    for (const start of requests) started.push(start());
  } catch (e) {
    for (const p of started) p.catch(() => undefined);
    throw e;
  }
  return started;
}

const prefixRange = (prefix: string): IDBKeyRange => IDBKeyRange.bound(prefix, prefix + '￿');

export interface IndexedDbOptions {
  /** Database name; tests use a fresh one per case. */
  name?: string;
  now?: () => number;
}

/**
 * `DeckRepository` on IndexedDB (via `idb`). Every save is one transaction over `decks` and `meta`
 * that checks the stored revision first, so two tabs cannot silently overwrite each other and blobs
 * in `assets` are never touched. Also the `BackupSink` for migrations (store `backups`).
 */
export class IndexedDbDeckRepository extends DeckRepository implements BackupSink {
  private readonly name: string;
  private readonly now: () => number;
  private dbPromise: Promise<Db> | null = null;

  constructor(options: IndexedDbOptions = {}) {
    super();
    this.name = options.name ?? DB_NAME;
    this.now = options.now ?? (() => Date.now());
  }

  /** Closes the connection; the next call reopens it. */
  async close(): Promise<void> {
    const pending = this.dbPromise;
    this.dbPromise = null;
    (await pending?.catch(() => null))?.close();
  }

  private open(): Promise<Db> {
    this.dbPromise ??= openDB<DeckTechDB>(this.name, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('decks', { keyPath: 'id' });
        db.createObjectStore('assets', { keyPath: 'hash' });
        db.createObjectStore('components', { keyPath: 'id' });
        db.createObjectStore('meta', { keyPath: 'key' });
        db.createObjectStore('backups', { keyPath: 'seq', autoIncrement: true }).createIndex('byDeck', 'deckId');
      },
      // Another tab wants to upgrade, or the browser closed the connection: reopen on next use.
      blocking: () => void this.close(),
      terminated: () => {
        this.dbPromise = null;
      },
    }).catch((e: unknown) => {
      this.dbPromise = null;
      throw e;
    });
    return this.dbPromise;
  }

  /** Runs `fn`, turning anything thrown into a `PersistenceError`. */
  private async guard<T>(fn: (db: Db) => Promise<Result<T, PersistenceError>>): Promise<Result<T, PersistenceError>> {
    try {
      return await fn(await this.open());
    } catch (e) {
      return err(toPersistenceError(e));
    }
  }

  list(): Promise<Result<DeckSummary[], PersistenceError>> {
    return this.guard(async (db) => {
      const records = await db.getAll('meta', prefixRange(SUMMARY));
      const summaries = records.flatMap((r) => (r.kind === 'summary' ? [r.summary] : []));
      return ok(summaries);
    });
  }

  async load(id: string): Promise<Result<LoadedDeck, LoadError>> {
    let raw: DeckRecord | undefined;
    let meta: MetaRecord | undefined;
    try {
      const db = await this.open();
      const tx = db.transaction(['decks', 'meta'], 'readonly');
      [raw, meta] = await Promise.all([tx.objectStore('decks').get(id), tx.objectStore('meta').get(SUMMARY + id)]);
      await tx.done;
    } catch (e) {
      return err(toPersistenceError(e));
    }
    if (!raw || meta?.kind !== 'summary') return err({ kind: 'not-found', message: `deck "${id}" does not exist` });
    const outcome = await migrateStored(raw.deck, this);
    if (!outcome.ok) return outcome;
    return ok({ outcome: outcome.value, revision: meta.summary.revision });
  }

  save(deck: Deck, expectedRevision: number | null): Promise<Result<number, PersistenceError>> {
    if (deck.schemaVersion !== SCHEMA_VERSION) {
      return Promise.resolve(
        err({ kind: 'invalid', message: `cannot save schema version ${deck.schemaVersion}; current is ${SCHEMA_VERSION}` }),
      );
    }
    return this.guard(async (db) => {
      const tx = db.transaction(['decks', 'meta'], 'readwrite');
      return abortOnError(tx, async () => {
        const meta = tx.objectStore('meta');
        const [existing, unexported] = await Promise.all([meta.get(SUMMARY + deck.id), meta.getKey(UNEXPORTED + deck.id)]);
        const stored = existing?.kind === 'summary' ? existing : undefined;

        let refusal: PersistenceError | undefined;
        if (stored && stored.schemaVersion > SCHEMA_VERSION) {
          refusal = { kind: 'read-only', message: `deck "${deck.id}" was written by a newer version and is read-only` };
        } else if (stored ? expectedRevision !== stored.summary.revision : expectedRevision !== null) {
          refusal = { kind: 'conflict', message: `deck "${deck.id}" was changed elsewhere since it was loaded` };
        }
        if (refusal) {
          // Nothing was written; let the transaction finish empty.
          await tx.done;
          return err(refusal);
        }

        const revision = (stored?.summary.revision ?? 0) + 1;
        const updatedAt = this.now();
        const writes = [
          () => tx.objectStore('decks').put({ id: deck.id, deck }),
          () =>
            meta.put({
              key: SUMMARY + deck.id,
              kind: 'summary',
              summary: { id: deck.id, title: deck.title, updatedAt, revision },
              schemaVersion: deck.schemaVersion,
            }),
        ];
        if (unexported === undefined) {
          writes.push(() => meta.put({ key: UNEXPORTED + deck.id, kind: 'unexported', id: deck.id, since: updatedAt }));
        }
        await Promise.all([...queueAll(writes), tx.done]);
        return ok(revision);
      });
    });
  }

  delete(id: string): Promise<Result<void, PersistenceError>> {
    return this.guard(async (db) => {
      const tx = db.transaction(['decks', 'meta', 'backups'], 'readwrite');
      return abortOnError(tx, async () => {
        const doomed = await tx.objectStore('backups').index('byDeck').getAllKeys(id);
        const removals = [
          () => tx.objectStore('decks').delete(id),
          () => tx.objectStore('meta').delete(SUMMARY + id),
          () => tx.objectStore('meta').delete(UNEXPORTED + id),
          () => tx.objectStore('meta').delete(TRUST + id),
          ...doomed.map((seq) => () => tx.objectStore('backups').delete(seq)),
        ];
        await Promise.all([...queueAll(removals), tx.done]);
        return ok(undefined);
      });
    });
  }

  async putAsset(blob: Blob): Promise<Result<StoredAsset, PersistenceError>> {
    const mime = checkMime(blob.type);
    if (!mime.ok) return mime;
    return this.guard<StoredAsset>(async (db) => {
      const data = await readBytes(blob);
      const hash = await sha256Hex(data);
      const tx = db.transaction('assets', 'readwrite');
      return abortOnError(tx, async () => {
        const existing = await tx.store.get(hash);
        if (existing) {
          await tx.done;
          return ok({ ref: assetRef(hash, existing.mime, data.byteLength), created: false });
        }
        await Promise.all([tx.store.put({ hash, mime: mime.value, data }), tx.done]);
        return ok({ ref: assetRef(hash, mime.value, data.byteLength), created: true });
      });
    });
  }

  getAsset(id: string): Promise<Result<Blob, PersistenceError>> {
    return this.guard(async (db) => {
      const record = isAssetId(id) ? await db.get('assets', id) : undefined;
      if (!record) return err({ kind: 'not-found', message: `asset "${id}" does not exist` });
      return ok(new Blob([record.data], { type: record.mime }));
    });
  }

  listComponents(): Promise<Result<LibraryComponent[], PersistenceError>> {
    return this.guard(async (db) => {
      const records = await db.getAll('components');
      return ok(validLibraryEntries(records).sort((a, b) => a.savedAt - b.savedAt));
    });
  }

  async putComponent(entry: LibraryComponent): Promise<Result<void, PersistenceError>> {
    const checked = checkLibraryEntry(entry);
    if (!checked.ok) return checked;
    return this.guard(async (db) => {
      await db.put('components', { id: entry.def.id, entry: structuredClone(entry) });
      return ok(undefined);
    });
  }

  deleteComponent(id: string): Promise<Result<void, PersistenceError>> {
    return this.guard(async (db) => {
      await db.delete('components', id);
      return ok(undefined);
    });
  }

  getTrust(deckId: string): Promise<Result<TrustRecord | null, PersistenceError>> {
    return this.guard(async (db) => {
      const stored = await db.get('meta', TRUST + deckId);
      return ok(stored?.kind === 'trust' ? trustOrPending(deckId, stored.record) : null);
    });
  }

  listTrust(): Promise<Result<TrustRecord[], PersistenceError>> {
    return this.guard(async (db) => {
      const records = await db.getAll('meta', prefixRange(TRUST));
      return ok(records.flatMap((r) => (r.kind === 'trust' ? [trustOrPending(r.key.slice(TRUST.length), r.record)] : [])));
    });
  }

  async putTrust(record: TrustRecord): Promise<Result<void, PersistenceError>> {
    const checked = readTrustRecord(record);
    if (!checked) return err({ kind: 'invalid', message: 'This trust record is not valid.' });
    return this.guard(async (db) => {
      await db.put('meta', { key: TRUST + checked.deckId, kind: 'trust', record: checked });
      return ok(undefined);
    });
  }

  deleteTrust(deckId: string): Promise<Result<void, PersistenceError>> {
    return this.guard(async (db) => {
      await db.delete('meta', TRUST + deckId);
      return ok(undefined);
    });
  }

  listUnexported(): Promise<Result<UnexportedDeck[], PersistenceError>> {
    return this.guard(async (db) => {
      const records = await db.getAll('meta', prefixRange(UNEXPORTED));
      const all = records.flatMap((r) => (r.kind === 'unexported' ? [{ id: r.id, since: r.since }] : []));
      return ok(all.sort((a, b) => a.since - b.since));
    });
  }

  markExported(id: string, revision?: number): Promise<Result<void, PersistenceError>> {
    return this.guard(async (db) => {
      const tx = db.transaction('meta', 'readwrite');
      return abortOnError(tx, async () => {
        const summary = revision === undefined ? undefined : await tx.store.get(SUMMARY + id);
        if (revision === undefined || (summary?.kind === 'summary' && summary.summary.revision === revision)) {
          await tx.store.delete(UNEXPORTED + id);
        }
        await tx.done;
        return ok(undefined);
      });
    });
  }

  listBackups(deckId: string): Promise<Result<StoredBackup[], PersistenceError>> {
    return this.guard(async (db) => {
      const records = await db.getAllFromIndex('backups', 'byDeck', deckId);
      return ok(records.sort((a, b) => a.seq - b.seq));
    });
  }

  /** `BackupSink`: one transaction adds the copy and prunes old ones; rejects if it cannot be written. */
  async backup(entry: BackupEntry): Promise<void> {
    const deckId = deckIdOf(entry.raw);
    if (deckId === undefined) throw new Error('cannot back up a document without an id');
    const db = await this.open();
    const tx = db.transaction('backups', 'readwrite');
    await abortOnError(tx, async () => {
      const record: Omit<BackupRecord, 'seq'> = {
        deckId,
        fromVersion: entry.fromVersion,
        toVersion: entry.toVersion,
        createdAt: this.now(),
        raw: entry.raw,
      };
      await tx.store.add(record as BackupRecord);
      const keys = await tx.store.index('byDeck').getAllKeys(deckId);
      await Promise.all([...backupsToPrune(keys).map((seq) => tx.store.delete(seq)), tx.done]);
    });
  }
}
