import { err, ok, validateComponent, type AssetRef, type ComponentDef, type Result } from '../model';
import type { PersistenceError } from './errors';

/**
 * A component kept in the component library (arc42 §5.3): the definition, the refs of the assets
 * it reads (`files`, `libs`; the bytes live in the content-addressed asset store, shared by
 * every deck) and when it was saved. Lives in the `components` store, outside any deck.
 */
export interface LibraryComponent {
  def: ComponentDef;
  assets: Record<string, AssetRef>;
  /** Epoch milliseconds. */
  savedAt: number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Whether `entry` is something the library may hold: a valid definition whose assets all have a ref. */
export function libraryEntryProblem(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return 'not an object';
  const { def, assets, savedAt } = entry as Partial<LibraryComponent>;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return 'savedAt must be a number';
  if (typeof assets !== 'object' || assets === null || Array.isArray(assets)) return 'assets must be an object';
  for (const [id, ref] of Object.entries(assets)) {
    if (!SHA256_HEX.test(id) || ref?.blobKey !== id || ref?.hash !== id || typeof ref.mime !== 'string' || typeof ref.size !== 'number') return `asset "${id}" has no valid ref`;
  }
  const checked = validateComponent(def, Object.keys(assets));
  return checked.ok ? null : checked.error.map((p) => `${p.path} ${p.message}`).join('; ');
}

/** `put` side: an invalid entry is an `invalid` error, not a stored record. */
export function checkLibraryEntry(entry: LibraryComponent): Result<LibraryComponent, PersistenceError> {
  const problem = libraryEntryProblem(entry);
  return problem ? err({ kind: 'invalid', message: `This component cannot be saved to the library: ${problem}` }) : ok(entry);
}

/** `list` side: stored records are untrusted, so one that does not validate is left out instead of failing the list. */
export function validLibraryEntries(records: readonly unknown[]): LibraryComponent[] {
  return records.flatMap((record) => {
    const entry = (record as { entry?: unknown } | null)?.entry;
    return libraryEntryProblem(entry) === null ? [structuredClone(entry as LibraryComponent)] : [];
  });
}
