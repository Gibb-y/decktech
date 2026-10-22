import { strToU8, unzipSync, zipSync } from 'fflate';
import { DECK_V0, deepFreeze } from '../../core/migrations/fixtures';
import { DEFAULT_VALIDATION_OPTIONS, SCHEMA_VERSION, type Deck } from '../../core/model';
import {
  ARCHIVE_FORMAT,
  DECK_ENTRY,
  FORMAT_VERSION,
  MANIFEST_ENTRY,
  MIME_EXTENSIONS,
  THUMBNAIL_ENTRY,
  assetEntryName,
  extensionFor,
  type ArchiveErrorKind,
} from './format';
import {
  PNG_HEADER,
  assetFor,
  digest,
  fixture,
  packed,
  patchCentral,
  pngBytes,
  renameBytes,
  reworked,
  withDeckJson,
} from './archive-fixtures';
import { readArchive } from './reader';
import { contentProblem } from './sniff';
import { writeArchive } from './writer';

async function rejected(zip: Uint8Array, kind: ArchiveErrorKind, message: RegExp | string, limits = {}) {
  const result = await readArchive(zip, { limits });
  if (result.ok) throw new Error(`expected ${kind}, but the file was accepted`);
  expect(result.error.kind).toBe(kind);
  expect(result.error.message).toMatch(message);
}

const manifestOf = (zip: Uint8Array) => JSON.parse(new TextDecoder().decode(unzipSync(zip)[MANIFEST_ENTRY])) as Record<string, unknown>;

describe('round trip', () => {
  it('gives back a deep-equal deck and identical assets', async () => {
    const f = await fixture({ code: true, pictures: 3 });
    const result = await readArchive(await packed(f));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deck).toEqual(f.deck);
    expect([...result.value.assets.keys()].sort()).toEqual(Object.keys(f.deck.assets).sort());
    for (const [id, { bytes, ref }] of result.value.assets) {
      expect(Array.from(bytes)).toEqual(Array.from(f.assets.get(id) as Uint8Array));
      expect(ref).toEqual(f.deck.assets[id]);
    }
    expect(result.value.hasCode).toBe(true);
    expect(result.value.migrated).toBe(false);
  });

  it('reports the hash of deck.json and no code for a deck without components', async () => {
    const f = await fixture();
    const zip = await packed(f);
    const result = await readArchive(zip);
    expect(result.ok && result.value.hasCode).toBe(false);
    expect(result.ok && result.value.hash).toBe(await digest(strToU8(JSON.stringify(f.deck))));
    expect(result.ok && result.value.hash).toBe(manifestOf(zip)['contentHash']);
  });

  it('writes the documented entries and a manifest', async () => {
    const f = await fixture();
    const zip = await packed(f);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual([assetEntryName(f.imageId, 'png'), DECK_ENTRY, MANIFEST_ENTRY].sort());
    expect(manifestOf(zip)).toMatchObject({ format: ARCHIVE_FORMAT, formatVersion: FORMAT_VERSION, schemaVersion: SCHEMA_VERSION });
  });

  it('is deterministic and does not change its inputs', async () => {
    const f = await fixture({ code: true });
    deepFreeze(f.deck);
    const a = await packed(f);
    const b = await packed(f);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('keeps an optional thumbnail', async () => {
    const f = await fixture();
    const written = await writeArchive(f.deck, f.assets, { thumbnail: pngBytes(9) });
    const read = await readArchive(written.ok ? written.value : new Uint8Array());
    expect(read.ok && Array.from(read.value.thumbnail ?? [])).toEqual(Array.from(pngBytes(9)));
  });

  it('handles a deck with no assets and one with an empty title-sized asset list', async () => {
    const f = await fixture({ pictures: 0 });
    const read = await readArchive(await packed(f));
    expect(read.ok && read.value.assets.size).toBe(0);
  });
});

describe('writer', () => {
  it('refuses an asset whose bytes are missing', async () => {
    const f = await fixture();
    const result = await writeArchive(f.deck, new Map());
    expect(!result.ok && result.error.kind).toBe('missing-entry');
    expect(!result.ok && result.error.message).toMatch(/missing/);
  });

  it('refuses an asset whose stored bytes do not match their hash or size', async () => {
    const f = await fixture();
    const damaged = new Map([[f.imageId, pngBytes(77)]]);
    const result = await writeArchive(f.deck, damaged);
    expect(!result.ok && result.error.kind).toBe('hash-mismatch');
  });

  it('refuses a mime type that is not allowed', async () => {
    const f = await fixture();
    f.deck.assets[f.imageId] = { ...f.deck.assets[f.imageId], mime: 'application/x-msdownload' };
    const result = await writeArchive(f.deck, f.assets);
    expect(!result.ok && result.error.kind).toBe('bad-mime');
  });

  it('refuses to write what the reader would refuse for size', async () => {
    const f = await fixture();
    const result = await writeArchive(f.deck, f.assets, { limits: { maxEntryBytes: 4 } });
    expect(!result.ok && result.error.kind).toBe('too-large');
    const total = await writeArchive(f.deck, f.assets, { limits: { maxTotalBytes: 10 } });
    expect(!total.ok && total.error.kind).toBe('too-large');
    const entries = await writeArchive(f.deck, f.assets, { limits: { maxEntries: 2 } });
    expect(!entries.ok && entries.error.kind).toBe('too-large');
  });
});

describe('reader: archive structure', () => {
  const traversal = [
    ['a parent directory', '../evil.json'],
    ['a parent directory below assets', 'assets/../../evil.png'],
    ['an absolute path', '/etc/passwd'],
    ['a drive letter', 'C:/Windows/evil.dll'],
    ['a backslash', 'assets\\evil.png'],
    ['a relative segment', './deck.json'],
    ['an empty segment', 'assets//evil.png'],
    ['a control character', 'deck.json\u0000.png'],
  ] as const;

  it.each(traversal)('rejects an entry with %s and names it', async (_why, name) => {
    const f = await fixture();
    const zip = await reworked(await packed(f), (e) => void (e[name] = strToU8('x')));
    await rejected(zip, 'bad-path', /unsafe path/);
  });

  it('rejects an entry that is not part of the format', async () => {
    const zip = await reworked(await packed(await fixture()), (e) => void (e['readme.txt'] = strToU8('hi')));
    await rejected(zip, 'unexpected-entry', /readme\.txt/);
  });

  it('rejects an asset the deck does not use', async () => {
    const orphan = await assetFor(pngBytes(200));
    const zip = await reworked(await packed(await fixture()), (e) => void (e[assetEntryName(orphan.id, 'png')] = pngBytes(200)));
    await rejected(zip, 'unexpected-entry', /not used by the deck/);
  });

  it('rejects two entries with the same name', async () => {
    const f = await fixture();
    const zip = await reworked(await packed(f), (e) => void (e['deck.jsoX'] = e[DECK_ENTRY]));
    await rejected(renameBytes(zip, 'deck.jsoX', DECK_ENTRY), 'duplicate-entry', /more than once/);
  });

  it('rejects an entry whose name differs only in case', async () => {
    const zip = await reworked(await packed(await fixture()), (e) => void (e['DECK.JSON'] = e[DECK_ENTRY]));
    await rejected(zip, 'duplicate-entry', /DECK\.JSON/);
  });

  it('rejects a decompression bomb by ratio before inflating it', async () => {
    const f = await fixture();
    const zeros = new Uint8Array(4 * 1024 * 1024);
    const id = await digest(zeros);
    const zip = await reworked(await packed(f), (e) => void (e[assetEntryName(id, 'png')] = zeros));
    await rejected(zip, 'zip-bomb', /decompression bomb/);
  });

  it('lets small, highly compressible entries through', async () => {
    const f = await fixture();
    f.deck.slides[0].notes = 'x'.repeat(100_000);
    const read = await readArchive(await packed(f));
    expect(read.ok).toBe(true);
  });

  it('rejects an entry larger than the entry limit', async () => {
    const zip = await packed(await fixture());
    await rejected(zip, 'too-large', /uncompressed; the limit/, { maxEntryBytes: 4 });
    await rejected(zip, 'too-large', /deck\.json/, { maxDeckBytes: 8 });
  });

  it('rejects an archive that unpacks to too much, and one that is too big or has too many entries', async () => {
    const zip = await packed(await fixture({ pictures: 3 }));
    await rejected(zip, 'too-large', /unpacks to more than/, { maxTotalBytes: 100 });
    await rejected(zip, 'too-large', /limit is/, { maxArchiveBytes: 100 });
    await rejected(zip, 'too-many-entries', /more than 3 entries/, { maxEntries: 3 });
  });

  it('does not trust a declared size that is far too large', async () => {
    const f = await fixture();
    const zip = patchCentral(await packed(f), assetEntryName(f.imageId, 'png'), 'originalSize', 0xfffffff0);
    await rejected(zip, 'too-large', /limit/);
  });

  it('does not accept a declared size that is too small', async () => {
    const f = await fixture();
    const zip = patchCentral(await packed(f), DECK_ENTRY, 'originalSize', 10);
    const result = await readArchive(zip);
    expect(result.ok).toBe(false);
  });

  it.each([
    ['empty input', new Uint8Array(0)],
    ['random bytes', Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 251)],
    ['text', strToU8('{"not":"a zip"}')],
  ])('rejects %s as not a .deck file', async (_name, bytes) => {
    await rejected(bytes, 'bad-zip', /valid \.deck|could not be read/);
  });

  it('rejects a truncated archive', async () => {
    const zip = await packed(await fixture());
    const result = await readArchive(zip.slice(0, zip.length - 30));
    expect(result.ok).toBe(false);
  });

  it('never throws on garbage inside a plausible archive', async () => {
    const zip = await packed(await fixture());
    for (let at = 0; at < zip.length; at += 7) {
      const broken = zip.slice();
      broken[at] ^= 0xff;
      await expect(readArchive(broken)).resolves.toBeDefined();
    }
  });
});

describe('reader: manifest and hash', () => {
  it('requires both manifest.json and deck.json', async () => {
    const zip = await packed(await fixture());
    await rejected(await reworked(zip, (e) => void delete e[MANIFEST_ENTRY]), 'missing-entry', /manifest\.json/);
    await rejected(await reworked(zip, (e) => void delete e[DECK_ENTRY]), 'missing-entry', /deck\.json/);
  });

  it.each([
    ['not JSON', () => strToU8('nope'), /valid JSON/],
    ['an array', () => strToU8('[]'), /must be an object/],
    ['another format', (m: Record<string, unknown>) => strToU8(JSON.stringify({ ...m, format: 'other' })), /not a DeckTech file/],
    ['a bad version', (m: Record<string, unknown>) => strToU8(JSON.stringify({ ...m, formatVersion: 'one' })), /formatVersion/],
    ['a bad hash', (m: Record<string, unknown>) => strToU8(JSON.stringify({ ...m, contentHash: 'ABC' })), /contentHash/],
  ])('rejects a manifest that is %s', async (_name, make, message) => {
    const zip = await packed(await fixture());
    const manifest = manifestOf(zip);
    await rejected(await reworked(zip, (e) => void (e[MANIFEST_ENTRY] = make(manifest))), 'bad-manifest', message);
  });

  it('says to update when the format is newer', async () => {
    const zip = await packed(await fixture());
    const manifest = { ...manifestOf(zip), formatVersion: FORMAT_VERSION + 1 };
    await rejected(await reworked(zip, (e) => void (e[MANIFEST_ENTRY] = strToU8(JSON.stringify(manifest)))), 'newer-format', /Update DeckTech/);
  });

  it('rejects a deck that does not match the hash in the manifest', async () => {
    const f = await fixture();
    const zip = await reworked(await packed(f), (e) => void (e[DECK_ENTRY] = strToU8(JSON.stringify({ ...f.deck, title: 'Changed' }))));
    await rejected(zip, 'hash-mismatch', /content hash/);
  });

  it('rejects a manifest that carries another deck\'s hash', async () => {
    const zip = await packed(await fixture());
    const manifest = { ...manifestOf(zip), contentHash: 'f'.repeat(64) };
    await rejected(await reworked(zip, (e) => void (e[MANIFEST_ENTRY] = strToU8(JSON.stringify(manifest)))), 'hash-mismatch', /damaged/);
  });
});

describe('reader: deck validation', () => {
  it('rejects an invalid schema with the path of the problem', async () => {
    const f = await fixture();
    const zip = await withDeckJson(await packed(f), { ...f.deck, title: 42 });
    await rejected(zip, 'invalid-deck', /title/);
  });

  it('rejects a deck.json that is not JSON, not UTF-8 or not an object', async () => {
    const zip = await packed(await fixture());
    await rejected(await withDeckJson(zip, '{nope'), 'invalid-deck', /valid JSON/);
    await rejected(await withDeckJson(zip, '[]'), 'invalid-deck', /deck must be an object/);
    const binary = await reworked(zip, async (e) => {
      e[DECK_ENTRY] = Uint8Array.from([0xff, 0xfe, 0xfd]);
      const m = manifestOf(zip);
      m['contentHash'] = await digest(e[DECK_ENTRY]);
      e[MANIFEST_ENTRY] = strToU8(JSON.stringify(m));
    });
    await rejected(binary, 'bad-zip', /UTF-8/);
  });

  it('rejects hostile keys and unknown fields in the deck', async () => {
    const f = await fixture();
    const base = await packed(f);
    const json = JSON.stringify(f.deck).replace(/^\{/, '{"__proto__":{"polluted":true},');
    await rejected(await withDeckJson(base, json), 'invalid-deck', /not valid/);
    await rejected(await withDeckJson(base, { ...f.deck, html: '<script>' }), 'invalid-deck', /html/);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('refuses a deck from a newer schema as read-only', async () => {
    const f = await fixture();
    const zip = await withDeckJson(await packed(f), { ...f.deck, schemaVersion: SCHEMA_VERSION + 1 });
    await rejected(zip, 'read-only', /newer than the supported version/);
  });

  it('rejects an asset with a mime type that is not on the allow-list', async () => {
    const f = await fixture();
    const deck = structuredClone(f.deck);
    deck.assets[f.imageId].mime = 'application/x-msdownload';
    await rejected(await withDeckJson(await packed(f), deck), 'invalid-deck', /mime type "application\/x-msdownload" is not allowed/);
  });

  it('checks the content of an asset, not its extension or declared type', async () => {
    const exe = strToU8('MZ\u0090\u0000 this is not a picture');
    const { id, ref } = await assetFor(exe, 'image/png');
    const f = await fixture();
    f.deck.assets = { [id]: ref };
    f.deck.slides[0].elements = [];
    f.assets = new Map([[id, exe]]);
    // Hash and size agree, so the writer packs it; only the content check can refuse it.
    const written = await writeArchive(f.deck, f.assets);
    await rejected(written.ok ? written.value : new Uint8Array(), 'bad-mime', /content is not image\/png/);
  });

  it('rejects an asset file whose extension does not belong to its mime type', async () => {
    const f = await fixture();
    const zip = await reworked(await packed(f), (e) => {
      e[assetEntryName(f.imageId, 'jpg')] = e[assetEntryName(f.imageId, 'png')];
      delete e[assetEntryName(f.imageId, 'png')];
    });
    await rejected(zip, 'missing-entry', /is missing from the file/);
  });

  it('rejects an asset whose bytes do not match its id', async () => {
    const f = await fixture();
    const zip = await reworked(await packed(f), (e) => void (e[assetEntryName(f.imageId, 'png')] = pngBytes(99).slice(0, f.assets.get(f.imageId)!.length)));
    await rejected(zip, 'hash-mismatch', /does not match its hash/);
  });

  it('rejects an asset whose size differs from the deck', async () => {
    const f = await fixture();
    const zip = await reworked(await packed(f), (e) => void (e[assetEntryName(f.imageId, 'png')] = Uint8Array.from([...PNG_HEADER, 1])));
    await rejected(zip, 'bad-asset', /size is/);
  });

  it('rejects an asset whose id, hash and key differ', async () => {
    const f = await fixture();
    const deck = structuredClone(f.deck);
    deck.assets[f.imageId].blobKey = 'b'.repeat(64);
    await rejected(await withDeckJson(await packed(f), deck), 'bad-asset', /differ/);
  });

  it('rejects a thumbnail that is not a PNG', async () => {
    const zip = await reworked(await packed(await fixture()), (e) => void (e[THUMBNAIL_ENTRY] = strToU8('GIF89a')));
    await rejected(zip, 'bad-asset', /thumbnail\.png is not a PNG/);
  });
});

describe('reader: older versions', () => {
  it('migrates an older deck automatically (Q12)', async () => {
    const png = pngBytes(5);
    const { id } = await assetFor(png);
    const old = structuredClone(DECK_V0) as Record<string, unknown>;
    old['assets'] = { [id]: { blobKey: id, mime: 'image/png', hash: id, size: png.length } };
    (old['slides'] as { elements: Record<string, unknown>[] }[])[0].elements[1]['assetId'] = id;
    const f = await fixture({ pictures: 0 });
    const base = await packed(f);
    const zip = await reworked(base, async (e) => {
      e[assetEntryName(id, 'png')] = png;
      const bytes = strToU8(JSON.stringify(old));
      e[DECK_ENTRY] = bytes;
      e[MANIFEST_ENTRY] = strToU8(JSON.stringify({ ...manifestOf(base), schemaVersion: 0, contentHash: await digest(bytes) }));
    });
    const result = await readArchive(zip);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.migrated).toBe(true);
    expect(result.value.deck.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.value.deck.title).toBe('Fixture deck');
    expect(result.value.deck.stage).toEqual({ width: 1920, height: 1080 });
    expect(Array.from(result.value.assets.get(id)!.bytes)).toEqual(Array.from(png));
    // The hash is the one of the bytes in the file, not of the migrated deck.
    expect(result.value.hash).toBe(await digest(strToU8(JSON.stringify(old))));
  });

  it('does not change the document it was given', async () => {
    const f = await fixture({ code: true });
    const frozen = deepFreeze(structuredClone(f.deck)) as Deck;
    const written = await writeArchive(frozen, f.assets);
    expect(written.ok).toBe(true);
  });
});

describe('format tables', () => {
  it('has a file extension for every mime type the validator allows, and no others', () => {
    expect(Object.keys(MIME_EXTENSIONS).sort()).toEqual([...DEFAULT_VALIDATION_OPTIONS.allowedMimeTypes].sort());
  });

  it('does not treat inherited names as mime types', () => {
    expect(extensionFor('toString')).toBeNull();
    expect(extensionFor('constructor')).toBeNull();
    expect(extensionFor('__proto__')).toBeNull();
    expect(contentProblem(new Uint8Array(4), 'constructor')).toMatch(/no content check/);
    expect(contentProblem(new Uint8Array(4), 'hasOwnProperty')).toMatch(/no content check/);
  });
});

describe('content checks', () => {
  const bytes = (...values: (number | string)[]) => Uint8Array.from(values.flatMap((v) => (typeof v === 'string' ? Array.from(v, (c) => c.charCodeAt(0)) : [v])));
  const valid: [string, Uint8Array][] = [
    ['image/png', bytes(...PNG_HEADER)],
    ['image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['image/gif', bytes('GIF89a')],
    ['image/webp', bytes('RIFF', 0, 0, 0, 0, 'WEBP')],
    ['image/avif', bytes(0, 0, 0, 0, 'ftypavif')],
    ['image/svg+xml', strToU8('<?xml version="1.0"?>\n<!-- c -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['video/mp4', bytes(0, 0, 0, 0, 'ftypisom')],
    ['video/webm', bytes(0x1a, 0x45, 0xdf, 0xa3)],
    ['audio/mpeg', bytes('ID3')],
    ['audio/ogg', bytes('OggS')],
    ['audio/wav', bytes('RIFF', 0, 0, 0, 0, 'WAVE')],
    ['font/woff', bytes('wOFF')],
    ['font/woff2', bytes('wOF2')],
    ['font/ttf', bytes(0, 1, 0, 0)],
    ['font/otf', bytes('OTTO')],
    ['text/javascript', strToU8('export const a = 1;')],
    ['text/css', strToU8('a { color: red }')],
    ['application/json', strToU8('{"a":[1,2]}')],
  ];

  it('covers every allowed mime type', () => {
    expect(valid.map(([m]) => m).sort()).toEqual([...DEFAULT_VALIDATION_OPTIONS.allowedMimeTypes].sort());
  });

  it.each(valid)('accepts real %s content', (mime, content) => {
    expect(contentProblem(content, mime)).toBeNull();
  });

  it.each(valid)('rejects %s declared for empty and for foreign content', (mime) => {
    // An empty script or style sheet is a valid one.
    if (mime !== 'text/javascript' && mime !== 'text/css') expect(contentProblem(new Uint8Array(0), mime)).not.toBeNull();
    expect(contentProblem(strToU8('MZ\u0090\u0000'), mime)).not.toBeNull();
  });

  it('is case-insensitive about the declared type', () => {
    expect(contentProblem(bytes(...PNG_HEADER), 'IMAGE/PNG')).toBeNull();
  });

  it.each([
    ['a script element', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['a javascript: link', '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>'],
    ['text before the svg element', 'hello <svg></svg>'],
    ['an event handler', '<svg onload="alert(1)"></svg>'],
    ['a foreignObject', '<svg><foreignObject><div/></foreignObject></svg>'],
    ['a huge prologue', `${'<!-- -->'.repeat(1000)}<svg></svg>`],
  ])('rejects an SVG with %s', (_name, svg) => {
    expect(contentProblem(strToU8(svg), 'image/svg+xml')).not.toBeNull();
  });

  it('rejects invalid UTF-8, NUL bytes and invalid JSON in text assets', () => {
    expect(contentProblem(bytes(0xff, 0xfe), 'text/css')).not.toBeNull();
    expect(contentProblem(bytes('a', 0, 'b'), 'text/javascript')).not.toBeNull();
    expect(contentProblem(strToU8('{'), 'application/json')).not.toBeNull();
  });
});

describe('a bundle is not a deck', () => {
  it('rejects a ZIP of .deck files with a message that names the entry', async () => {
    const inner = await packed(await fixture());
    const outer = zipSync({ 'one.deck': inner });
    await rejected(outer, 'unexpected-entry', /one\.deck/);
  });
});
