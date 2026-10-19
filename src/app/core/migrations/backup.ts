/** The stored deck as it was before a migration touched it. */
export interface BackupEntry {
  /** The untouched pre-migration document. The sink must copy it if it keeps it asynchronously. */
  raw: unknown;
  fromVersion: number;
  toVersion: number;
}

/**
 * Receives the pre-migration version of a stored deck so a rolling backup is kept (arc42 §8.9).
 * Implemented by persistence (DT-04); core only depends on this interface. Rejecting aborts the
 * migration: a migrated deck is never handed out unless its backup was written.
 */
export interface BackupSink {
  backup(entry: BackupEntry): Promise<void>;
}
