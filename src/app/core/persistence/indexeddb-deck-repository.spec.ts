import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { createDeck } from '../model';
import { DB_VERSION, IndexedDbDeckRepository } from './indexeddb-deck-repository';

let counter = 0;
const freshName = () => `decktech-idb-${counter++}`;

describe('IndexedDbDeckRepository', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the stores decks, assets, components, meta and backups', async () => {
    const name = freshName();
    await new IndexedDbDeckRepository({ name }).list();
    const db = await openDB(name, DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual(['assets', 'backups', 'components', 'decks', 'meta']);
    db.close();
  });

  it('keeps data across instances (reload)', async () => {
    const name = freshName();
    const first = new IndexedDbDeckRepository({ name });
    const deck = createDeck('Persistent');
    await first.save(deck, null);
    await first.close();

    const second = new IndexedDbDeckRepository({ name });
    const loaded = await second.load(deck.id);
    expect(loaded.ok && !loaded.value.outcome.readOnly && loaded.value.outcome.deck).toEqual(deck);
  });

  it('saving a deck only opens a transaction on decks and meta, never on assets', async () => {
    const repo = new IndexedDbDeckRepository({ name: freshName() });
    await repo.putAsset(new Blob(['abc'], { type: 'image/png' }));
    const deck = createDeck();
    await repo.save(deck, null);

    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    await repo.save({ ...deck, title: 'again' }, 1);
    expect(spy.mock.calls.map((c) => [c[0]].flat().sort())).toEqual([['decks', 'meta']]);
    expect(spy.mock.calls[0][1]).toBe('readwrite');
  });

  it('lists decks from the small summary records without reading deck bodies', async () => {
    const repo = new IndexedDbDeckRepository({ name: freshName() });
    await repo.save(createDeck('A'), null);
    await repo.save(createDeck('B'), null);

    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const result = await repo.list();
    expect(result.ok && result.value.map((s) => s.title).sort()).toEqual(['A', 'B']);
    expect(spy.mock.calls.every((c) => [c[0]].flat().every((store) => store === 'meta'))).toBe(true);
  });

  it('reports quota exhaustion and rolls the whole save back', async () => {
    const repo = new IndexedDbDeckRepository({ name: freshName() });
    const deck = createDeck('Before');
    await repo.save(deck, null);

    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      // the deck body goes in first; failing the summary afterwards must undo it
      if (this.name === 'meta') throw new DOMException('full', 'QuotaExceededError');
      return put.apply(this, args);
    });
    const result = await repo.save({ ...deck, title: 'After' }, 1);
    expect(result).toEqual({ ok: false, error: { kind: 'quota', message: 'storage quota exceeded' } });
    vi.restoreAllMocks();

    const loaded = await repo.load(deck.id);
    expect(loaded.ok && !loaded.value.outcome.readOnly && loaded.value.outcome.deck.title).toBe('Before');
    expect(loaded.ok && loaded.value.revision).toBe(1);
  });

  it('reports other failures as storage errors and recovers once the database opens', async () => {
    const repo = new IndexedDbDeckRepository({ name: freshName() });
    vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      throw new Error('IndexedDB is disabled');
    });
    expect(await repo.list()).toEqual({ ok: false, error: { kind: 'storage', message: 'IndexedDB is disabled' } });
    expect(await repo.list()).toEqual({ ok: true, value: [] });
  });

  it('reopens after the browser closes the connection', async () => {
    const repo = new IndexedDbDeckRepository({ name: freshName() });
    const deck = createDeck();
    await repo.save(deck, null);
    await repo.close();
    expect(await repo.list()).toMatchObject({ ok: true, value: [{ id: deck.id }] });
  });

  it('a backup that fails midway leaves no partial entry', async () => {
    const repo = new IndexedDbDeckRepository({ name: freshName() });
    const add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof add>) {
      add.apply(this, args);
      throw new DOMException('full', 'QuotaExceededError');
    });
    await expect(repo.backup({ raw: { id: 'dk_a', schemaVersion: 0 }, fromVersion: 0, toVersion: 1 })).rejects.toThrow('full');
    vi.restoreAllMocks();
    expect(await repo.listBackups('dk_a')).toEqual({ ok: true, value: [] });
  });
});
