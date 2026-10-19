import { SCHEMA_VERSION, type Deck } from '../model';
import type { BackupEntry, BackupSink } from './backup';
import { DECK_V0, DECK_V1, deepFreeze } from './fixtures';
import { migrate, migrateStored, runMigrations, type MigrationError } from './migrate';
import { MIGRATIONS, migrateV0ToV1, type Migration, type RawDeck } from './migrations';

function errorOf(result: ReturnType<typeof migrate>): MigrationError {
  if (result.ok) throw new Error('expected an error result');
  return result.error;
}

function deckOf(result: ReturnType<typeof migrate>): Deck {
  if (!result.ok || result.value.readOnly) throw new Error('expected an editable deck');
  return result.value.deck;
}

describe('migration registry', () => {
  it('has a step for every version below SCHEMA_VERSION and none above', () => {
    const versions = [...MIGRATIONS.keys()].sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: SCHEMA_VERSION }, (_, i) => i));
  });

  it('fixtures: the newest fixture is valid at the current version', () => {
    const result = migrate(DECK_V1);
    expect(result.ok).toBe(true);
    expect(DECK_V1['schemaVersion']).toBe(SCHEMA_VERSION);
  });
});

describe('migrateV0ToV1', () => {
  it('adds stage and components and keeps everything else', () => {
    const out = migrateV0ToV1(DECK_V0);
    expect(out['stage']).toEqual({ width: 1920, height: 1080 });
    expect(out['components']).toEqual([]);
    expect(out['slides']).toEqual(DECK_V0['slides']);
    expect(out['assets']).toEqual(DECK_V0['assets']);
  });

  it('does not mutate its (frozen) input', () => {
    expect(() => migrateV0ToV1(DECK_V0)).not.toThrow();
    expect(DECK_V0).not.toHaveProperty('stage');
  });

  it('keeps a stage and components that v0 data already had', () => {
    const stage = { width: 1280, height: 1080 };
    const components = [{ id: 'cp_1' }];
    const out = migrateV0ToV1({ ...DECK_V0, stage, components });
    expect(out['stage']).toBe(stage);
    expect(out['components']).toBe(components);
  });
});

describe('runMigrations', () => {
  const stamp =
    (name: string): Migration =>
    (deck) => ({ ...deck, trail: [...((deck['trail'] as string[] | undefined) ?? []), name] });

  it('runs the steps in order and stamps schemaVersion after each', () => {
    const seen: number[] = [];
    const registry = new Map<number, Migration>([
      [1, (d) => (seen.push(d['schemaVersion'] as number), stamp('1→2')(d))],
      [2, (d) => (seen.push(d['schemaVersion'] as number), stamp('2→3')(d))],
      [3, (d) => (seen.push(d['schemaVersion'] as number), stamp('3→4')(d))],
    ]);
    const result = runMigrations({ schemaVersion: 1 }, 1, 4, registry);
    expect(result).toEqual({ ok: true, value: { schemaVersion: 4, trail: ['1→2', '2→3', '3→4'] } });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('overrides a schemaVersion the step wrote itself', () => {
    const registry = new Map<number, Migration>([[0, (d) => ({ ...d, schemaVersion: 99 })]]);
    expect(runMigrations({}, 0, 1, registry)).toEqual({ ok: true, value: { schemaVersion: 1 } });
  });

  it('reports a gap in the chain and runs nothing after it', () => {
    const second = vi.fn<Migration>((d) => d);
    const registry = new Map<number, Migration>([[2, second]]);
    const result = runMigrations({}, 1, 3, registry);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'no-path', fromVersion: 1, message: 'no migration from schema version 1 to 2' },
    });
    expect(second).not.toHaveBeenCalled();
  });

  it('turns a throwing step into an error naming the step', () => {
    const registry = new Map<number, Migration>([
      [0, () => { throw new Error('boom'); }],
    ]);
    expect(runMigrations({}, 0, 1, registry)).toEqual({
      ok: false,
      error: { kind: 'migration-failed', fromVersion: 0, message: 'migration 0 → 1 failed: boom' },
    });
  });

  it.each([[null], [[]], ['text'], [undefined]])('rejects a step returning %j', (bad) => {
    const registry = new Map<number, Migration>([[0, () => bad as unknown as RawDeck]]);
    expect(runMigrations({}, 0, 1, registry)).toEqual({
      ok: false,
      error: { kind: 'migration-failed', fromVersion: 0, message: 'migration 0 → 1 did not return an object' },
    });
  });
});

describe('migrate', () => {
  it('upgrades the v0 fixture to exactly the v1 fixture', () => {
    const result = migrate(DECK_V0);
    expect(result.ok && result.value).toMatchObject({ readOnly: false, fromVersion: 0, migrated: true });
    expect(deckOf(result)).toEqual(DECK_V1);
  });

  it('does not touch the original (deep-frozen) input, and returns a separate object', () => {
    const deck = deckOf(migrate(DECK_V0));
    expect(deck).not.toBe(DECK_V0);
    expect(deck.slides).not.toBe(DECK_V0['slides']);
    expect(DECK_V0['schemaVersion']).toBe(0);
    expect(DECK_V0).not.toHaveProperty('components');
  });

  it('validates a current-version deck as is, without copying it', () => {
    const result = migrate(DECK_V1);
    expect(result.ok && result.value).toMatchObject({ readOnly: false, fromVersion: 1, migrated: false });
    expect(deckOf(result)).toBe(DECK_V1);
  });

  it('is idempotent: migrating the output changes nothing', () => {
    const once = deckOf(migrate(DECK_V0));
    expect(deckOf(migrate(once))).toEqual(once);
  });

  it('does not use a custom migrations map when the version is current', () => {
    const step = vi.fn<Migration>((d) => d);
    migrate(DECK_V1, { migrations: new Map([[0, step]]) });
    expect(step).not.toHaveBeenCalled();
  });

  describe('newer versions', () => {
    const newer = (extra: RawDeck = {}): RawDeck => deepFreeze({ ...structuredClone(DECK_V1), schemaVersion: SCHEMA_VERSION + 1, ...extra });

    it('opens read-only with a reason, without throwing or mutating', () => {
      const raw = newer();
      const result = migrate(raw);
      expect(result.ok).toBe(true);
      if (!result.ok || !result.value.readOnly) throw new Error('expected read-only');
      expect(result.value.reason).toContain(`schema version ${SCHEMA_VERSION + 1}`);
      expect(result.value.fromVersion).toBe(SCHEMA_VERSION + 1);
      expect(result.value.supportedVersion).toBe(SCHEMA_VERSION);
      expect(result.value.deck?.title).toBe('Fixture deck');
      expect(result.value.deck?.schemaVersion).toBe(SCHEMA_VERSION + 1);
      expect(raw['schemaVersion']).toBe(SCHEMA_VERSION + 1);
    });

    it('gives no deck when the content no longer fits the current schema', () => {
      const result = migrate(newer({ somethingNew: true }));
      expect(result.ok && result.value).toMatchObject({ readOnly: true, deck: null });
    });

    it('handles absurdly high versions', () => {
      const result = migrate(newer({ schemaVersion: Number.MAX_SAFE_INTEGER }));
      expect(result.ok && result.value).toMatchObject({ readOnly: true });
    });
  });

  describe('failures', () => {
    it.each([
      ['null', null],
      ['an array', []],
      ['a string', 'deck'],
      ['no schemaVersion', {}],
      ['a string version', { schemaVersion: '1' }],
      ['a negative version', { schemaVersion: -1 }],
      ['a fractional version', { schemaVersion: 0.5 }],
      ['NaN', { schemaVersion: NaN }],
      ['Infinity', { schemaVersion: Infinity }],
      ['an unsafe integer', { schemaVersion: 2 ** 60 }],
    ])('rejects %s', (_name, raw) => {
      expect(errorOf(migrate(raw)).kind).toBe('invalid-version');
    });

    it('reports a version with no registered path', () => {
      const error = errorOf(migrate(DECK_V0, { migrations: new Map() }));
      expect(error).toEqual({ kind: 'no-path', fromVersion: 0, message: 'no migration from schema version 0 to 1' });
    });

    it('returns an error and leaves the original untouched when a step throws midway', () => {
      const raw = structuredClone(DECK_V0);
      const before = structuredClone(raw);
      const bad: Migration = (d) => {
        (d as RawDeck)['title'] = 'mutated by a careless step';
        throw new Error('half done');
      };
      const error = errorOf(migrate(raw, { migrations: new Map([[0, bad]]) }));
      expect(error).toMatchObject({ kind: 'migration-failed', message: 'migration 0 → 1 failed: half done' });
      expect(raw).toEqual(before);
    });

    it('protects the original even from a step that mutates in place and succeeds', () => {
      const raw = structuredClone(DECK_V0);
      const before = structuredClone(raw);
      const impure: Migration = (d) => { (d['slides'] as unknown[]).length = 0; return d; };
      migrate(raw, { migrations: new Map([[0, impure]]) });
      expect(raw).toEqual(before);
    });

    it('reports a migrated but invalid deck with validation paths', () => {
      const raw = { ...structuredClone(DECK_V0), slides: [{ id: 'sl_1', layoutId: 'missing', notes: '', elements: [] }] };
      const error = errorOf(migrate(raw));
      if (error.kind !== 'invalid-deck') throw new Error(`unexpected ${error.kind}`);
      expect(error.errors.map((e) => e.path)).toContain('slides[0].layoutId');
      expect(error.message).toContain('slides[0].layoutId');
    });

    it('reports an invalid current-version deck', () => {
      expect(errorOf(migrate({ ...structuredClone(DECK_V1), title: 5 })).kind).toBe('invalid-deck');
    });

    it('survives a document that cannot be cloned', () => {
      const raw = { ...structuredClone(DECK_V0), title: () => 'fn' };
      expect(errorOf(migrate(raw))).toMatchObject({ kind: 'migration-failed', fromVersion: 0 });
    });

    it('treats hostile keys as plain data', () => {
      const raw = JSON.parse(JSON.stringify(DECK_V0).replace('"id":"dk_fixture"', '"__proto__":{"polluted":true},"id":"dk_fixture"'));
      const result = migrate(raw);
      expect(result.ok).toBe(false);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });
  });
});

describe('migrateStored', () => {
  function sink(impl: BackupSink['backup'] = () => Promise.resolve()) {
    const backup = vi.fn<BackupSink['backup']>(impl);
    return { backup } satisfies BackupSink;
  }

  it('hands the untouched original to the sink before returning a migrated deck', async () => {
    const s = sink();
    const result = await migrateStored(DECK_V0, s);
    expect(s.backup).toHaveBeenCalledTimes(1);
    const entry: BackupEntry = s.backup.mock.calls[0][0];
    expect(entry).toEqual({ raw: DECK_V0, fromVersion: 0, toVersion: SCHEMA_VERSION });
    expect(entry.raw).toBe(DECK_V0);
    expect(deckOf(result)).toEqual(DECK_V1);
  });

  it('does not back up current decks', async () => {
    const s = sink();
    expect((await migrateStored(DECK_V1, s)).ok).toBe(true);
    expect(s.backup).not.toHaveBeenCalled();
  });

  it('does not back up read-only newer decks', async () => {
    const s = sink();
    const result = await migrateStored({ ...structuredClone(DECK_V1), schemaVersion: SCHEMA_VERSION + 1 }, s);
    expect(result.ok && result.value.readOnly).toBe(true);
    expect(s.backup).not.toHaveBeenCalled();
  });

  it('does not back up when the migration fails', async () => {
    const s = sink();
    const result = await migrateStored(DECK_V0, s, { migrations: new Map() });
    expect(errorOf(result).kind).toBe('no-path');
    expect(s.backup).not.toHaveBeenCalled();
  });

  it('does not back up a deck that is invalid after migration', async () => {
    const s = sink();
    const result = await migrateStored({ ...structuredClone(DECK_V0), title: 5 }, s);
    expect(errorOf(result).kind).toBe('invalid-deck');
    expect(s.backup).not.toHaveBeenCalled();
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('quota exceeded'))],
    ['throws synchronously', () => { throw new Error('closed'); }],
  ])('returns an error and no deck when the sink %s', async (_name, impl) => {
    const result = await migrateStored(DECK_V0, sink(impl));
    expect(errorOf(result)).toMatchObject({ kind: 'backup-failed' });
    expect(errorOf(result).message).toMatch(/quota exceeded|closed/);
  });
});
