/** Backups kept per deck: the original plus the most recent ones. */
export const MAX_BACKUPS_PER_DECK = 5;

/**
 * Which backups (given oldest first) to delete. The oldest is always kept, so a later migration can
 * never evict the only genuine pre-migration copy (DT-03 review); beyond that the newest win.
 */
export function backupsToPrune<T>(oldestFirst: readonly T[], max = MAX_BACKUPS_PER_DECK): T[] {
  if (oldestFirst.length <= max) return [];
  return oldestFirst.slice(1, oldestFirst.length - (max - 1));
}

/** The deck id inside an untrusted stored document, if it has one. */
export function deckIdOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}
