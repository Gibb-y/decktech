import { DEFAULT_VALIDATION_OPTIONS, err, ok, type AssetRef, type Result } from '../model';
import type { PersistenceError } from './errors';

const ASSET_ID = /^[0-9a-f]{64}$/;

export const isAssetId = (id: string): boolean => ASSET_ID.test(id);

/** Lower-cased mime type if it is on the import allow-list (arc42 §8.2), else an `invalid` error. */
export function checkMime(type: string): Result<string, PersistenceError> {
  const mime = type.toLowerCase();
  if (!DEFAULT_VALIDATION_OPTIONS.allowedMimeTypes.includes(mime)) {
    return err({ kind: 'invalid', message: `mime type "${type}" is not allowed for assets` });
  }
  return ok(mime);
}

export async function readBytes(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const assetRef = (hash: string, mime: string, size: number): AssetRef => ({ blobKey: hash, mime, hash, size });
