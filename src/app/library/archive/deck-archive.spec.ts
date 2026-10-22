import { TestBed } from '@angular/core/testing';
import { strToU8, unzipSync } from 'fflate';
import { DECK_V0 } from '../../core/migrations/fixtures';
import { SCHEMA_VERSION, type Deck } from '../../core/model';
import { DECK_EXPORT_HANDLER, DeckRepository, InMemoryDeckRepository } from '../../core/persistence';
import { assetFor, fixture, packed, pngBytes, reworked, withDeckJson, type Fixture } from './archive-fixtures';
import { DeckArchive, fileStem } from './deck-archive';
import { FileAccess, type SaveOutcome } from './file-access';
import { DECK_ENTRY } from './format';
import { provideDeckArchive } from './providers';
import { readArchive } from './reader';

class FakeFiles {
  saved: { name: string; bytes: Uint8Array }[] = [];
  outcome: SaveOutcome = 'saved';
  failWith: Error | null = null;
  async save(name: string, bytes: Uint8Array): Promise<SaveOutcome> {
    if (this.failWith) throw this.failWith;
    if (this.outcome === 'saved') this.saved.push({ name, bytes });
    return this.outcome;
  }
  async open(): Promise<File | null> {
    return null;
  }
}

function setup(repo = new InMemoryDeckRepository(() => 1_000)) {
  const files = new FakeFiles();
  TestBed.configureTestingModule({
    providers: [{ provide: DeckRepository, useValue: repo }, { provide: FileAccess, useValue: files }, provideDeckArchive()],
  });
  return { repo, files, archive: TestBed.inject(DeckArchive) };
}

async function store(repo: InMemoryDeckRepository, f: Fixture): Promise<void> {
  for (const [id, bytes] of f.assets) {
    const put = await repo.putAsset(new Blob([bytes as BlobPart], { type: 'image/png' }));
    expect(put.ok && put.value.ref.hash).toBe(id);
  }
  const saved = await repo.save(f.deck, null);
  expect(saved.ok).toBe(true);
}

const ids = async (repo: InMemoryDeckRepository) => {
  const listed = await repo.list();
  return listed.ok ? listed.value.map((d) => d.id).sort() : [];
};

const fileOf = (bytes: Uint8Array) => new File([bytes as BlobPart], 'x.deck');

describe('DeckArchive export', () => {
  it('writes a stored deck with its assets and clears the not-exported mark', async () => {
    const { repo, files, archive } = setup();
    const f = await fixture({ code: true });
    await store(repo, f);
    const before = await repo.listUnexported();
    expect(before.ok && before.value.map((u) => u.id)).toEqual([f.deck.id]);

    const result = await archive.exportStored(f.deck.id);
    expect(result.ok && result.value).toMatchObject({ fileName: 'Round-trip.deck', cancelled: false, count: 1 });
    const read = await readArchive(files.saved[0].bytes);
    expect(read.ok && read.value.deck).toEqual(f.deck);
    const after = await repo.listUnexported();
    expect(after.ok && after.value).toEqual([]);
  });

  it('keeps the mark when the user dismisses the dialog or saving fails', async () => {
    const { repo, files, archive } = setup();
    const f = await fixture();
    await store(repo, f);
    files.outcome = 'cancelled';
    const cancelled = await archive.exportStored(f.deck.id);
    expect(cancelled.ok && cancelled.value.cancelled).toBe(true);
    files.failWith = new Error('disk full');
    const failed = await archive.exportStored(f.deck.id);
    expect(!failed.ok && failed.error.message).toBe('Could not save the file: disk full');
    const marks = await repo.listUnexported();
    expect(marks.ok && marks.value).toHaveLength(1);
  });

  it('says why a deck cannot be exported', async () => {
    const { repo, archive } = setup();
    repo.seedRaw({ id: 'dk_new', title: 'From the future', schemaVersion: SCHEMA_VERSION + 1 });
    const newer = await archive.exportStored('dk_new');
    expect(!newer.ok && newer.error.message).toMatch(/newer version/);
    const missing = await archive.exportStored('dk_nope');
    expect(!missing.ok && missing.error.message).toMatch(/Could not open the deck/);
  });

  it('fails when an asset of the deck is not in the store, and writes nothing', async () => {
    const { repo, files, archive } = setup();
    const f = await fixture();
    await repo.save(f.deck, null);
    const result = await archive.exportStored(f.deck.id);
    expect(!result.ok && result.error.message).toMatch(/Could not read a file of the deck/);
    expect(files.saved).toEqual([]);
  });

  it('exports everything as one ZIP of .deck files, skipping decks from a newer version', async () => {
    const { repo, files, archive } = setup();
    const a = await fixture();
    const b = await fixture({ pictures: 2 });
    b.deck.id = 'dk_second';
    await store(repo, a);
    await store(repo, b);
    repo.seedRaw({ id: 'dk_new', title: 'From the future', schemaVersion: SCHEMA_VERSION + 1 });

    const result = await archive.exportAll();
    expect(result.ok && result.value).toMatchObject({ fileName: 'decktech-decks.zip', count: 2, skipped: ['From the future'] });
    const bundle = unzipSync(files.saved[0].bytes);
    expect(Object.keys(bundle).sort()).toEqual([`Round-trip-${a.deck.id}.deck`, `Round-trip-dk_second.deck`].sort());
    for (const bytes of Object.values(bundle)) expect((await readArchive(bytes)).ok).toBe(true);
    const marks = await repo.listUnexported();
    expect(marks.ok && marks.value).toEqual([]);
  });

  it('has nothing to export for an empty library, and leaves marks when the dialog is dismissed', async () => {
    const { repo, files, archive } = setup();
    const empty = await archive.exportAll();
    expect(!empty.ok && empty.error.message).toBe('You have no decks to export.');
    await store(repo, await fixture());
    files.outcome = 'cancelled';
    const cancelled = await archive.exportAll();
    expect(cancelled.ok && cancelled.value).toMatchObject({ cancelled: true, count: 0 });
    const marks = await repo.listUnexported();
    expect(marks.ok && marks.value).toHaveLength(1);
  });

  it('plugs into the failure banner and throws when the deck cannot be packed', async () => {
    const { files } = setup();
    const handler = TestBed.inject(DECK_EXPORT_HANDLER);
    expect(handler).not.toBeNull();
    const f = await fixture();
    await expect(handler?.(f.deck)).rejects.toThrow(/Could not read a file of the deck/);
    expect(files.saved).toEqual([]);
    await handler?.({ ...f.deck, assets: {}, slides: [] });
    expect(files.saved.map((s) => s.name)).toEqual(['Round-trip.deck']);
  });
});

describe('DeckArchive import', () => {
  it('stores the deck and its assets, untrusted, and the export reads back identical', async () => {
    const { repo, archive } = setup();
    const f = await fixture({ code: true, pictures: 2 });
    const result = await archive.importBytes(await packed(f));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ hasCode: true, untrusted: true, renamed: false, migrated: false });
    expect(result.value.deck).toEqual(f.deck);
    const loaded = await repo.load(f.deck.id);
    expect(loaded.ok && !loaded.value.outcome.readOnly && loaded.value.outcome.deck).toEqual(f.deck);
    for (const [id, bytes] of f.assets) {
      const blob = await repo.getAsset(id);
      expect(blob.ok && Array.from(new Uint8Array(await blob.value.arrayBuffer()))).toEqual(Array.from(bytes));
    }
    expect(repo.assetCount).toBe(2);
  });

  it('never replaces a deck that has the same id: the copy gets a new one', async () => {
    const { repo, archive } = setup();
    const f = await fixture();
    await store(repo, f);
    const theirs = { ...f, deck: { ...f.deck, title: 'Their version' } } as Fixture;
    const result = await archive.importBytes(await packed(theirs));
    expect(result.ok && result.value.renamed).toBe(true);
    expect(result.ok && result.value.deck.id).not.toBe(f.deck.id);
    expect(await ids(repo)).toHaveLength(2);
    const original = await repo.load(f.deck.id);
    expect(original.ok && !original.value.outcome.readOnly && original.value.outcome.deck.title).toBe('Round trip');
  });

  it('reads a File and migrates an older deck', async () => {
    const { repo, archive } = setup();
    const png = pngBytes(5);
    const { id } = await assetFor(png);
    const old = structuredClone(DECK_V0) as Record<string, unknown>;
    old['assets'] = { [id]: { blobKey: id, mime: 'image/png', hash: id, size: png.length } };
    (old['slides'] as { elements: Record<string, unknown>[] }[])[0].elements[1]['assetId'] = id;
    const good = await packed(await fixture({ pictures: 0 }));
    const zip = await reworked(good, async (e) => {
      e[`assets/${id}.png`] = png;
      const bytes = strToU8(JSON.stringify(old));
      e[DECK_ENTRY] = bytes;
      const manifest = JSON.parse(new TextDecoder().decode(e['manifest.json'])) as Record<string, unknown>;
      manifest['contentHash'] = await (await import('./archive-fixtures')).digest(bytes);
      e['manifest.json'] = strToU8(JSON.stringify(manifest));
    });
    const result = await archive.importFile(fileOf(zip));
    expect(result.ok && result.value.migrated).toBe(true);
    const loaded = await repo.load('dk_fixture');
    expect(loaded.ok && !loaded.value.outcome.readOnly && loaded.value.outcome.deck.schemaVersion).toBe(SCHEMA_VERSION);
  });

  describe('a rejected file changes nothing', () => {
    const cases: [string, (f: Fixture) => Promise<Uint8Array>, RegExp][] = [
      ['path traversal', async (f) => reworked(await packed(f), (e) => void (e['../evil.json'] = strToU8('{}'))), /unsafe path/],
      ['a decompression bomb', async (f) => reworked(await packed(f), (e) => void (e[`assets/${'0'.repeat(64)}.png`] = new Uint8Array(4 * 1024 * 1024))), /decompression bomb/],
      ['bad content for the mime type', async (f) => {
        const exe = strToU8('MZ not a picture');
        const { id, ref } = await assetFor(exe);
        const deck: Deck = { ...f.deck, assets: { [id]: ref }, slides: [{ ...f.deck.slides[0], elements: [] }] };
        return packed({ ...f, deck, assets: new Map([[id, exe]]) });
      }, /content is not image\/png/],
      ['an invalid schema', async (f) => withDeckJson(await packed(f), { ...f.deck, slides: 'no' }), /not valid/],
      ['a hash mismatch', async (f) => reworked(await packed(f), (e) => void (e[DECK_ENTRY] = strToU8(JSON.stringify({ ...f.deck, title: 'x' })))), /content hash/],
      ['not a ZIP', async () => strToU8('hello'), /valid \.deck/],
    ];

    it.each(cases)('%s', async (_name, make, message) => {
      const { repo, archive } = setup();
      const existing = await fixture({ pictures: 2 });
      await store(repo, existing);
      const result = await archive.importBytes(await make(await fixture({ code: true })));
      expect(!result.ok && result.error.message).toMatch(/^This file cannot be imported\./);
      expect(!result.ok && result.error.message).toMatch(message);
      expect(await ids(repo)).toEqual([existing.deck.id]);
      expect(repo.assetCount).toBe(2);
    });
  });

  it('refuses a file larger than the limit without reading it', async () => {
    const { archive } = setup();
    const file = fileOf(new Uint8Array(10));
    const read = vi.spyOn(file, 'arrayBuffer');
    const result = await archive.importFile(file, { ...(await import('./format')).DEFAULT_ARCHIVE_LIMITS, maxArchiveBytes: 5 });
    expect(!result.ok && result.error.message).toMatch(/too large/);
    expect(read).not.toHaveBeenCalled();
  });

  it('reports storage failures', async () => {
    const { repo, archive } = setup();
    const zip = await packed(await fixture());
    vi.spyOn(repo, 'putAsset').mockResolvedValueOnce({ ok: false, error: { kind: 'quota', message: 'full' } });
    const first = await archive.importBytes(zip);
    expect(!first.ok && first.error.message).toBe('Could not store a file of the deck: full');
    expect(await ids(repo)).toEqual([]);
    vi.spyOn(repo, 'save').mockResolvedValueOnce({ ok: false, error: { kind: 'storage', message: 'closed' } });
    const second = await archive.importBytes(zip);
    expect(!second.ok && second.error.message).toBe('Could not save the imported deck: closed');
  });
});

describe('fileStem', () => {
  it.each([
    ['My talk: 2026!', 'My-talk-2026'],
    ['   ', 'deck'],
    ['../../etc/passwd', 'etc-passwd'],
    ['Überblick', 'Überblick'],
    ['a'.repeat(200), 'a'.repeat(80)],
  ])('%j → %j', (title, stem) => {
    expect(fileStem(title)).toBe(stem);
  });
});
