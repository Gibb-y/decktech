import { TestBed, type ComponentFixture } from '@angular/core/testing';
import axe from 'axe-core';
import { createDeck, err } from '../model';
import { DeckStore } from '../store';
import { AutosaveService } from './autosave';
import { DeckRepository } from './deck-repository';
import type { PersistenceError } from './errors';
import { InMemoryDeckRepository } from './memory-deck-repository';
import { PersistenceBanner } from './persistence-banner';
import { DECK_EXPORT_HANDLER, STORAGE_MANAGER, type DeckExportHandler } from './tokens';

async function setup(exporter: DeckExportHandler | null = null) {
  const repo = new InMemoryDeckRepository();
  TestBed.configureTestingModule({
    providers: [
      { provide: DeckRepository, useValue: repo },
      { provide: STORAGE_MANAGER, useValue: null },
      { provide: DECK_EXPORT_HANDLER, useValue: exporter },
    ],
  });
  const autosave = TestBed.inject(AutosaveService);
  const fixture = TestBed.createComponent(PersistenceBanner);
  autosave.create(createDeck());
  await fixture.whenStable();
  return { repo, autosave, fixture };
}

/** Makes the next write fail and runs it. */
async function failWith(
  { repo, autosave, fixture }: Awaited<ReturnType<typeof setup>>,
  error: PersistenceError,
): Promise<void> {
  vi.spyOn(repo, 'save').mockResolvedValue(err(error));
  expect(await autosave.flush()).toBe(false);
  await fixture.whenStable();
}

const el = (fixture: ComponentFixture<PersistenceBanner>): HTMLElement => fixture.nativeElement as HTMLElement;
const buttons = (fixture: ComponentFixture<PersistenceBanner>): string[] =>
  Array.from(el(fixture).querySelectorAll('button'), (b) => b.textContent.trim());

async function axeViolations(root: HTMLElement) {
  document.body.appendChild(root);
  try {
    // jsdom has no layout or computed colours, so contrast is checked by the palette instead.
    const results = await axe.run(root, { rules: { 'color-contrast': { enabled: false } } });
    return results.violations;
  } finally {
    root.remove();
  }
}

describe('PersistenceBanner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing while saving works', async () => {
    const { fixture, autosave } = await setup();
    await autosave.flush();
    await fixture.whenStable();
    expect(el(fixture).querySelector('[role="alert"]')).toBeNull();
  });

  it('shows a persistent alert when a write fails', async () => {
    const ctx = await setup();
    await failWith(ctx, { kind: 'quota', message: 'storage quota exceeded' });

    const alert = el(ctx.fixture).querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('Your changes are not saved.');
    expect(alert?.textContent).toContain('storage is full');
    expect(ctx.autosave.status()).toBe('error');
  });

  it.each([
    ['conflict', 'another tab'],
    ['read-only', 'newer version'],
    ['storage', 'IDB exploded'],
  ] as const)('explains a %s failure', async (kind, expected) => {
    const ctx = await setup();
    await failWith(ctx, { kind, message: 'IDB exploded' });
    expect(el(ctx.fixture).textContent).toContain(expected);
  });

  it('is accessible (AXE) while showing, with and without the download action', async () => {
    for (const exporter of [null, vi.fn()]) {
      TestBed.resetTestingModule();
      const ctx = await setup(exporter);
      await failWith(ctx, { kind: 'quota', message: 'x' });
      expect(await axeViolations(el(ctx.fixture))).toEqual([]);
    }
  });

  it('offers retry, which clears the banner once the write succeeds', async () => {
    const ctx = await setup();
    await failWith(ctx, { kind: 'storage', message: 'busy' });
    vi.restoreAllMocks();

    const retry = Array.from(el(ctx.fixture).querySelectorAll('button')).find((b) => b.textContent.includes('Try again'));
    retry?.click();
    await ctx.fixture.whenStable();
    await vi.waitFor(() => expect(ctx.autosave.status()).toBe('saved'));
    await ctx.fixture.whenStable();
    expect(el(ctx.fixture).querySelector('[role="alert"]')).toBeNull();
  });

  it('has no Download action until an export handler is provided', async () => {
    const ctx = await setup(null);
    await failWith(ctx, { kind: 'quota', message: 'x' });
    expect(buttons(ctx.fixture)).toEqual(['Try again']);
  });

  it('runs the export hook with the open deck', async () => {
    const exporter = vi.fn();
    const ctx = await setup(exporter);
    await failWith(ctx, { kind: 'quota', message: 'x' });
    expect(buttons(ctx.fixture)).toEqual(['Try again', 'Download .deck']);

    el(ctx.fixture).querySelectorAll('button')[1].click();
    await ctx.fixture.whenStable();
    expect(exporter).toHaveBeenCalledTimes(1);
    expect(exporter.mock.calls[0][0]).toBe(TestBed.inject(DeckStore).deck());
  });

  it('says so when the download itself fails, and keeps the banner', async () => {
    const ctx = await setup(() => Promise.reject(new Error('zip failed')));
    await failWith(ctx, { kind: 'quota', message: 'x' });
    el(ctx.fixture).querySelectorAll('button')[1].click();
    await vi.waitFor(() => expect(el(ctx.fixture).textContent).toContain('The download failed'));
    expect(el(ctx.fixture).querySelector('[role="alert"]')).not.toBeNull();
  });
});
