import { strToU8, zipSync, type Zippable } from 'fflate';
import { err, ok, type Deck, type Result } from '../../core/model';
import { sha256Hex } from '../../core/persistence/assets';
import {
  APP_VERSION,
  ARCHIVE_FORMAT,
  DECK_ENTRY,
  DEFAULT_ARCHIVE_LIMITS,
  FORMAT_VERSION,
  MANIFEST_ENTRY,
  THUMBNAIL_ENTRY,
  archiveError,
  assetEntryName,
  extensionFor,
  type ArchiveError,
  type ArchiveLimits,
  type Manifest,
} from './format';

/** 1 January 1980 UTC, the earliest ZIP time: the same deck always gives the same bytes. */
const FIXED_TIME = Date.UTC(1980, 0, 1);

const copy = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

/**
 * Packs a deck and its asset bytes into a `.deck` file: `deck.json`, `assets/<hash>.<ext>`, an
 * optional `thumbnail.png` and `manifest.json` (arc42 §8.5). Every asset is checked against its
 * hash and size first, so a damaged blob store cannot produce a file that the reader would refuse,
 * and the limits of the reader apply, so nothing is written that cannot be read back.
 */
export async function writeArchive(
  deck: Deck,
  assets: ReadonlyMap<string, Uint8Array>,
  options: { thumbnail?: Uint8Array; limits?: Partial<ArchiveLimits> } = {},
): Promise<Result<Uint8Array, ArchiveError>> {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
  const deckBytes = strToU8(JSON.stringify(deck));
  if (deckBytes.length > limits.maxDeckBytes) {
    return err(archiveError('too-large', 'The deck is too large to export.'));
  }
  const contentHash = await sha256Hex(copy(deckBytes));
  const manifest: Manifest = {
    format: ARCHIVE_FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion: APP_VERSION,
    schemaVersion: deck.schemaVersion,
    contentHash,
  };

  const entries: Zippable = {
    [DECK_ENTRY]: [deckBytes, { level: 6 }],
    [MANIFEST_ENTRY]: [strToU8(JSON.stringify(manifest)), { level: 6 }],
  };
  let total = deckBytes.length;
  for (const [id, ref] of Object.entries(deck.assets)) {
    const bytes = assets.get(id);
    if (!bytes) return err(archiveError('missing-entry', `The file of asset ${id.slice(0, 12)}… is missing, so the deck cannot be exported.`));
    const extension = extensionFor(ref.mime);
    if (extension === null) return err(archiveError('bad-mime', `Asset ${id.slice(0, 12)}… has the mime type "${ref.mime}", which is not allowed.`));
    if (bytes.length !== ref.size || (await sha256Hex(copy(bytes))) !== id) {
      return err(archiveError('hash-mismatch', `The stored file of asset ${id.slice(0, 12)}… is damaged, so the deck cannot be exported.`));
    }
    if (bytes.length > limits.maxEntryBytes) return err(archiveError('too-large', `Asset ${id.slice(0, 12)}… is too large to export.`));
    total += bytes.length;
    // Pictures, video, audio and fonts are compressed already; text compresses well.
    entries[assetEntryName(id, extension)] = [bytes, { level: ref.mime.startsWith('text/') || ref.mime === 'application/json' || ref.mime.endsWith('+xml') ? 6 : 0 }];
  }
  if (options.thumbnail) {
    entries[THUMBNAIL_ENTRY] = [options.thumbnail, { level: 0 }];
    total += options.thumbnail.length;
  }
  if (Object.keys(entries).length > limits.maxEntries || total > limits.maxTotalBytes) {
    return err(archiveError('too-large', 'The deck is too large to export.'));
  }

  const zipped = zipSync(entries, { mtime: FIXED_TIME });
  if (zipped.length > limits.maxArchiveBytes) return err(archiveError('too-large', 'The deck is too large to export.'));
  return ok(zipped);
}
