import { TestBed } from '@angular/core/testing';
import { DeckRepository, InMemoryDeckRepository } from '../core/persistence';
import { createDeck, err, validateDeck, type Deck } from '../core/model';
import { DeckLibrary, MAX_TITLE_LENGTH, checkTitle } from './deck-library';
import { BUILT_IN_TEMPLATES, instantiateTemplate } from './templates';

function setup() {
  let clock = 1_000;
  const repo = new InMemoryDeckRepository(() => clock++);
  TestBed.configureTestingModule({ providers: [{ provide: DeckRepository, useValue: repo }] });
  return { repo, library: TestBed.inject(DeckLibrary) };
}

const titles = (library: DeckLibrary) => library.decks().map((d) => d.title);

async function seed(repo: InMemoryDeckRepository, title: string): Promise<Deck> {
  const deck = createDeck(title);
  expect((await repo.save(deck, null)).ok).toBe(true);
  return deck;
}

describe('DeckLibrary', () => {
  it('lists decks, most recently modified first', async () => {
    const { repo, library } = setup();
    await seed(repo, 'Old');
    await seed(repo, 'New');
    expect(library.status()).toBe('loading');
    expect((await library.refresh()).ok).toBe(true);
    expect(library.status()).toBe('ready');
    expect(titles(library)).toEqual(['New', 'Old']);
  });

  it('reports a failed first read and keeps the old list on a later failure', async () => {
    const { repo, library } = setup();
    const list = vi.spyOn(repo, 'list').mockResolvedValue(err({ kind: 'storage', message: 'blocked' }));
    const first = await library.refresh();
    expect(first).toEqual({ ok: false, error: { message: 'Could not read your decks: blocked' } });
    expect(library.status()).toBe('error');

    list.mockRestore();
    await seed(repo, 'A');
    await library.refresh();
    expect(library.status()).toBe('ready');
    vi.spyOn(repo, 'list').mockResolvedValue(err({ kind: 'storage', message: 'blocked' }));
    await library.refresh();
    expect(library.status()).toBe('ready');
    expect(titles(library)).toEqual(['A']);
  });

  describe('create', () => {
    it('stores a blank deck that is valid and listed', async () => {
      const { repo, library } = setup();
      const result = await library.createBlank();
      if (!result.ok) throw new Error(result.error.message);
      expect(validateDeck(result.value).ok).toBe(true);
      expect(titles(library)).toEqual(['Untitled deck']);
      const loaded = await repo.load(result.value.id);
      expect(loaded.ok).toBe(true);
    });

    it.each(BUILT_IN_TEMPLATES.map((t) => [t.id, t.name] as const))('creates a deck from template %s', async (id, name) => {
      const { library } = setup();
      const first = await library.createFromTemplate(id);
      const second = await library.createFromTemplate(id);
      if (!first.ok || !second.ok) throw new Error('template failed');
      expect(first.value.title).toBe(name);
      expect(first.value.id).not.toBe(second.value.id);
      expect(library.decks()).toHaveLength(2);
    });

    it('rejects an unknown template, including inherited names, without storing anything', async () => {
      const { library } = setup();
      for (const id of ['nope', 'toString', '__proto__']) {
        expect(await library.createFromTemplate(id)).toEqual({ ok: false, error: { message: `Unknown template "${id}".` } });
      }
      expect(library.decks()).toEqual([]);
    });

    it('reports a failed save and leaves the list unchanged', async () => {
      const { repo, library } = setup();
      await seed(repo, 'Kept');
      await library.refresh();
      vi.spyOn(repo, 'save').mockResolvedValue(err({ kind: 'quota', message: 'storage quota exceeded' }));
      expect(await library.createBlank()).toEqual({ ok: false, error: { message: 'Could not save the deck: storage quota exceeded' } });
      expect(titles(library)).toEqual(['Kept']);
    });
  });

  describe('rename', () => {
    it('changes the stored title and the list, keeping the rest of the deck', async () => {
      const { repo, library } = setup();
      const deck = await seed(repo, 'Before');
      expect((await library.rename(deck.id, '  After  ')).ok).toBe(true);
      expect(titles(library)).toEqual(['After']);
      const loaded = await repo.load(deck.id);
      if (!loaded.ok || loaded.value.outcome.readOnly) throw new Error('load failed');
      expect(loaded.value.outcome.deck).toEqual({ ...deck, title: 'After' });
      expect(loaded.value.revision).toBe(2);
    });

    it('does not write when the title is unchanged', async () => {
      const { repo, library } = setup();
      const deck = await seed(repo, 'Same');
      const save = vi.spyOn(repo, 'save');
      expect((await library.rename(deck.id, 'Same')).ok).toBe(true);
      expect(save).not.toHaveBeenCalled();
    });

    it.each([
      ['', 'Enter a title.'],
      ['   ', 'Enter a title.'],
      ['x'.repeat(MAX_TITLE_LENGTH + 1), `Titles can be at most ${MAX_TITLE_LENGTH} characters.`],
    ])('rejects the title %j', async (title, message) => {
      const { repo, library } = setup();
      const deck = await seed(repo, 'Keep');
      expect(await library.rename(deck.id, title)).toEqual({ ok: false, error: { message } });
      await library.refresh();
      expect(titles(library)).toEqual(['Keep']);
    });

    it('accepts hostile-looking titles verbatim as text', async () => {
      const { repo, library } = setup();
      const deck = await seed(repo, 'A');
      for (const title of ['__proto__', 'constructor', '<img src=x onerror=alert(1)>']) {
        expect((await library.rename(deck.id, title)).ok).toBe(true);
        expect(titles(library)).toEqual([title]);
      }
    });

    it('fails for a missing deck, a newer-version deck and a concurrent change', async () => {
      const { repo, library } = setup();
      const missing = await library.rename('dk_missing', 'X');
      expect(missing.ok).toBe(false);

      repo.seedRaw({ id: 'dk_future', title: 'Future', schemaVersion: 999 });
      expect(await library.rename('dk_future', 'X')).toEqual({
        ok: false,
        error: { message: 'This deck was made with a newer version of DeckTech and cannot be changed here.' },
      });

      const deck = await seed(repo, 'Race');
      const realSave = repo.save.bind(repo);
      vi.spyOn(repo, 'save').mockImplementationOnce(async (d, rev) => {
        await realSave({ ...d, title: 'Other tab' }, rev);
        return realSave(d, rev);
      });
      const conflict = await library.rename(deck.id, 'Mine');
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.error.message).toContain('changed elsewhere');
    });
  });

  describe('duplicate', () => {
    it('stores an independent copy with a new deck id and the same content', async () => {
      const { repo, library } = setup();
      const deck = await seed(repo, 'Talk');
      const result = await library.duplicate(deck.id);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.id).not.toBe(deck.id);
      expect(result.value.title).toBe('Copy of Talk');
      expect({ ...result.value, id: deck.id, title: deck.title }).toEqual(deck);
      expect(titles(library).sort()).toEqual(['Copy of Talk', 'Talk']);
    });

    it('keeps a copy of a very long title within the limit', async () => {
      const { repo, library } = setup();
      const deck = await seed(repo, 'x'.repeat(MAX_TITLE_LENGTH));
      const result = await library.duplicate(deck.id);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.title).toHaveLength(MAX_TITLE_LENGTH);
    });

    it('refuses a newer-version deck and a missing one', async () => {
      const { repo, library } = setup();
      repo.seedRaw({ id: 'dk_future', schemaVersion: 999 });
      expect((await library.duplicate('dk_future')).ok).toBe(false);
      expect((await library.duplicate('dk_missing')).ok).toBe(false);
      await library.refresh();
      expect(library.decks()).toHaveLength(1);
    });
  });

  describe('remove', () => {
    it('deletes the deck, also a newer-version one', async () => {
      const { repo, library } = setup();
      const a = await seed(repo, 'A');
      repo.seedRaw({ id: 'dk_future', title: 'Future', schemaVersion: 999 });
      await library.refresh();
      expect(library.decks()).toHaveLength(2);
      expect((await library.remove(a.id)).ok).toBe(true);
      expect((await library.remove('dk_future')).ok).toBe(true);
      expect(library.decks()).toEqual([]);
    });

    it('keeps the list when the repository refuses', async () => {
      const { repo, library } = setup();
      const a = await seed(repo, 'A');
      await library.refresh();
      vi.spyOn(repo, 'delete').mockResolvedValue(err({ kind: 'storage', message: 'closed' }));
      expect(await library.remove(a.id)).toEqual({ ok: false, error: { message: 'Could not delete the deck: closed' } });
      expect(titles(library)).toEqual(['A']);
    });
  });

  it('runs operations one after the other and reports busy meanwhile', async () => {
    const { repo, library } = setup();
    const deck = await seed(repo, 'A');
    const order: string[] = [];
    const first = library.duplicate(deck.id).then(() => order.push('duplicate'));
    expect(library.busy()).toBe(true);
    const second = library.rename(deck.id, 'B').then(() => order.push('rename'));
    await Promise.all([first, second]);
    expect(order).toEqual(['duplicate', 'rename']);
    expect(library.busy()).toBe(false);
  });

  it('turns a rejecting repository into an error result and recovers', async () => {
    const { repo, library } = setup();
    vi.spyOn(repo, 'list').mockRejectedValueOnce(new Error('boom'));
    expect(await library.refresh()).toEqual({ ok: false, error: { message: 'boom' } });
    expect(library.busy()).toBe(false);
    expect((await library.refresh()).ok).toBe(true);
  });
});

describe('checkTitle', () => {
  it('trims', () => {
    expect(checkTitle('  a b ')).toEqual({ ok: true, value: 'a b' });
  });
});

describe('templates', () => {
  it.each(BUILT_IN_TEMPLATES.map((t) => [t.id, t] as const))('%s is a valid deck and is not mutated by use', (_id, template) => {
    const before = structuredClone(template.deck);
    const a = instantiateTemplate(template);
    const b = instantiateTemplate(template);
    if (!a.ok || !b.ok) throw new Error(a.ok ? String((b as { error: string }).error) : a.error);
    expect(a.value.id).not.toBe(b.value.id);
    expect(template.deck).toEqual(before);
    a.value.slides[0].notes = 'changed';
    expect(b.value.slides[0].notes).toBe('');
  });

  it('rejects a malformed template with its problems', () => {
    const broken = { id: 't', name: 't', description: '', deck: { schemaVersion: 1 } };
    const result = instantiateTemplate(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('template "t" is invalid');
    expect(instantiateTemplate({ ...broken, deck: null }).ok).toBe(false);
  });

  it('keeps text readable on the accent background of Big statement', () => {
    const template = BUILT_IN_TEMPLATES.find((t) => t.id === 'big-statement')!;
    const deck = template.deck as { slides: { elements: { color: unknown }[] }[] };
    // The default text colour (#111) on the accent (#2457d6) is about 2.7:1; white is above 6:1.
    expect(deck.slides[0].elements[0].color).toBe('#ffffff');
  });

  it('has unique ids', () => {
    const ids = BUILT_IN_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
