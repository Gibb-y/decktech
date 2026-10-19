import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { deepFreeze, DECK_V0 } from '../migrations/fixtures';
import { SCHEMA_VERSION, createDeck, type Deck } from '../model';
import type { DeckRepository } from './deck-repository';
import { MAX_BACKUPS_PER_DECK } from './backups';
import { DB_VERSION, IndexedDbDeckRepository } from './indexeddb-deck-repository';
import { InMemoryDeckRepository } from './memory-deck-repository';

interface Harness {
  repo: DeckRepository;
  clock: { now: number };
  /** Stores a document as another app version would have written it. */
  seed(raw: { id: string; title?: string; schemaVersion: number }): Promise<void>;
  assetCount(): Promise<number>;
}

let dbCounter = 0;

const factories: [string, () => Harness][] = [
  [
    'in-memory',
    () => {
      const clock = { now: 1_000 };
      const repo = new InMemoryDeckRepository(() => clock.now);
      return { repo, clock, seed: async (raw) => repo.seedRaw(raw), assetCount: async () => repo.assetCount };
    },
  ],
  [
    'IndexedDB (fake-indexeddb)',
    () => {
      const clock = { now: 1_000 };
      const name = `decktech-test-${dbCounter++}`;
      const repo = new IndexedDbDeckRepository({ name, now: () => clock.now });
      return {
        repo,
        clock,
        async seed(raw) {
          await repo.list(); // creates the schema
          const db = await openDB(name, DB_VERSION);
          const summary = { id: raw.id, title: raw.title ?? '', updatedAt: clock.now, revision: 1 };
          await db.put('decks', { id: raw.id, deck: structuredClone(raw) });
          await db.put('meta', { key: `summary:${raw.id}`, kind: 'summary', summary, schemaVersion: raw.schemaVersion });
          db.close();
        },
        async assetCount() {
          await repo.list();
          const db = await openDB(name, DB_VERSION);
          const count = await db.count('assets');
          db.close();
          return count;
        },
      };
    },
  ],
];

const bytes = (text: string, type: string): Blob => new Blob([text], { type });
const textOf = (blob: Blob): Promise<string> => blob.text();
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

describe.each(factories)('DeckRepository: %s', (_name, make) => {
  let h: Harness;
  beforeEach(() => {
    h = make();
  });

  describe('decks', () => {
    it('starts empty', async () => {
      expect(expectOk(await h.repo.list())).toEqual([]);
    });

    it('round-trips a deck and lists its summary', async () => {
      const deck = createDeck('Quarterly review');
      expect(expectOk(await h.repo.save(deck, null))).toBe(1);

      const loaded = expectOk(await h.repo.load(deck.id));
      expect(loaded.revision).toBe(1);
      expect(loaded.outcome).toEqual({ readOnly: false, deck, fromVersion: SCHEMA_VERSION, migrated: false });
      expect(expectOk(await h.repo.list())).toEqual([{ id: deck.id, title: 'Quarterly review', updatedAt: 1_000, revision: 1 }]);
    });

    it('does not mutate the deck it saves and stores a copy', async () => {
      const deck: Deck = deepFreeze(createDeck());
      expectOk(await h.repo.save(deck, null));
      const loaded = expectOk(await h.repo.load(deck.id));
      expect(loaded.outcome.readOnly).toBe(false);
      if (!loaded.outcome.readOnly) expect(loaded.outcome.deck).not.toBe(deck);
    });

    it('reports a missing deck', async () => {
      const result = await h.repo.load('dk_missing');
      expect(result).toEqual({ ok: false, error: { kind: 'not-found', message: 'deck "dk_missing" does not exist' } });
    });

    it('increments the revision on every save and updates the summary', async () => {
      const deck = createDeck('A');
      expect(expectOk(await h.repo.save(deck, null))).toBe(1);
      h.clock.now = 2_000;
      expect(expectOk(await h.repo.save({ ...deck, title: 'B' }, 1))).toBe(2);
      expect(expectOk(await h.repo.list())).toEqual([{ id: deck.id, title: 'B', updatedAt: 2_000, revision: 2 }]);
    });

    it.each([
      ['a stale revision', 1, 'changed elsewhere'],
      ['"new" for a stored deck', null, 'changed elsewhere'],
    ])('refuses to save with %s (second tab)', async (_label, expected, message) => {
      const deck = createDeck();
      expectOk(await h.repo.save(deck, null)); // rev 1
      expectOk(await h.repo.save({ ...deck, title: 'tab A' }, 1)); // rev 2

      const result = await h.repo.save({ ...deck, title: 'tab B' }, expected);
      expect(result).toMatchObject({ ok: false, error: { kind: 'conflict' } });
      expect(!result.ok && result.error.message).toContain(message);
      const stored = expectOk(await h.repo.load(deck.id));
      expect(stored.revision).toBe(2);
      expect(stored.outcome.readOnly === false && stored.outcome.deck.title).toBe('tab A');
    });

    it('refuses a revision for a deck that is not stored (deleted in another tab)', async () => {
      const result = await h.repo.save(createDeck(), 3);
      expect(result).toMatchObject({ ok: false, error: { kind: 'conflict' } });
      expect(expectOk(await h.repo.list())).toEqual([]);
    });

    it('refuses to save another schema version', async () => {
      const result = await h.repo.save({ ...createDeck(), schemaVersion: SCHEMA_VERSION + 1 }, null);
      expect(result).toMatchObject({ ok: false, error: { kind: 'invalid' } });
      expect(expectOk(await h.repo.list())).toEqual([]);
    });

    it.each(['__proto__', 'constructor', 'toString'])('handles the awkward deck id "%s"', async (id) => {
      const deck = { ...createDeck(), id };
      expectOk(await h.repo.save(deck, null));
      const loaded = expectOk(await h.repo.load(id));
      expect(loaded.outcome.readOnly === false && loaded.outcome.deck.id).toBe(id);
      expectOk(await h.repo.delete(id));
      expect(expectOk(await h.repo.list())).toEqual([]);
    });

    it('deletes a deck with its backups and export bookkeeping; deleting again is fine', async () => {
      await h.seed({ ...DECK_V0, id: 'dk_old', schemaVersion: 0 } as { id: string; schemaVersion: number });
      expectOk(await h.repo.load('dk_old')); // creates a backup
      expectOk(await h.repo.save(createDeck(), null));
      const other = createDeck();
      expectOk(await h.repo.save(other, null));

      expectOk(await h.repo.delete('dk_old'));
      expectOk(await h.repo.delete('dk_old'));
      expect(expectOk(await h.repo.listBackups('dk_old'))).toEqual([]);
      expect(await h.repo.load('dk_old')).toMatchObject({ ok: false, error: { kind: 'not-found' } });
      expect(expectOk(await h.repo.list())).toHaveLength(2);
      expect(expectOk(await h.repo.listUnexported())).toHaveLength(2);

      expectOk(await h.repo.delete(other.id));
      expect(expectOk(await h.repo.listUnexported()).map((u) => u.id)).not.toContain(other.id);
    });
  });

  describe('newer schema versions', () => {
    const newer = { id: 'dk_future', title: 'From the future', schemaVersion: SCHEMA_VERSION + 1 };

    it('loads as read-only without a deck', async () => {
      await h.seed(newer);
      const loaded = expectOk(await h.repo.load(newer.id));
      expect(loaded.outcome).toMatchObject({ readOnly: true, fromVersion: SCHEMA_VERSION + 1, supportedVersion: SCHEMA_VERSION });
      expect(expectOk(await h.repo.listBackups(newer.id))).toEqual([]);
    });

    it('never saves over it, whatever revision is passed', async () => {
      await h.seed(newer);
      for (const revision of [null, 1]) {
        const result = await h.repo.save({ ...createDeck(), id: newer.id }, revision);
        expect(result).toMatchObject({ ok: false, error: { kind: 'read-only' } });
      }
      const summaries = expectOk(await h.repo.list());
      expect(summaries).toEqual([{ id: newer.id, title: newer.title, updatedAt: 1_000, revision: 1 }]);
    });
  });

  describe('migrations and backups', () => {
    const old = { ...DECK_V0, id: 'dk_old' } as { id: string; schemaVersion: number };

    it('migrates on load, backs up the untouched original and leaves the stored copy alone until saved', async () => {
      await h.seed(old);
      const loaded = expectOk(await h.repo.load('dk_old'));
      expect(loaded.outcome).toMatchObject({ readOnly: false, migrated: true, fromVersion: 0 });

      const backups = expectOk(await h.repo.listBackups('dk_old'));
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatchObject({ deckId: 'dk_old', fromVersion: 0, toVersion: SCHEMA_VERSION });
      expect(backups[0].raw).toEqual(old);

      // still the old document in storage: another load migrates (and backs up) again
      expect(expectOk(await h.repo.load('dk_old')).outcome).toMatchObject({ migrated: true });

      if (loaded.outcome.readOnly) throw new Error('unreachable');
      expectOk(await h.repo.save(loaded.outcome.deck, loaded.revision));
      expect(expectOk(await h.repo.load('dk_old')).outcome).toMatchObject({ migrated: false });
      expect(expectOk(await h.repo.listBackups('dk_old'))).toHaveLength(2); // none added by the current-version load
    });

    it('two tabs migrating the same deck: the first save wins, the second is a conflict, the original stays backed up', async () => {
      await h.seed(old);
      const tabA = expectOk(await h.repo.load('dk_old'));
      const tabB = expectOk(await h.repo.load('dk_old'));
      if (tabA.outcome.readOnly || tabB.outcome.readOnly) throw new Error('unreachable');

      expectOk(await h.repo.save({ ...tabA.outcome.deck, title: 'edited in A' }, tabA.revision));
      const lost = await h.repo.save({ ...tabB.outcome.deck, title: 'edited in B' }, tabB.revision);
      expect(lost).toMatchObject({ ok: false, error: { kind: 'conflict' } });

      const stored = expectOk(await h.repo.load('dk_old'));
      expect(stored.outcome.readOnly === false && stored.outcome.deck.title).toBe('edited in A');
      const backups = expectOk(await h.repo.listBackups('dk_old'));
      expect(backups[0].raw).toEqual(old);
    });

    it('keeps the original pre-migration copy plus the most recent ones', async () => {
      await h.seed(old);
      const extra = 4;
      for (let i = 0; i < MAX_BACKUPS_PER_DECK + extra; i++) expectOk(await h.repo.load('dk_old'));
      const backups = expectOk(await h.repo.listBackups('dk_old'));
      expect(backups).toHaveLength(MAX_BACKUPS_PER_DECK);
      expect(backups[0].seq).toBe(1);
      const seqs = backups.map((b) => b.seq);
      expect(seqs).toEqual([1, ...Array.from({ length: MAX_BACKUPS_PER_DECK - 1 }, (_v, i) => MAX_BACKUPS_PER_DECK + extra - (MAX_BACKUPS_PER_DECK - 2) + i)]);
    });

    it('does not mix backups of different decks when pruning', async () => {
      await h.seed(old);
      await h.seed({ ...old, id: 'dk_other' });
      for (let i = 0; i < MAX_BACKUPS_PER_DECK + 2; i++) expectOk(await h.repo.load('dk_old'));
      expectOk(await h.repo.load('dk_other'));
      expect(expectOk(await h.repo.listBackups('dk_other'))).toHaveLength(1);
    });

    it('fails the load and keeps the stored original when the backup cannot be written', async () => {
      await h.seed(old);
      vi.spyOn(h.repo as unknown as { backup(): Promise<void> }, 'backup').mockRejectedValue(new Error('disk full'));
      const result = await h.repo.load('dk_old');
      expect(result).toMatchObject({ ok: false, error: { kind: 'backup-failed' } });
      expect(!result.ok && result.error.message).toContain('disk full');
      expect(expectOk(await h.repo.list())).toEqual([{ id: 'dk_old', title: 'Fixture deck', updatedAt: 1_000, revision: 1 }]);
    });

    it('reports an invalid stored deck without a backup', async () => {
      await h.seed({ id: 'dk_bad', schemaVersion: SCHEMA_VERSION });
      const result = await h.repo.load('dk_bad');
      expect(result).toMatchObject({ ok: false, error: { kind: 'invalid-deck' } });
      expect(expectOk(await h.repo.listBackups('dk_bad'))).toEqual([]);
    });

    it('rejects a backup of a document without an id', async () => {
      const sink = h.repo as unknown as { backup(e: { raw: unknown; fromVersion: number; toVersion: number }): Promise<void> };
      await expect(sink.backup({ raw: { schemaVersion: 0 }, fromVersion: 0, toVersion: 1 })).rejects.toThrow('without an id');
      await expect(sink.backup({ raw: null, fromVersion: 0, toVersion: 1 })).rejects.toThrow('without an id');
    });
  });

  describe('assets', () => {
    it('stores content addressed by SHA-256 and reads it back', async () => {
      const { ref, created } = expectOk(await h.repo.putAsset(bytes('abc', 'image/png')));
      expect(created).toBe(true);
      expect(ref).toEqual({ blobKey: SHA256_ABC, hash: SHA256_ABC, mime: 'image/png', size: 3 });

      const blob = expectOk(await h.repo.getAsset(SHA256_ABC));
      expect(blob.type).toBe('image/png');
      expect(blob.size).toBe(3);
      expect(await textOf(blob)).toBe('abc');
    });

    it('stores a duplicate upload once', async () => {
      const first = expectOk(await h.repo.putAsset(bytes('abc', 'image/png')));
      const second = expectOk(await h.repo.putAsset(bytes('abc', 'image/png')));
      expect(second.created).toBe(false);
      expect(second.ref).toEqual(first.ref);
      expect(await h.assetCount()).toBe(1);

      expectOk(await h.repo.putAsset(bytes('abd', 'image/png')));
      expect(await h.assetCount()).toBe(2);
    });

    it('keeps the first mime type for identical content so refs and blob agree', async () => {
      expectOk(await h.repo.putAsset(bytes('abc', 'image/png')));
      const again = expectOk(await h.repo.putAsset(bytes('abc', 'IMAGE/JPEG')));
      expect(again.ref.mime).toBe('image/png');
      expect(expectOk(await h.repo.getAsset(SHA256_ABC)).type).toBe('image/png');
    });

    it('accepts an empty blob', async () => {
      const { ref } = expectOk(await h.repo.putAsset(bytes('', 'text/css')));
      expect(ref.size).toBe(0);
      expect(await textOf(expectOk(await h.repo.getAsset(ref.hash)))).toBe('');
    });

    it.each(['', 'text/html', 'application/x-msdownload', 'image/svg+xml; charset=evil'])('rejects the mime type "%s"', async (type) => {
      const result = await h.repo.putAsset(bytes('abc', type));
      expect(result).toMatchObject({ ok: false, error: { kind: 'invalid' } });
      expect(await h.assetCount()).toBe(0);
    });

    it.each(['', 'abc', '__proto__', SHA256_ABC, SHA256_ABC.toUpperCase(), `${SHA256_ABC}x`])('does not find asset "%s"', async (id) => {
      const result = await h.repo.getAsset(id);
      expect(result).toMatchObject({ ok: false, error: { kind: 'not-found' } });
    });

    it('saving a deck leaves stored blobs alone', async () => {
      expectOk(await h.repo.putAsset(bytes('abc', 'image/png')));
      const deck = createDeck();
      expectOk(await h.repo.save(deck, null));
      expectOk(await h.repo.save({ ...deck, title: 'again' }, 1));
      expect(await h.assetCount()).toBe(1);
      expect(await textOf(expectOk(await h.repo.getAsset(SHA256_ABC)))).toBe('abc');
    });
  });

  describe('export bookkeeping', () => {
    it('marks decks as un-exported from their first save and keeps the earliest time', async () => {
      const a = createDeck();
      const b = createDeck();
      h.clock.now = 5_000;
      expectOk(await h.repo.save(b, null));
      h.clock.now = 3_000;
      expectOk(await h.repo.save(a, null));
      h.clock.now = 9_000;
      expectOk(await h.repo.save({ ...a, title: 'edited' }, 1));

      expect(expectOk(await h.repo.listUnexported())).toEqual([
        { id: a.id, since: 3_000 },
        { id: b.id, since: 5_000 },
      ]);
    });

    it('clears the mark on export and sets it again on the next save', async () => {
      const deck = createDeck();
      expectOk(await h.repo.save(deck, null));
      expectOk(await h.repo.markExported(deck.id));
      expectOk(await h.repo.markExported('dk_unknown'));
      expect(expectOk(await h.repo.listUnexported())).toEqual([]);

      h.clock.now = 7_000;
      expectOk(await h.repo.save({ ...deck, title: 'changed' }, 1));
      expect(expectOk(await h.repo.listUnexported())).toEqual([{ id: deck.id, since: 7_000 }]);
    });
  });
});
