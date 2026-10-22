import { Service, inject } from '@angular/core';
import { zipSync, type Zippable } from 'fflate';
import { err, generateId, ok, type Deck, type Result } from '../../core/model';
import { DeckRepository, pendingRecord, previousSnapshots } from '../../core/persistence';
import { FileAccess } from './file-access';
import { DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits } from './format';
import { readArchive } from './reader';
import { writeArchive } from './writer';

/** Why an import or export did not happen; `message` is fit to show to the user. */
export interface ArchiveFailure {
  message: string;
}

const fail = (message: string) => err<ArchiveFailure>({ message });

export interface ImportedDeck {
  /** The deck as stored; its id differs from the file's when the library already had that id. */
  deck: Deck;
  /** The deck contains code components: it must not run before the user has decided (arc42 §6.4, ADR-008). */
  hasCode: boolean;
  /** SHA-256 of `deck.json`; trust is bound to it. */
  hash: string;
  /** The deck id inside the file; trust decisions about earlier imports of it are looked up by this. */
  sourceId: string;
  /** Always true: a deck that came from a file is untrusted until the user decides (a pending `TrustRecord` when it has code). */
  untrusted: true;
  /** The file's deck id was taken, so the copy got a new one. */
  renamed: boolean;
  migrated: boolean;
}

export interface ExportOutcome {
  fileName: string;
  /** The user dismissed the save dialog; nothing was written. */
  cancelled: boolean;
  /** Decks left out of an "export all" (newer than this app), by title. */
  skipped: string[];
  count: number;
}

const BUNDLE_NAME = 'decktech-decks.zip';

/** `My talk: 2026!` → `My-talk-2026`; never empty. */
export function fileStem(title: string): string {
  const stem = title.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '') || 'deck';
  // Windows refuses these device names as file names.
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem) ? `_${stem}` : stem;
}

/**
 * Moves decks in and out of `.deck` files (arc42 §6.4, §8.5): reads asset bytes from the
 * `DeckRepository`, packs them with `writeArchive` and hands the file to `FileAccess`; the other
 * way round, a file goes through `readArchive` completely before anything is stored, so a rejected
 * file changes nothing (apart from unreferenced blobs, see `importBytes`).
 */
@Service()
export class DeckArchive {
  private readonly repository = inject(DeckRepository);
  private readonly files = inject(FileAccess);

  /** Lets the user choose a file to import; `null` when they dismiss the dialog. */
  pickFile(): Promise<File | null> {
    return this.files.open();
  }

  /** Exports a stored deck and, once the file is written, clears its "not exported" mark. */
  async exportStored(id: string): Promise<Result<ExportOutcome, ArchiveFailure>> {
    const loaded = await this.repository.load(id);
    if (!loaded.ok) return fail(`Could not open the deck: ${loaded.error.message}`);
    if (loaded.value.outcome.readOnly) return fail('This deck was made with a newer version of DeckTech and cannot be exported here.');
    const { deck } = loaded.value.outcome;
    const bytes = await this.pack(deck);
    if (!bytes.ok) return bytes;
    const fileName = `${fileStem(deck.title)}.deck`;
    const outcome = await this.save(fileName, bytes.value);
    if (!outcome.ok) return outcome;
    if (!outcome.value) return ok({ fileName, cancelled: true, skipped: [], count: 0 });
    await this.repository.markExported(id, loaded.value.revision);
    return ok({ fileName, cancelled: false, skipped: [], count: 1 });
  }

  /**
   * Every stored deck as a `.deck` file inside one ZIP (browsers ask before several downloads, and
   * one file is one backup). A deck from a newer version is left out and named in `skipped`.
   */
  async exportAll(): Promise<Result<ExportOutcome, ArchiveFailure>> {
    const listed = await this.repository.list();
    if (!listed.ok) return fail(`Could not read your decks: ${listed.error.message}`);
    if (listed.value.length === 0) return fail('You have no decks to export.');
    const bundle: Zippable = {};
    const exported: { id: string; revision: number }[] = [];
    const skipped: string[] = [];
    for (const summary of listed.value) {
      const loaded = await this.repository.load(summary.id);
      if (!loaded.ok) return fail(`Could not open "${summary.title}": ${loaded.error.message}`);
      if (loaded.value.outcome.readOnly) {
        skipped.push(summary.title);
        continue;
      }
      const { deck } = loaded.value.outcome;
      const bytes = await this.pack(deck);
      if (!bytes.ok) return fail(`"${deck.title}": ${bytes.error.message}`);
      // The id keeps two decks with the same title apart.
      bundle[`${fileStem(deck.title)}-${deck.id}.deck`] = [bytes.value, { level: 0 }];
      exported.push({ id: deck.id, revision: loaded.value.revision });
    }
    if (exported.length === 0) return fail('None of your decks can be exported with this version of DeckTech.');
    const outcome = await this.save(BUNDLE_NAME, zipSync(bundle));
    if (!outcome.ok) return outcome;
    if (!outcome.value) return ok({ fileName: BUNDLE_NAME, cancelled: true, skipped, count: 0 });
    for (const { id, revision } of exported) await this.repository.markExported(id, revision);
    return ok({ fileName: BUNDLE_NAME, cancelled: false, skipped, count: exported.length });
  }

  /** The hook of the autosave failure banner (6.5): exports the open deck as it is in memory. Throws on failure. */
  async exportOpenDeck(deck: Deck): Promise<void> {
    const bytes = await this.pack(deck);
    if (!bytes.ok) throw new Error(bytes.error.message);
    await this.files.save(`${fileStem(deck.title)}.deck`, bytes.value);
  }

  /** Reads a chosen file and stores the deck. See `importBytes`. */
  async importFile(file: File, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): Promise<Result<ImportedDeck, ArchiveFailure>> {
    // Looked at before the file is read, so a huge file is never pulled into memory.
    if (file.size > limits.maxArchiveBytes) return fail(`This file is too large to import (limit ${Math.round(limits.maxArchiveBytes / 1024 / 1024)} MiB).`);
    let data: Uint8Array;
    try {
      data = new Uint8Array(await file.arrayBuffer());
    } catch {
      return fail('The file could not be read.');
    }
    return this.importBytes(data, limits);
  }

  /**
   * Verifies the file completely (`readArchive`), then stores the assets and the deck. The deck
   * gets a new id when its id is already in the library, so an import never replaces a deck. If
   * storing fails after some assets were written, those blobs stay: the store is content-addressed
   * and shared, they are harmless, and garbage collection is not built (arc42 §8.5).
   */
  async importBytes(data: Uint8Array, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): Promise<Result<ImportedDeck, ArchiveFailure>> {
    const read = await readArchive(data, { limits });
    if (!read.ok) return fail(`This file cannot be imported. ${read.error.message}`);
    const { deck, assets, hasCode, hash, migrated } = read.value;

    const listed = await this.repository.list();
    if (!listed.ok) return fail(`Could not read your decks: ${listed.error.message}`);
    const taken = new Set(listed.value.map((d) => d.id));
    const renamed = taken.has(deck.id);
    const stored: Deck = renamed ? { ...deck, id: freshId(taken) } : deck;

    for (const [id, { ref, bytes }] of assets) {
      const put = await this.repository.putAsset(new Blob([bytes as BlobPart], { type: ref.mime }));
      if (!put.ok) return fail(`Could not store a file of the deck: ${put.error.message}`);
      if (put.value.ref.hash !== id) return fail('Could not store a file of the deck: it was stored under a different hash.');
    }
    // The "not decided yet" mark is written first: a deck must never exist without it, because a
    // deck without a record counts as made here and its code would run (arc42 §6.4).
    if (hasCode) {
      const marked = await this.markUntrusted(stored, deck.id, hash);
      if (!marked.ok) return marked;
    }
    const saved = await this.repository.save(stored, null);
    if (!saved.ok) {
      if (hasCode) await this.repository.deleteTrust(stored.id);
      return fail(`Could not save the imported deck: ${saved.error.message}`);
    }
    return ok({ deck: stored, sourceId: deck.id, hasCode, hash, untrusted: true, renamed, migrated });
  }

  /** Records that the imported deck has no decision yet, with the earlier trusted version of the same source deck as the base of the diff. */
  private async markUntrusted(stored: Deck, sourceId: string, hash: string): Promise<Result<void, ArchiveFailure>> {
    const known = await this.repository.listTrust();
    if (!known.ok) return fail(`Could not read your trust decisions: ${known.error.message}`);
    const put = await this.repository.putTrust(pendingRecord(stored.id, sourceId, hash, previousSnapshots(known.value, sourceId)));
    return put.ok ? ok(undefined) : fail(`Could not record that the imported deck is untrusted: ${put.error.message}`);
  }

  private async pack(deck: Deck): Promise<Result<Uint8Array, ArchiveFailure>> {
    const bytes = new Map<string, Uint8Array>();
    for (const id of Object.keys(deck.assets)) {
      const blob = await this.repository.getAsset(id);
      if (!blob.ok) return fail(`Could not read a file of the deck: ${blob.error.message}`);
      bytes.set(id, new Uint8Array(await blob.value.arrayBuffer()));
    }
    const packed = await writeArchive(deck, bytes);
    return packed.ok ? packed : fail(packed.error.message);
  }

  /** `true` when written, `false` when the user dismissed the dialog. */
  private async save(name: string, bytes: Uint8Array): Promise<Result<boolean, ArchiveFailure>> {
    try {
      return ok((await this.files.save(name, bytes)) === 'saved');
    } catch (e) {
      return fail(`Could not save the file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function freshId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = generateId('deck');
    if (!taken.has(id)) return id;
  }
}
