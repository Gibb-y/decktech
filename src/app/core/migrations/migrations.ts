import { STAGE_HEIGHT, STAGE_WIDTH } from '../model';

/** A raw, not yet validated deck document. */
export type RawDeck = Record<string, unknown>;

/**
 * Upgrades a document from schema version N to N+1. Must be pure: return a new object and do not
 * modify the argument (it is a private clone, so a slip cannot reach the caller's data, but
 * tests freeze the fixtures to prove purity). The runner sets `schemaVersion`, so a migration
 * only transforms the content.
 */
export type Migration = (deck: RawDeck) => RawDeck;

/**
 * v0 → v1. v0 is synthetic (no released app wrote it) and exists to exercise the chain: it had
 * no per-deck `stage` and no code `components`. Existing values are kept untouched.
 */
export const migrateV0ToV1: Migration = (deck) => ({
  ...deck,
  stage: deck['stage'] ?? { width: STAGE_WIDTH, height: STAGE_HEIGHT },
  components: deck['components'] ?? [],
});

/**
 * Registry keyed by the version a step upgrades *from*. Bumping `SCHEMA_VERSION` requires adding
 * the step from the previous version (a spec asserts the registry is contiguous).
 */
export const MIGRATIONS: ReadonlyMap<number, Migration> = new Map([[0, migrateV0ToV1]]);
