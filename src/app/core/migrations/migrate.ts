import { err, ok, SCHEMA_VERSION, validateDeck, type Deck, type Result, type ValidationError, type ValidationOptions } from '../model';
import type { BackupSink } from './backup';
import { MIGRATIONS, type Migration, type RawDeck } from './migrations';

export type MigrationError =
  /** `schemaVersion` is missing or not a non-negative integer, or the input is not an object. */
  | { kind: 'invalid-version'; message: string }
  /** The registry has no step from `step`; `fromVersion` is where the document started. */
  | { kind: 'no-path'; fromVersion: number; step: number; message: string }
  /** The step from `step` threw or returned something that is not an object. */
  | { kind: 'migration-failed'; fromVersion: number; step: number; message: string }
  /** The (migrated) document is not a valid deck. */
  | { kind: 'invalid-deck'; errors: ValidationError[]; message: string }
  /** The backup sink rejected; the migrated deck was discarded. */
  | { kind: 'backup-failed'; message: string }
  /** Anything else that escaped (e.g. stack overflow on absurdly nested input). */
  | { kind: 'unexpected'; message: string };

export type MigrationOutcome =
  | { readOnly: false; deck: Deck; fromVersion: number; migrated: boolean }
  | {
      /** Written by a newer app: it may be shown but must never be edited or saved back. */
      readOnly: true;
      reason: string;
      fromVersion: number;
      supportedVersion: number;
    };

export interface MigrateOptions {
  /** Defaults to the production registry; replaceable in tests. */
  migrations?: ReadonlyMap<number, Migration>;
  validation?: Partial<ValidationOptions>;
}

const isRecord = (value: unknown): value is RawDeck =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Brings an untrusted document to the current schema and validates it (arc42 §8.1). Never throws
 * and never modifies `raw`: migrations run on a private clone, so on any failure the original is
 * intact. Documents already at the current version are validated as they are (no clone).
 */
export function migrate(raw: unknown, options: MigrateOptions = {}): Result<MigrationOutcome, MigrationError> {
  try {
    return migrateDocument(raw, options);
  } catch (e) {
    return err({ kind: 'unexpected', message: `unexpected failure: ${messageOf(e)}` });
  }
}

function migrateDocument(raw: unknown, options: MigrateOptions): Result<MigrationOutcome, MigrationError> {
  if (!isRecord(raw)) {
    return err({ kind: 'invalid-version', message: 'deck must be an object' });
  }
  const version = raw['schemaVersion'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    return err({ kind: 'invalid-version', message: 'schemaVersion must be a non-negative integer' });
  }

  if (version > SCHEMA_VERSION) {
    return ok(readOnlyOutcome(version));
  }

  if (version === SCHEMA_VERSION) {
    return validated(raw, version, false, options);
  }

  let current: RawDeck;
  try {
    current = structuredClone(raw);
  } catch (e) {
    return err({ kind: 'migration-failed', fromVersion: version, step: version, message: `cannot copy deck: ${messageOf(e)}` });
  }
  const upgraded = runMigrations(current, version, SCHEMA_VERSION, options.migrations ?? MIGRATIONS);
  if (!upgraded.ok) return upgraded;
  current = upgraded.value;
  return validated(current, version, true, options);
}

/**
 * Applies the steps `from → from + 1 → … → target` in order. The caller owns `doc` (a private
 * clone); `schemaVersion` is set after each step. Exported to test the chain with a longer
 * registry than the production one.
 */
export function runMigrations(
  doc: RawDeck,
  from: number,
  target: number,
  registry: ReadonlyMap<number, Migration>,
): Result<RawDeck, MigrationError> {
  let current = doc;
  for (let v = from; v < target; v++) {
    const step = registry.get(v);
    if (!step) {
      return err({ kind: 'no-path', fromVersion: from, step: v, message: `no migration from schema version ${v} to ${v + 1}` });
    }
    try {
      const next: unknown = step(current);
      if (!isRecord(next)) {
        return err({ kind: 'migration-failed', fromVersion: from, step: v, message: `migration ${v} → ${v + 1} did not return an object` });
      }
      current = { ...next, schemaVersion: v + 1 };
    } catch (e) {
      return err({ kind: 'migration-failed', fromVersion: from, step: v, message: `migration ${v} → ${v + 1} failed: ${messageOf(e)}` });
    }
  }
  return ok(current);
}

/**
 * `migrate` for a deck loaded from storage: when it actually has to be upgraded, the untouched
 * original goes to the `BackupSink` first. If the backup fails nothing is returned but an error,
 * so the caller keeps the stored original and never overwrites it with an un-backed-up result.
 */
export async function migrateStored(
  raw: unknown,
  sink: BackupSink,
  options: MigrateOptions = {},
): Promise<Result<MigrationOutcome, MigrationError>> {
  const result = migrate(raw, options);
  if (!result.ok || result.value.readOnly || !result.value.migrated) return result;
  try {
    // A copy, so a sink that writes asynchronously never sees later changes to the caller's object.
    await sink.backup({ raw: structuredClone(raw), fromVersion: result.value.fromVersion, toVersion: SCHEMA_VERSION });
  } catch (e) {
    return err({ kind: 'backup-failed', message: `backup before migration failed: ${messageOf(e)}` });
  }
  return result;
}

function validated(
  doc: RawDeck,
  fromVersion: number,
  migrated: boolean,
  options: MigrateOptions,
): Result<MigrationOutcome, MigrationError> {
  const result = validateDeck(doc, options.validation);
  if (!result.ok) {
    return err({
      kind: 'invalid-deck',
      errors: result.error,
      message: `invalid deck: ${result.error.map((e) => `${e.path || '(root)'} ${e.message}`).slice(0, 3).join('; ')}`,
    });
  }
  return ok({ readOnly: false, deck: result.value, fromVersion, migrated });
}

function readOnlyOutcome(version: number): MigrationOutcome {
  return {
    readOnly: true,
    reason: `Deck uses schema version ${version}, newer than the supported version ${SCHEMA_VERSION}. Update DeckTech to edit it.`,
    fromVersion: version,
    supportedVersion: SCHEMA_VERSION,
  };
}
