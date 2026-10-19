/** Everything a repository can report instead of throwing. Quota and storage errors are retryable. */
export type PersistenceError =
  /** No deck / asset with that id. */
  | { kind: 'not-found'; message: string }
  /** The stored deck changed since it was loaded (another tab), or exists / is gone unexpectedly. */
  | { kind: 'conflict'; message: string }
  /** The stored deck was written by a newer app version and must not be overwritten. */
  | { kind: 'read-only'; message: string }
  /** The deck or asset handed in is not acceptable (wrong schema version, mime type not allowed). */
  | { kind: 'invalid'; message: string }
  /** The browser refused the write for lack of space. */
  | { kind: 'quota'; message: string }
  /** Any other IndexedDB failure (blocked, closed, private mode, ...). */
  | { kind: 'storage'; message: string };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Maps a thrown storage error to a `PersistenceError`; `QuotaExceededError` becomes `quota`. */
export function toPersistenceError(e: unknown): PersistenceError {
  const name = typeof e === 'object' && e !== null && 'name' in e ? (e as { name: unknown }).name : undefined;
  if (name === 'QuotaExceededError') {
    return { kind: 'quota', message: 'storage quota exceeded' };
  }
  return { kind: 'storage', message: messageOf(e) };
}
