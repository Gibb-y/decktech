import { TestBed } from '@angular/core/testing';
import { FILE_ENVIRONMENT, FileAccess, type PickerWindow } from './file-access';

function make(picker: PickerWindow | null) {
  TestBed.configureTestingModule({
    providers: [{ provide: FILE_ENVIRONMENT, useValue: { window: picker ?? {}, document } }],
  });
  return TestBed.inject(FileAccess);
}

const abort = () => Object.assign(new Error('dismissed'), { name: 'AbortError' });

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('FileAccess with the File System Access API', () => {
  it('detects the pickers', () => {
    expect(make({ showSaveFilePicker: vi.fn(), showOpenFilePicker: vi.fn() }).hasPickers).toBe(true);
  });

  it('writes through the save picker', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable: async () => ({ write, close }) });
    const files = make({ showSaveFilePicker });
    const bytes = Uint8Array.from([1, 2, 3]);
    await expect(files.save('talk.deck', bytes)).resolves.toBe('saved');
    expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'talk.deck' }));
    expect(write).toHaveBeenCalledWith(bytes);
    expect(close).toHaveBeenCalled();
  });

  it('downloads instead when the click that allowed the picker is gone', async () => {
    const lost = Object.assign(new Error('user activation'), { name: 'SecurityError' });
    const create = vi.fn().mockReturnValue('blob:y');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const files = make({ showSaveFilePicker: vi.fn().mockRejectedValue(lost) });
    await expect(files.save('big.deck', new Uint8Array(1))).resolves.toBe('saved');
    expect(click).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('offers .zip for a bundle', async () => {
    const showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable: async () => ({ write: async () => undefined, close: async () => undefined }) });
    await make({ showSaveFilePicker }).save('all.zip', new Uint8Array(1));
    expect(showSaveFilePicker.mock.calls[0][0].types[0].accept).toEqual({ 'application/zip': ['.zip'] });
  });

  it('treats a dismissed dialog as cancelled and passes other errors on', async () => {
    const dismissed = make({ showSaveFilePicker: vi.fn().mockRejectedValue(abort()), showOpenFilePicker: vi.fn().mockRejectedValue(abort()) });
    await expect(dismissed.save('a.deck', new Uint8Array(1))).resolves.toBe('cancelled');
    await expect(dismissed.open()).resolves.toBeNull();
    TestBed.resetTestingModule();
    const broken = make({ showSaveFilePicker: vi.fn().mockRejectedValue(new Error('denied')), showOpenFilePicker: vi.fn().mockRejectedValue(new Error('denied')) });
    await expect(broken.save('a.deck', new Uint8Array(1))).rejects.toThrow('denied');
    await expect(broken.open()).rejects.toThrow('denied');
  });

  it('opens the chosen file', async () => {
    const file = new File(['x'], 'a.deck');
    const files = make({ showOpenFilePicker: vi.fn().mockResolvedValue([{ getFile: async () => file }]) });
    await expect(files.open()).resolves.toBe(file);
  });
});

describe('FileAccess without the File System Access API (fallback)', () => {
  it('reports no pickers', () => {
    expect(make(null).hasPickers).toBe(false);
  });

  it('downloads through an anchor with the file name and cleans up', async () => {
    vi.useFakeTimers();
    const create = vi.fn().mockReturnValue('blob:x');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    let clicked: HTMLAnchorElement | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked = this;
      expect(document.body.contains(this)).toBe(true);
    });
    await expect(make(null).save('talk.deck', Uint8Array.from([9]))).resolves.toBe('saved');
    const link = clicked as unknown as HTMLAnchorElement;
    expect(link.download).toBe('talk.deck');
    expect(link.getAttribute('href')).toBe('blob:x');
    expect(document.body.contains(link)).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0][0] as Blob).type).toBe('application/zip');
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens a file through an input element', async () => {
    const file = new File(['x'], 'a.deck');
    let input: HTMLInputElement | null = null;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      input = this;
    });
    const pending = make(null).open();
    const chosen = input as unknown as HTMLInputElement;
    expect(chosen.type).toBe('file');
    expect(chosen.accept).toContain('.deck');
    Object.defineProperty(chosen, 'files', { value: { item: () => file } });
    chosen.dispatchEvent(new Event('change'));
    await expect(pending).resolves.toBe(file);
    expect(document.body.contains(chosen)).toBe(false);
  });

  it('answers null when the dialog is cancelled', async () => {
    let input: HTMLInputElement | null = null;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      input = this;
    });
    const pending = make(null).open();
    (input as unknown as HTMLInputElement).dispatchEvent(new Event('cancel'));
    await expect(pending).resolves.toBeNull();
  });

  it('fails clearly when there is no browser', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: FILE_ENVIRONMENT, useValue: null }] });
    const files = TestBed.inject(FileAccess);
    expect(files.hasPickers).toBe(false);
    await expect(files.save('a.deck', new Uint8Array(1))).rejects.toThrow(/cannot be saved/);
    await expect(files.open()).rejects.toThrow(/cannot be opened/);
  });
});
