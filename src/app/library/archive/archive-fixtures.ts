import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { createDeck, createElement, type AssetRef, type ComponentDef, type Deck } from '../../core/model';
import { sha256Hex } from '../../core/persistence/assets';
import { MANIFEST_ENTRY, DECK_ENTRY } from './format';
import { writeArchive } from './writer';

/** Test helpers shared by the archive specs: small valid assets, a deck that uses them, and raw ZIP surgery. */

export const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Starts like a PNG; `seed` makes the content (and so the hash) unique. */
export const pngBytes = (seed = 0): Uint8Array => Uint8Array.from([...PNG_HEADER, 1, 2, 3, 4, seed, seed >> 8]);

export const digest = (bytes: Uint8Array): Promise<string> => sha256Hex(bytes.slice().buffer);

export async function assetFor(bytes: Uint8Array, mime = 'image/png'): Promise<{ id: string; ref: AssetRef }> {
  const id = await digest(bytes);
  return { id, ref: { blobKey: id, mime, hash: id, size: bytes.length } };
}

export const COMPONENT: ComponentDef = {
  id: 'cmp_counter',
  name: 'Counter',
  html: '<button id="b">+</button>',
  css: '#b { font-size: 40px }',
  js: 'deck.ready(() => {})',
  propSchema: [],
  permissions: [],
  files: [],
  libs: [],
};

export interface Fixture {
  deck: Deck;
  assets: Map<string, Uint8Array>;
  /** Id of the picture asset. */
  imageId: string;
}

/** A valid deck with one picture on its slide, optionally with a code component. */
export async function fixture(options: { code?: boolean; pictures?: number } = {}): Promise<Fixture> {
  const deck = createDeck('Round trip');
  const assets = new Map<string, Uint8Array>();
  let imageId = '';
  for (let i = 0; i < (options.pictures ?? 1); i++) {
    const bytes = pngBytes(i);
    const { id, ref } = await assetFor(bytes);
    deck.assets[id] = ref;
    assets.set(id, bytes);
    deck.slides[0].elements.push(createElement('image', { assetId: id, alt: `Picture ${i}` }));
    imageId ||= id;
  }
  if (options.code) {
    deck.components.push(structuredClone(COMPONENT));
    deck.slides[0].elements.push(createElement('code', { componentId: COMPONENT.id }));
  }
  return { deck, assets, imageId };
}

export async function packed(f: Fixture): Promise<Uint8Array> {
  const result = await writeArchive(f.deck, f.assets);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export type Entries = Record<string, Uint8Array>;

/** Opens a good archive, lets `change` edit its entries, and packs it again (level 6 everywhere). */
export async function reworked(zip: Uint8Array, change: (entries: Entries) => void | Promise<void>): Promise<Uint8Array> {
  const entries = unzipSync(zip);
  await change(entries);
  return zipSync(entries as Zippable);
}

/** Replaces `deck.json` with `json` and makes the manifest agree, so only the deck itself is at fault. */
export async function withDeckJson(zip: Uint8Array, json: unknown): Promise<Uint8Array> {
  return reworked(zip, async (entries) => {
    const bytes = strToU8(typeof json === 'string' ? json : JSON.stringify(json));
    entries[DECK_ENTRY] = bytes;
    const manifest = JSON.parse(new TextDecoder().decode(entries[MANIFEST_ENTRY])) as Record<string, unknown>;
    manifest['contentHash'] = await digest(bytes);
    entries[MANIFEST_ENTRY] = strToU8(JSON.stringify(manifest));
  });
}

/** Rewrites a field of the central directory entry called `name` (the sizes a reader trusts before inflating). */
export function patchCentral(zip: Uint8Array, name: string, field: 'size' | 'originalSize', value: number): Uint8Array {
  const copy = zip.slice();
  const view = new DataView(copy.buffer);
  for (let i = 0; i + 46 < copy.length; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(i + 28, true);
    if (new TextDecoder().decode(copy.subarray(i + 46, i + 46 + nameLength)) === name) {
      view.setUint32(i + (field === 'size' ? 20 : 24), value, true);
      return copy;
    }
  }
  throw new Error(`no central directory entry ${name}`);
}

/** Replaces every occurrence of the bytes of `from` by those of `to` (same length), e.g. to forge a duplicate entry name. */
export function renameBytes(zip: Uint8Array, from: string, to: string): Uint8Array {
  if (from.length !== to.length) throw new Error('names must have the same length');
  const copy = zip.slice();
  const a = strToU8(from);
  const b = strToU8(to);
  for (let i = 0; i + a.length <= copy.length; i++) {
    if (a.every((byte, k) => copy[i + k] === byte)) copy.set(b, i);
  }
  return copy;
}
