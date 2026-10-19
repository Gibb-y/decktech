/** Current document schema version; bumped together with a migration. */
export const SCHEMA_VERSION = 1;

/** Default logical stage (ADR-009). */
export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;

/** Bounds for a per-deck stage; one side must still match the default (arc42 §8.1). */
export const MAX_STAGE_SIZE = 7680;
