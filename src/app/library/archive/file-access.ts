import { InjectionToken, Service, inject } from '@angular/core';

/** The File System Access API is not in `lib.dom` for every target; only what is used is declared. */
interface WritableFile {
  write(data: BlobPart): Promise<void>;
  close(): Promise<void>;
}
interface FileHandle {
  createWritable(): Promise<WritableFile>;
  getFile(): Promise<File>;
}
interface PickerOptions {
  suggestedName?: string;
  multiple?: boolean;
  types?: { description: string; accept: Record<string, string[]> }[];
}
export interface PickerWindow {
  showSaveFilePicker?(options?: PickerOptions): Promise<FileHandle>;
  showOpenFilePicker?(options?: PickerOptions): Promise<FileHandle[]>;
}

/** The browser objects file access needs; replaced in tests to exercise both paths. */
export interface FileEnvironment {
  window: PickerWindow;
  document: Document;
}

export const FILE_ENVIRONMENT = new InjectionToken<FileEnvironment | null>('File environment', {
  providedIn: 'root',
  factory: () => (typeof window === 'undefined' ? null : { window: window as unknown as PickerWindow, document }),
});

export type SaveOutcome = 'saved' | 'cancelled';

const ZIP = 'application/zip';
const REVOKE_AFTER_MS = 30_000;

const isAbort = (e: unknown): boolean => typeof e === 'object' && e !== null && 'name' in e && (e as { name: unknown }).name === 'AbortError';

/**
 * Saving and opening files (arc42 §3): the save / open pickers of the File System Access API
 * where the browser has them (feature-detected on every call), otherwise a download through an
 * anchor and an `<input type="file">`. A dismissed picker is not an error: `save` answers
 * `'cancelled'` and `open` answers `null`.
 */
@Service()
export class FileAccess {
  private readonly env = inject(FILE_ENVIRONMENT);

  /** Whether the native pickers are available. */
  get hasPickers(): boolean {
    const w = this.env?.window;
    return typeof w?.showSaveFilePicker === 'function' && typeof w?.showOpenFilePicker === 'function';
  }

  /** Writes `bytes` as `name`. Resolves when the file is written (picker) or the download is started (fallback). */
  async save(name: string, bytes: Uint8Array): Promise<SaveOutcome> {
    const env = this.env;
    if (!env) throw new Error('Files cannot be saved here.');
    const picker = env.window.showSaveFilePicker;
    if (typeof picker === 'function') {
      try {
        const handle = await picker.call(env.window, { suggestedName: name, types: [typesFor(name)] });
        const writable = await handle.createWritable();
        await writable.write(bytes as BlobPart);
        await writable.close();
        return 'saved';
      } catch (e) {
        if (isAbort(e)) return 'cancelled';
        throw e;
      }
    }
    this.download(env.document, name, bytes);
    return 'saved';
  }

  /** Lets the user choose a `.deck` file; `null` when they dismiss the dialog. */
  async open(): Promise<File | null> {
    const env = this.env;
    if (!env) throw new Error('Files cannot be opened here.');
    const picker = env.window.showOpenFilePicker;
    if (typeof picker === 'function') {
      try {
        const [handle] = await picker.call(env.window, { multiple: false, types: [typesFor('x.deck')] });
        return handle ? await handle.getFile() : null;
      } catch (e) {
        if (isAbort(e)) return null;
        throw e;
      }
    }
    return this.chooseWithInput(env.document);
  }

  private download(document: Document, name: string, bytes: Uint8Array): void {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: ZIP }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoking at once can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }

  private chooseWithInput(document: Document): Promise<File | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.deck,application/zip';
      input.hidden = true;
      const finish = (file: File | null) => {
        input.remove();
        resolve(file);
      };
      input.addEventListener('change', () => finish(input.files?.item(0) ?? null), { once: true });
      // Not every browser fires `cancel`; where it does not, the promise stays pending and nothing waits for it.
      input.addEventListener('cancel', () => finish(null), { once: true });
      document.body.appendChild(input);
      input.click();
    });
  }
}

function typesFor(name: string): { description: string; accept: Record<string, string[]> } {
  const extension = name.slice(name.lastIndexOf('.'));
  return { description: extension === '.deck' ? 'DeckTech deck' : 'ZIP archive', accept: { [ZIP]: [extension] } };
}
