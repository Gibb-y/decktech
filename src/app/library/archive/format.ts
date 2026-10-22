import { DEFAULT_VALIDATION_OPTIONS } from '../../core/model';

/** Layout of a `.deck` file (arc42 §8.5, ADR-007). */
export const ARCHIVE_FORMAT = 'decktech-deck';
export const FORMAT_VERSION = 1;
/** Written to `manifest.json` so a file says which build made it; informational only. */
export const APP_VERSION = '0.0.0';

export const DECK_ENTRY = 'deck.json';
export const MANIFEST_ENTRY = 'manifest.json';
export const THUMBNAIL_ENTRY = 'thumbnail.png';
export const ASSET_DIR = 'assets/';

export interface Manifest {
  format: typeof ARCHIVE_FORMAT;
  formatVersion: number;
  appVersion: string;
  /** `schemaVersion` of the deck at export time. */
  schemaVersion: number;
  /** Lower-case hex SHA-256 of the bytes of `deck.json`. */
  contentHash: string;
}

/** Everything the reader refuses to exceed (arc42 §8.2). Replaceable per call so tests need no huge fixtures. */
export interface ArchiveLimits {
  /** Size of the `.deck` file itself. */
  maxArchiveBytes: number;
  maxEntries: number;
  /** Uncompressed size of one asset. */
  maxEntryBytes: number;
  /** Uncompressed size of `deck.json`. */
  maxDeckBytes: number;
  /** Sum of all uncompressed entries. */
  maxTotalBytes: number;
  /** Uncompressed / compressed size an entry may have... */
  maxRatio: number;
  /** ...but only above this uncompressed size, since tiny entries legitimately compress very well. */
  ratioFloorBytes: number;
}

const MIB = 1024 * 1024;

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxArchiveBytes: 256 * MIB,
  maxEntries: DEFAULT_VALIDATION_OPTIONS.maxAssets + 3,
  maxEntryBytes: 64 * MIB,
  maxDeckBytes: 16 * MIB,
  maxTotalBytes: 256 * MIB,
  maxRatio: 200,
  ratioFloorBytes: 256 * 1024,
};

export type ArchiveErrorKind =
  | 'too-large'
  | 'too-many-entries'
  | 'zip-bomb'
  | 'bad-zip'
  | 'bad-path'
  | 'duplicate-entry'
  | 'unexpected-entry'
  | 'missing-entry'
  | 'bad-manifest'
  | 'newer-format'
  | 'hash-mismatch'
  | 'invalid-deck'
  | 'read-only'
  | 'bad-asset'
  | 'bad-mime';

/** Why a `.deck` file was not read or written; `message` is fit to show to the user. */
export interface ArchiveError {
  kind: ArchiveErrorKind;
  message: string;
}

export const archiveError = (kind: ArchiveErrorKind, message: string): ArchiveError => ({ kind, message });

/** File extension per allowed asset mime type. A spec checks it covers `allowedMimeTypes`. */
export const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'text/javascript': 'js',
  'text/css': 'css',
  'application/json': 'json',
};

/** Extension for a mime type, or `null` for one that is not on the list (inherited names such as `toString` included). */
export function extensionFor(mime: string): string | null {
  const key = mime.toLowerCase();
  return Object.hasOwn(MIME_EXTENSIONS, key) ? MIME_EXTENSIONS[key] : null;
}

export const assetEntryName = (id: string, extension: string): string => `${ASSET_DIR}${id}.${extension}`;

/** `assets/<64 hex>.<extension>`; the only shape of an asset entry the reader accepts. */
export const ASSET_ENTRY = /^assets\/([0-9a-f]{64})\.([a-z0-9]{2,5})$/;
