import { createElement, validateDeck, type TableEl, type VideoEl } from '../../core/model';
import { assetFor, fixture, packed } from './archive-fixtures';
import { readArchive } from './reader';

const mp4 = (seed: number): Uint8Array => Uint8Array.from([0, 0, 0, 24, ...[...'ftypisom'].map((c) => c.charCodeAt(0)), 0, 0, 2, 0, seed, 1, 2, 3]);
const webm = (seed: number): Uint8Array => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, seed]);

describe('export and import of tables and videos', () => {
  it('gives back a table with a header, column widths and cell fills', async () => {
    const f = await fixture();
    const table = createElement('table', {
      rows: [['Item', 'Qty', '<b>x</b>'], ['Apples', '3', 'line\nbreak']],
      header: true,
      columnWidths: [2, 1, 1.5],
      cellFills: [[{ token: 'accent' }, null, '#336699'], [null, null, null]],
    });
    f.deck.slides[0].elements.push(table);
    const result = await readArchive(await packed(f));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deck).toEqual(f.deck);
    expect(result.value.deck.slides[0].elements.at(-1)).toEqual<TableEl>(table);
    expect(validateDeck(result.value.deck).ok).toBe(true);
  });

  it.each([
    ['mp4', 'video/mp4', mp4(1)],
    ['webm', 'video/webm', webm(2)],
  ])('gives back a %s video with its poster and every option, bytes included', async (_name, mime, bytes) => {
    const f = await fixture();
    const video = await assetFor(bytes, mime);
    const poster = await assetFor(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]));
    f.deck.assets[video.id] = video.ref;
    f.deck.assets[poster.id] = poster.ref;
    f.assets.set(video.id, bytes);
    f.assets.set(poster.id, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]));
    const element = createElement('video', { assetId: video.id, poster: poster.id, autoplay: true, loop: true, muted: true, label: 'Demo' });
    f.deck.slides[0].elements.push(element);
    const result = await readArchive(await packed(f));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deck.slides[0].elements.at(-1)).toEqual<VideoEl>(element);
    expect(Array.from(result.value.assets.get(video.id)!.bytes)).toEqual(Array.from(bytes));
    expect(result.value.assets.get(video.id)!.ref.mime).toBe(mime);
    expect(result.value.assets.has(poster.id)).toBe(true);
  });

  it('refuses a deck whose video poster points at an asset that is not in the file', async () => {
    const f = await fixture();
    const video = await assetFor(mp4(3), 'video/mp4');
    f.deck.assets[video.id] = video.ref;
    f.assets.set(video.id, mp4(3));
    f.deck.slides[0].elements.push(createElement('video', { assetId: video.id, poster: 'f'.repeat(64) }));
    const result = await readArchive(await packed(f));
    expect(result.ok).toBe(false);
  });
});
