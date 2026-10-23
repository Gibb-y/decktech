import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ID_PATTERN, type ComponentDef } from '../src/app/core/model';
import { libraryEntryProblem, type LibraryComponent } from '../src/app/core/persistence/library';
import { ToolError } from './tool';

/**
 * The component library as a folder of `<id>.json` files holding `LibraryComponent` records.
 * This is the server's own store: the browser library lives in IndexedDB and cannot be reached
 * from Node. Entries with asset files (`files`, `libs`) are not supported, since the bytes would
 * have to travel too.
 */
export class FileLibrary {
  constructor(private readonly dir: string) {}

  private fileOf(id: string): string {
    if (!ID_PATTERN.test(id))
      throw new ToolError(
        `"${id}" is not a valid library id (letters, digits, "_" and "-", at most 128)`,
      );
    return join(this.dir, `${id}.json`);
  }

  async list(): Promise<LibraryComponent[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const entries: LibraryComponent[] = [];
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const entry = await this.read(name.slice(0, -'.json'.length));
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /** `undefined` when absent; a file that does not hold a valid entry counts as absent (it is untrusted input). */
  async read(id: string): Promise<LibraryComponent | undefined> {
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
    return libraryEntryProblem(entry) === null && (entry as LibraryComponent).def.id === id
      ? (entry as LibraryComponent)
      : undefined;
  }

  async save(def: ComponentDef): Promise<LibraryComponent> {
    if (def.files.length > 0 || def.libs.length > 0) {
      throw new ToolError(
        'Components with asset files or vendored libraries cannot be saved to the file library, because their files would not travel with them',
      );
    }
    const entry: LibraryComponent = { def: structuredClone(def), assets: {}, savedAt: Date.now() };
    const problem = libraryEntryProblem(entry);
    if (problem) throw new ToolError(`This component cannot be saved to the library: ${problem}`);
    await mkdir(this.dir, { recursive: true });
    const file = this.fileOf(def.id);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(entry, null, 2));
      await rename(temp, file);
    } catch (e) {
      await rm(temp, { force: true });
      throw e;
    }
    return entry;
  }
}
