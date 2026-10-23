import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ID_PATTERN, type AssetRef, type ComponentDef } from '../src/app/core/model';
import { isAssetId, sha256Hex } from '../src/app/core/persistence/assets';
import { libraryEntryProblem, type LibraryComponent } from '../src/app/core/persistence/library';
import { ToolError } from './tool';
import type { VendoredLibrary } from './workspace';

/**
 * The component library as a folder of `<id>.json` files holding `LibraryComponent` records.
 * This is the server's own store: the browser library lives in IndexedDB and cannot be reached
 * from Node. The bytes of the assets an entry reads (`files`, `libs`) are kept next to it in
 * `assets/<sha256>`, shared by every entry; they are checked against their hash when read.
 */
/** What the file library writes: a `LibraryComponent` plus the names the server gave the libraries (the browser's store has no such field). */
export type StoredEntry = LibraryComponent & { names?: Record<string, VendoredLibrary> };

export class FileLibrary {
  constructor(private readonly dir: string) {}

  private fileOf(id: string): string {
    if (!ID_PATTERN.test(id))
      throw new ToolError(
        `"${id}" is not a valid library id (letters, digits, "_" and "-", at most 128)`,
      );
    return join(this.dir, `${id}.json`);
  }

  async list(): Promise<StoredEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const entries: StoredEntry[] = [];
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const entry = await this.read(name.slice(0, -'.json'.length));
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /** `undefined` when absent; a file that does not hold a valid entry counts as absent (it is untrusted input). */
  async read(id: string): Promise<StoredEntry | undefined> {
    let text: string;
    try {
      text = await readFile(this.fileOf(id), 'utf8');
    } catch {
      return undefined;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(text);
    } catch {
      return undefined;
    }
    return libraryEntryProblem(entry) === null && (entry as StoredEntry).def.id === id
      ? (entry as StoredEntry)
      : undefined;
  }

  /** Bytes of an asset of the library, or `undefined` if absent or if they do not match the hash they are stored under. */
  async readAsset(id: string): Promise<Uint8Array | undefined> {
    if (!isAssetId(id)) return undefined;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(this.dir, 'assets', id)));
    } catch {
      return undefined;
    }
    return (await sha256Hex(bytes as BufferSource)) === id ? bytes : undefined;
  }

  /**
   * Saves a definition with the assets it reads. `held` gives the ref and bytes of the deck's
   * assets; a definition whose assets are not all held is refused, so an entry never points at
   * bytes that are missing.
   */
  async save(
    def: ComponentDef,
    held: ReadonlyMap<string, { ref: AssetRef; bytes: Uint8Array }> = new Map(),
    names: ReadonlyMap<string, VendoredLibrary> = new Map(),
  ): Promise<StoredEntry> {
    const assets: Record<string, AssetRef> = {};
    for (const id of new Set([...def.files, ...def.libs])) {
      const asset = held.get(id);
      if (!asset) throw new ToolError(`The component reads the asset "${id}", whose file this session does not hold, so it cannot be saved with it`);
      assets[id] = structuredClone(asset.ref);
    }
    const entry: StoredEntry = { def: structuredClone(def), assets, savedAt: Date.now() };
    const problem = libraryEntryProblem(entry);
    if (problem) throw new ToolError(`This component cannot be saved to the library: ${problem}`);
    const known = def.libs.filter((id) => names.has(id));
    if (known.length > 0) entry.names = Object.fromEntries(known.map((id) => [id, { ...names.get(id)! }]));
    await mkdir(join(this.dir, 'assets'), { recursive: true });
    for (const id of Object.keys(assets)) await this.write(join(this.dir, 'assets', id), held.get(id)!.bytes);
    await this.write(this.fileOf(def.id), JSON.stringify(entry, null, 2));
    return entry;
  }

  /** Writes through a temporary file, so a reader never sees half a file. */
  private async write(file: string, data: string | Uint8Array): Promise<void> {
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, data);
      await rename(temp, file);
    } catch (e) {
      await rm(temp, { force: true });
      throw e;
    }
  }
}
