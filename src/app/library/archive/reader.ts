import { unzipSync, type UnzipFileInfo } from 'fflate';
import { err, ok, type AssetRef, type Deck, type Result } from '../../core/model';
import { migrate } from '../../core/migrations';
import { sha256Hex } from '../../core/persistence/assets';
import {
  ARCHIVE_FORMAT,
  ASSET_ENTRY,
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
import { contentProblem, isPng } from './sniff';

export interface ImportedAsset {
  ref: AssetRef;
  bytes: Uint8Array;
}

/** A `.deck` file that passed every check. Nothing in it has been stored or run. */
export interface ReadArchive {
  deck: Deck;
  /** Verified bytes per asset id; exactly the ids of `deck.assets`. */
  assets: ReadonlyMap<string, ImportedAsset>;
  thumbnail?: Uint8Array;
  /** The deck declares component definitions, so it carries code that needs a trust decision (arc42 §6.4). */
  hasCode: boolean;
  /** SHA-256 of `deck.json` as written in the file; what trust is bound to (ADR-008). */
  hash: string;
  /** The file was written by an older schema and has been migrated in memory. */
  migrated: boolean;
}

/** Thrown from inside the unzip filter to stop before anything is inflated. */
class Reject extends Error {
  constructor(readonly failure: ArchiveError) {
    super(failure.message);
  }
}

const refuse = (kind: ArchiveError['kind'], message: string): never => {
  throw new Reject(archiveError(kind, message));
};

const MIB = 1024 * 1024;
const mib = (bytes: number): string => `${Math.round((bytes / MIB) * 10) / 10} MiB`;
const shown = (name: string): string => JSON.stringify(name.length > 60 ? `${name.slice(0, 60)}…` : name);
const CONTROL = /[\u0000-\u001f\u007f]/;
const DRIVE = /^[A-Za-z]:/;

/**
 * Reads and verifies a `.deck` file (arc42 §8.2, §6.4). Never throws and has no side effects:
 * the pipeline is unzip with limits → path rules → manifest and content hash → `migrate` +
 * `validateDeck` → every asset (hash, size, mime allow-list, content). Any failure is an
 * `ArchiveError` and nothing is returned, so the caller changes no state for a rejected file.
 */
export async function readArchive(
  data: Uint8Array,
  options: { limits?: Partial<ArchiveLimits> } = {},
): Promise<Result<ReadArchive, ArchiveError>> {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
  try {
    const files = unzip(data, limits);
    if (!files.ok) return files;
    return await verify(files.value, limits);
  } catch (e) {
    return err(archiveError('bad-zip', `This file could not be read: ${e instanceof Error ? e.message : String(e)}`));
  }
}

function unzip(data: Uint8Array, limits: ArchiveLimits): Result<Record<string, Uint8Array>, ArchiveError> {
  if (data.length > limits.maxArchiveBytes) {
    return err(archiveError('too-large', `The file is ${mib(data.length)}; the limit is ${mib(limits.maxArchiveBytes)}.`));
  }
  const seen = new Set<string>();
  const declared = new Map<string, number>();
  let entries = 0;
  let total = 0;
  try {
    const files = unzipSync(data, {
      // Runs for every entry before it is inflated, using the sizes of the central directory.
      filter: (info: UnzipFileInfo) => {
        if (++entries > limits.maxEntries) refuse('too-many-entries', `The file has more than ${limits.maxEntries} entries.`);
        checkPath(info.name);
        const key = info.name.toLowerCase();
        if (seen.has(key)) refuse('duplicate-entry', `The entry ${shown(info.name)} appears more than once.`);
        seen.add(key);
        if (info.name.endsWith('/')) return false;
        checkEntryName(info.name);
        if (info.compression !== 0 && info.compression !== 8) refuse('bad-zip', `The entry ${shown(info.name)} uses an unsupported compression.`);
        const cap = info.name === DECK_ENTRY ? limits.maxDeckBytes : info.name === MANIFEST_ENTRY ? 64 * 1024 : limits.maxEntryBytes;
        if (info.originalSize > cap) {
          refuse('too-large', `The entry ${shown(info.name)} is ${mib(info.originalSize)} uncompressed; the limit is ${mib(cap)}.`);
        }
        total += info.originalSize;
        if (total > limits.maxTotalBytes) refuse('too-large', `The file unpacks to more than ${mib(limits.maxTotalBytes)}.`);
        if (info.originalSize > limits.ratioFloorBytes && info.originalSize / Math.max(info.size, 1) > limits.maxRatio) {
          refuse('zip-bomb', `The entry ${shown(info.name)} is compressed more than ${limits.maxRatio} times, which looks like a decompression bomb.`);
        }
        declared.set(info.name, info.originalSize);
        return true;
      },
    });
    // A buffer is allocated at the declared size and fills up to it, so a lie about the size cannot
    // grow memory; a shorter result means the stream ended early. A longer stream is cut and fails its hash.
    for (const [name, size] of declared) {
      if (files[name]?.length !== size) refuse('bad-zip', `The entry ${shown(name)} does not match its declared size.`);
    }
    return ok(files);
  } catch (e) {
    if (e instanceof Reject) return err(e.failure);
    return err(archiveError('bad-zip', `This is not a valid .deck file (${e instanceof Error ? e.message : String(e)}).`));
  }
}

/** Rejects names that could escape a directory or confuse a path check, before the name is looked at otherwise. */
function checkPath(name: string): void {
  const bad = (why: string): never => refuse('bad-path', `The entry ${shown(name)} has an unsafe path (${why}).`);
  if (name === '') bad('empty');
  if (name.length > 300) bad('too long');
  if (name.includes('\\')) bad('backslash');
  if (CONTROL.test(name)) bad('control character');
  if (name.startsWith('/') || DRIVE.test(name)) bad('absolute path');
  const segments = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
  for (const segment of segments) {
    if (segment === '..') bad('parent directory');
    if (segment === '.' || segment === '') bad('empty or relative segment');
  }
}

function checkEntryName(name: string): void {
  if (name === DECK_ENTRY || name === MANIFEST_ENTRY || name === THUMBNAIL_ENTRY || ASSET_ENTRY.test(name)) return;
  refuse('unexpected-entry', `The entry ${shown(name)} is not part of the .deck format.`);
}

const decode = (bytes: Uint8Array, what: string): Result<string, ArchiveError> => {
  try {
    return ok(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return err(archiveError('bad-zip', `${what} is not valid UTF-8 text.`));
  }
};

function parseJson(bytes: Uint8Array, what: string): Result<unknown, ArchiveError> {
  const text = decode(bytes, what);
  if (!text.ok) return text;
  try {
    return ok(JSON.parse(text.value));
  } catch {
    return err(archiveError(what === DECK_ENTRY ? 'invalid-deck' : 'bad-manifest', `${what} is not valid JSON.`));
  }
}

function checkManifest(value: unknown): Result<Manifest, ArchiveError> {
  const bad = (message: string) => err(archiveError('bad-manifest', `${MANIFEST_ENTRY}: ${message}`));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad('must be an object.');
  const m = value as Record<string, unknown>;
  if (m['format'] !== ARCHIVE_FORMAT) return bad('this is not a DeckTech file.');
  const version = m['formatVersion'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return bad('formatVersion must be a positive integer.');
  if (version > FORMAT_VERSION) {
    return err(archiveError('newer-format', `This file uses .deck format ${version}; this version of DeckTech reads up to ${FORMAT_VERSION}. Update DeckTech to open it.`));
  }
  if (typeof m['appVersion'] !== 'string' || m['appVersion'].length > 100) return bad('appVersion must be a short string.');
  if (typeof m['schemaVersion'] !== 'number' || !Number.isSafeInteger(m['schemaVersion'])) return bad('schemaVersion must be an integer.');
  if (typeof m['contentHash'] !== 'string' || !/^[0-9a-f]{64}$/.test(m['contentHash'])) return bad('contentHash must be a lower-case SHA-256 digest.');
  return ok({
    format: ARCHIVE_FORMAT,
    formatVersion: version,
    appVersion: m['appVersion'],
    schemaVersion: m['schemaVersion'],
    contentHash: m['contentHash'],
  });
}

async function verify(files: Record<string, Uint8Array>, limits: ArchiveLimits): Promise<Result<ReadArchive, ArchiveError>> {
  const manifestBytes = Object.hasOwn(files, MANIFEST_ENTRY) ? files[MANIFEST_ENTRY] : undefined;
  const deckBytes = Object.hasOwn(files, DECK_ENTRY) ? files[DECK_ENTRY] : undefined;
  if (!manifestBytes) return err(archiveError('missing-entry', `The file has no ${MANIFEST_ENTRY}.`));
  if (!deckBytes) return err(archiveError('missing-entry', `The file has no ${DECK_ENTRY}.`));

  const manifestJson = parseJson(manifestBytes, MANIFEST_ENTRY);
  if (!manifestJson.ok) return manifestJson;
  const manifest = checkManifest(manifestJson.value);
  if (!manifest.ok) return manifest;

  // Before parsing anything: a changed or damaged deck.json is not worth interpreting.
  const hash = await sha256Hex(copy(deckBytes));
  if (hash !== manifest.value.contentHash) {
    return err(archiveError('hash-mismatch', 'The deck does not match its content hash; the file is damaged or was changed after it was exported.'));
  }

  const raw = parseJson(deckBytes, DECK_ENTRY);
  if (!raw.ok) return raw;
  const migrated = migrate(raw.value);
  if (!migrated.ok) return err(archiveError('invalid-deck', `The deck is not valid: ${migrated.error.message}`));
  if (migrated.value.readOnly) return err(archiveError('read-only', migrated.value.reason));
  const { deck } = migrated.value;

  const assets = await verifyAssets(deck, files, limits);
  if (!assets.ok) return assets;

  const thumbnail = Object.hasOwn(files, THUMBNAIL_ENTRY) ? files[THUMBNAIL_ENTRY] : undefined;
  if (thumbnail && !isPng(thumbnail)) return err(archiveError('bad-asset', `${THUMBNAIL_ENTRY} is not a PNG image.`));

  return ok({
    deck,
    assets: assets.value,
    ...(thumbnail ? { thumbnail } : {}),
    hasCode: deck.components.length > 0,
    hash,
    migrated: migrated.value.migrated,
  });
}

async function verifyAssets(
  deck: Deck,
  files: Record<string, Uint8Array>,
  limits: ArchiveLimits,
): Promise<Result<Map<string, ImportedAsset>, ArchiveError>> {
  const result = new Map<string, ImportedAsset>();
  const entryNames = new Set<string>();
  for (const [id, ref] of Object.entries(deck.assets)) {
    const bad = (kind: ArchiveError['kind'], why: string) => err(archiveError(kind, `Asset ${id.slice(0, 12)}…: ${why}`));
    const extension = extensionFor(ref.mime);
    if (extension === null) return bad('bad-mime', `mime type "${ref.mime}" is not allowed.`);
    if (ref.hash !== id || ref.blobKey !== id) return bad('bad-asset', 'its id, hash and key differ.');
    const entry = assetEntryName(id, extension);
    entryNames.add(entry);
    const bytes = Object.hasOwn(files, entry) ? files[entry] : undefined;
    if (!bytes) return bad('missing-entry', `${entry} is missing from the file.`);
    if (bytes.length !== ref.size) return bad('bad-asset', `its size is ${bytes.length} bytes but the deck says ${ref.size}.`);
    if (bytes.length > limits.maxEntryBytes) return bad('too-large', 'it is too large.');
    const problem = contentProblem(bytes, ref.mime);
    if (problem) return bad('bad-mime', problem);
    if ((await sha256Hex(copy(bytes))) !== id) return bad('hash-mismatch', 'its content does not match its hash.');
    result.set(id, { ref: { ...ref }, bytes });
  }
  for (const name of Object.keys(files)) {
    if (ASSET_ENTRY.test(name) && !entryNames.has(name)) {
      return err(archiveError('unexpected-entry', `The entry ${shown(name)} is not used by the deck.`));
    }
  }
  return ok(result);
}

/** `crypto.subtle.digest` wants an `ArrayBuffer`; the view may sit inside a bigger one. */
const copy = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;
