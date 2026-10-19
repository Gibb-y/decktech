import { TestBed } from '@angular/core/testing';
import { DECK_V0 } from '../migrations/fixtures';
import { SCHEMA_VERSION, createDeck, err, type Deck } from '../model';
import { DeckStore, SetNotes } from '../store';
import { AutosaveService } from './autosave';
import { DeckRepository } from './deck-repository';
import type { PersistenceError } from './errors';
import { InMemoryDeckRepository } from './memory-deck-repository';
import { AUTOSAVE_OPTIONS, DECK_EXPORT_HANDLER, STORAGE_MANAGER, type PersistentStorage } from './tokens';

function setup(extra: { storage?: PersistentStorage | null; exporter?: (deck: Deck) => void | Promise<void> } = {}) {
  const repo = new InMemoryDeckRepository();
  TestBed.configureTestingModule({
    providers: [
      { provide: DeckRepository, useValue: repo },
      { provide: STORAGE_MANAGER, useValue: extra.storage ?? null },
      { provide: DECK_EXPORT_HANDLER, useValue: extra.exporter ?? null },
    ],
  });
  const store = TestBed.inject(DeckStore);
  const autosave = TestBed.inject(AutosaveService);
  const save = vi.spyOn(repo, 'save');
  return { repo, store, autosave, save };
}

/** Types into the notes of the current slide, as a real edit would. */
function edit(store: DeckStore, text: string): void {
  store.execute(new SetNotes(store.currentSlide().id, text));
  TestBed.tick();
}

const quota: PersistenceError = { kind: 'quota', message: 'storage quota exceeded' };

describe('AutosaveService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('debounce', () => {
    it('writes a new deck once, 500 ms after create', async () => {
      const { store, autosave, save, repo } = setup();
      const deck = createDeck();
      autosave.create(deck);
      TestBed.tick();
      expect(autosave.status()).toBe('saving');

      await vi.advanceTimersByTimeAsync(499);
      expect(save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith(store.deck(), null);
      expect(autosave.status()).toBe('saved');
      expect(await repo.list()).toMatchObject({ ok: true, value: [{ id: deck.id, revision: 1 }] });
    });

    it('turns a burst of edits into one write after the last one', async () => {
      const { store, autosave, save } = setup();
      autosave.create(createDeck());
      await vi.advanceTimersByTimeAsync(500);
      save.mockClear();

      for (let i = 0; i < 20; i++) {
        edit(store, `note ${i}`);
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(save).not.toHaveBeenCalled();
      expect(autosave.status()).toBe('saving');

      await vi.advanceTimersByTimeAsync(399);
      expect(save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(save).toHaveBeenCalledTimes(1);
      const saved = save.mock.calls[0][0];
      expect(saved).toBe(store.deck());
      expect(saved.slides[0].notes).toBe('note 19');
      expect(save.mock.calls[0][1]).toBe(1);
      expect(autosave.status()).toBe('saved');
    });

    it('still writes during a gesture that never pauses (max wait)', async () => {
      const { store, autosave, save } = setup();
      autosave.create(createDeck());
      await vi.advanceTimersByTimeAsync(500);
      save.mockClear();

      for (let t = 0; t < 5_000; t += 400) {
        edit(store, `at ${t}`);
        await vi.advanceTimersByTimeAsync(400);
      }
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('does not write when nothing changed', async () => {
      const { autosave, save } = setup();
      autosave.create(createDeck());
      await vi.advanceTimersByTimeAsync(500);
      save.mockClear();

      TestBed.tick();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(save).not.toHaveBeenCalled();
      expect(autosave.status()).toBe('saved');
    });

    it('chains revisions across writes', async () => {
      const { store, autosave, save } = setup();
      autosave.create(createDeck());
      await vi.advanceTimersByTimeAsync(500);
      edit(store, 'one');
      await vi.advanceTimersByTimeAsync(500);
      edit(store, 'two');
      await vi.advanceTimersByTimeAsync(500);
      expect(save.mock.calls.map((c) => c[1])).toEqual([null, 1, 2]);
    });

    it('ignores changes before any deck is tracked', async () => {
      const { store, save } = setup();
      edit(store, 'untracked');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(save).not.toHaveBeenCalled();
    });

    it('ignores a different deck swapped into the store behind its back', async () => {
      const { store, autosave, save } = setup();
      autosave.create(createDeck());
      await vi.advanceTimersByTimeAsync(500);
      save.mockClear();

      store.load(createDeck('Other'));
      TestBed.tick();
      edit(store, 'edit on other');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('flush', () => {
    it('writes pending changes immediately and cancels the timer', async () => {
      const { store, autosave, save } = setup();
      autosave.create(createDeck());
      await vi.advanceTimersByTimeAsync(500);
      save.mockClear();

      edit(store, 'before import');
      expect(await autosave.flush()).toBe(true);
      expect(save).toHaveBeenCalledTimes(1);
      expect(autosave.status()).toBe('saved');

      await vi.advanceTimersByTimeAsync(10_000);
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('is a no-op without a tracked deck or changes', async () => {
      const { autosave, save } = setup();
      expect(await autosave.flush()).toBe(true);
      autosave.create(createDeck());
      await vi.advanceTimersByTimeAsync(500);
      save.mockClear();
      expect(await autosave.flush()).toBe(true);
      expect(save).not.toHaveBeenCalled();
    });

    it('serialises writes: an edit during a slow write is saved after it, with the new revision', async () => {
      const { store, autosave, save, repo } = setup();
      autosave.create(createDeck());
      await vi.advanceTimersByTimeAsync(500);
      save.mockClear();

      let release: () => void = () => undefined;
      const realSave = InMemoryDeckRepository.prototype.save.bind(repo);
      save.mockImplementationOnce(async (deck, rev) => {
        await new Promise<void>((resolve) => (release = resolve));
        return realSave(deck, rev);
      });
      edit(store, 'first');
      await vi.advanceTimersByTimeAsync(500); // write A starts and hangs
      edit(store, 'second');
      await vi.advanceTimersByTimeAsync(500); // write B is due but must wait for A
      expect(save).toHaveBeenCalledTimes(1);

      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls[1][1]).toBe(2); // B builds on the revision A produced
      expect(save.mock.calls[1][0].slides[0].notes).toBe('second');
      expect(autosave.status()).toBe('saved');
    });
  });

  describe('failures', () => {
    it('reports a failed write as error and keeps the deck pending', async () => {
      const { store, autosave, save } = setup();
      autosave.create(createDeck());
      await vi.advanceTimersByTimeAsync(500);
      save.mockClear();

      save.mockResolvedValueOnce(err(quota));
      edit(store, 'too big');
      await vi.advanceTimersByTimeAsync(500);
      expect(autosave.status()).toBe('error');
      expect(autosave.error()).toEqual(quota);

      // revision was not advanced; a retry writes the same deck against the same revision
      expect(await autosave.flush()).toBe(true);
      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls[1][0]).toBe(save.mock.calls[0][0]);
      expect(save.mock.calls[1][1]).toBe(save.mock.calls[0][1]);
      expect(autosave.status()).toBe('saved');
      expect(autosave.error()).toBeNull();
    });

    it('retries on the next edit', async () => {
      const { store, autosave, save } = setup();
      autosave.create(createDeck());
      await vi.advanceTimersByTimeAsync(500);

      save.mockResolvedValueOnce(err(quota));
      edit(store, 'a');
      await vi.advanceTimersByTimeAsync(500);
      expect(autosave.status()).toBe('error');

      edit(store, 'b');
      expect(autosave.status()).toBe('saving');
      await vi.advanceTimersByTimeAsync(500);
      expect(autosave.status()).toBe('saved');
    });

    it('treats a repository that rejects as a failed write and keeps working afterwards', async () => {
      const { store, autosave, save } = setup();
      autosave.create(createDeck());
      await vi.advanceTimersByTimeAsync(500);

      save.mockRejectedValueOnce(new Error('IDB closed'));
      edit(store, 'a');
      await vi.advanceTimersByTimeAsync(500);
      expect(autosave.status()).toBe('error');
      expect(autosave.error()).toEqual({ kind: 'storage', message: 'IDB closed' });

      expect(await autosave.flush()).toBe(true);
      expect(autosave.status()).toBe('saved');
    });

    it('flush resolves false while the write keeps failing', async () => {
      const { store, autosave, save } = setup();
      autosave.create(createDeck());
      await vi.advanceTimersByTimeAsync(500);
      save.mockResolvedValue(err(quota));
      edit(store, 'a');
      expect(await autosave.flush()).toBe(false);
      expect(autosave.status()).toBe('error');
    });

    it('detects a write by another tab as a conflict and does not overwrite it', async () => {
      const { store, autosave, repo } = setup();
      autosave.create(createDeck());
      await vi.advanceTimersByTimeAsync(500);

      // the other tab saves revision 2
      const other = { ...store.deck(), title: 'other tab' };
      expect((await repo.save(other, 1)).ok).toBe(true);

      edit(store, 'mine');
      await vi.advanceTimersByTimeAsync(500);
      expect(autosave.status()).toBe('error');
      expect(autosave.error()?.kind).toBe('conflict');
      const stored = await repo.load(store.deck().id);
      expect(stored.ok && !stored.value.outcome.readOnly && stored.value.outcome.deck.title).toBe('other tab');
    });
  });

  describe('open and create', () => {
    it('opens a stored deck without writing it', async () => {
      const { repo, store, autosave, save } = setup();
      const deck = createDeck('Stored');
      await repo.save(deck, null);
      save.mockClear();

      const result = await autosave.open(deck.id);
      expect(result.ok && !result.value.readOnly && result.value.deck).toEqual(deck);
      expect(store.deck()).toEqual(deck);
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(save).not.toHaveBeenCalled();
      expect(autosave.status()).toBe('saved');

      edit(store, 'x');
      await vi.advanceTimersByTimeAsync(500);
      expect(save).toHaveBeenCalledWith(store.deck(), 1);
    });

    it('saves a migrated deck right away; its pre-migration copy was backed up first', async () => {
      const { repo, store, autosave, save } = setup();
      repo.seedRaw({ ...DECK_V0, id: 'dk_old', schemaVersion: 0 } as { id: string; schemaVersion: number });

      const result = await autosave.open('dk_old');
      expect(result.ok && !result.value.readOnly && result.value.migrated).toBe(true);
      expect(save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);

      expect(save).toHaveBeenCalledWith(store.deck(), 1);
      expect(store.deck().schemaVersion).toBe(SCHEMA_VERSION);
      const backups = await repo.listBackups('dk_old');
      expect(backups.ok && backups.value).toHaveLength(1);
      const reloaded = await repo.load('dk_old');
      expect(reloaded.ok && !reloaded.value.outcome.readOnly && reloaded.value.outcome.migrated).toBe(false);
    });

    it('reports a newer deck as read-only, leaves the open deck alone and never saves it', async () => {
      const { repo, store, autosave, save } = setup();
      repo.seedRaw({ id: 'dk_future', schemaVersion: SCHEMA_VERSION + 1 });
      const mine = createDeck('Mine');
      autosave.create(mine);
      await vi.advanceTimersByTimeAsync(500);
      save.mockClear();

      const result = await autosave.open('dk_future');
      expect(result).toMatchObject({ ok: true, value: { readOnly: true } });
      expect(store.deck()).toBe(mine);

      edit(store, 'still editing mine');
      await vi.advanceTimersByTimeAsync(500);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0][0].id).toBe(mine.id);
    });

    it('passes load errors through and keeps the open deck', async () => {
      const { store, autosave } = setup();
      const mine = createDeck();
      autosave.create(mine);
      await vi.advanceTimersByTimeAsync(500);
      const result = await autosave.open('dk_missing');
      expect(result).toMatchObject({ ok: false, error: { kind: 'not-found' } });
      expect(store.deck()).toBe(mine);
    });

    it('saves pending changes before switching decks', async () => {
      const { repo, store, autosave } = setup();
      const other = createDeck('Other');
      await repo.save(other, null);
      const mine = createDeck('Mine');
      autosave.create(mine);
      await vi.advanceTimersByTimeAsync(500);
      edit(store, 'unsaved note');

      expect((await autosave.open(other.id)).ok).toBe(true);
      expect(store.deck().id).toBe(other.id);
      const saved = await repo.load(mine.id);
      expect(saved.ok && !saved.value.outcome.readOnly && saved.value.outcome.deck.slides[0].notes).toBe('unsaved note');
    });

    it('refuses to switch while pending changes cannot be saved, unless forced', async () => {
      const { repo, store, autosave, save } = setup();
      const other = createDeck('Other');
      await repo.save(other, null);
      const mine = createDeck('Mine');
      autosave.create(mine);
      await vi.advanceTimersByTimeAsync(500);
      save.mockResolvedValue(err(quota));
      edit(store, 'unsaved note');

      const refused = await autosave.open(other.id);
      expect(refused).toEqual({ ok: false, error: quota });
      expect(store.deck().id).toBe(mine.id);

      expect((await autosave.open(other.id, { force: true })).ok).toBe(true);
      expect(store.deck().id).toBe(other.id);
      expect(autosave.status()).toBe('saved');
    });

    it('does not report the old deck failure after switching to another', async () => {
      const { repo, store, autosave, save } = setup();
      const other = createDeck('Other');
      await repo.save(other, null);
      autosave.create(createDeck());
      await vi.advanceTimersByTimeAsync(500);
      save.mockResolvedValue(err(quota));
      edit(store, 'x');
      await autosave.open(other.id, { force: true });
      expect(autosave.error()).toBeNull();
    });
  });

  describe('persistent storage', () => {
    it('asks the browser for persistent storage', async () => {
      const persist = vi.fn().mockResolvedValue(true);
      const { autosave } = setup({ storage: { persisted: () => Promise.resolve(false), persist } });
      expect(await autosave.requestPersistence()).toBe(true);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(autosave.persisted()).toBe(true);
    });

    it('does not ask again when already persistent', async () => {
      const persist = vi.fn().mockResolvedValue(true);
      const { autosave } = setup({ storage: { persisted: () => Promise.resolve(true), persist } });
      expect(await autosave.requestPersistence()).toBe(true);
      expect(persist).not.toHaveBeenCalled();
    });

    it.each([
      ['denied', { persist: () => Promise.resolve(false) }],
      ['throwing', { persist: () => Promise.reject(new Error('nope')) }],
      ['unsupported', {}],
      ['missing', null],
    ])('copes with a %s storage manager', async (_label, storage) => {
      const { autosave } = setup({ storage });
      expect(await autosave.requestPersistence()).toBe(false);
      expect(autosave.persisted()).toBe(false);
    });
  });

  describe('export hook', () => {
    it('is unavailable until DT-16 provides one', async () => {
      const { autosave } = setup();
      expect(autosave.canExport()).toBe(false);
      await expect(autosave.exportDeck()).resolves.toBeUndefined();
    });

    it('hands the open deck to the handler', async () => {
      const exporter = vi.fn();
      const { autosave, store } = setup({ exporter });
      expect(autosave.canExport()).toBe(true);
      await autosave.exportDeck();
      expect(exporter).toHaveBeenCalledWith(store.deck());
    });
  });

  it('uses the configured delays', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: AUTOSAVE_OPTIONS, useValue: { debounceMs: 50, maxWaitMs: 100 } }] });
    const { autosave, save } = setup();
    autosave.create(createDeck());
    await vi.advanceTimersByTimeAsync(50);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
