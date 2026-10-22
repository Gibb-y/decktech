import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import axe from 'axe-core';
import { DeckRepository, InMemoryDeckRepository } from '../core/persistence';
import { fixture as deckFixture, packed, type Fixture } from './archive/archive-fixtures';
import { FileAccess, type SaveOutcome } from './archive';
import { LibraryPage } from './library-page';

class FakeFiles {
  saved: { name: string; bytes: Uint8Array }[] = [];
  chosen: File | null = null;
  outcome: SaveOutcome = 'saved';
  async save(name: string, bytes: Uint8Array): Promise<SaveOutcome> {
    if (this.outcome === 'saved') this.saved.push({ name, bytes });
    return this.outcome;
  }
  async open(): Promise<File | null> {
    return this.chosen;
  }
}

async function setup() {
  const repo = new InMemoryDeckRepository(() => 1_000);
  const files = new FakeFiles();
  TestBed.configureTestingModule({
    providers: [{ provide: DeckRepository, useValue: repo }, { provide: FileAccess, useValue: files }, provideRouter([])],
  });
  vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(LibraryPage);
  document.body.appendChild(fixture.nativeElement);
  await settle(fixture);
  return { repo, files, fixture };
}

/** Waits until the library has finished what it was asked to do; hashing and unzipping take real time. */
async function settle(fixture: ComponentFixture<LibraryPage>): Promise<void> {
  const library = fixture.componentInstance['library'];
  for (let i = 0; i < 200; i++) {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 5));
    if (!library.busy()) break;
  }
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r));
  await fixture.whenStable();
}

const root = (f: ComponentFixture<LibraryPage>) => f.nativeElement as HTMLElement;
const button = (f: ComponentFixture<LibraryPage>, name: string | RegExp): HTMLButtonElement => {
  const found = Array.from(root(f).querySelectorAll('button')).find((b) => (typeof name === 'string' ? b.textContent.trim() === name : name.test(b.textContent.trim())));
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const rowTitles = (f: ComponentFixture<LibraryPage>) => Array.from(root(f).querySelectorAll('li.deck .title')).map((t) => t.textContent.trim());

const asFile = (bytes: Uint8Array) => new File([bytes as BlobPart], 'talk.deck');

async function stored(repo: InMemoryDeckRepository, f: Fixture): Promise<void> {
  for (const [, bytes] of f.assets) await repo.putAsset(new Blob([bytes as BlobPart], { type: 'image/png' }));
  await repo.save(f.deck, null);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('LibraryPage files', () => {
  it('imports a deck, lists it, announces it and warns about code without opening it', async () => {
    const { fixture, files } = await setup();
    files.chosen = asFile(await packed(await deckFixture({ code: true })));
    button(fixture, 'Import deck…').click();
    await settle(fixture);
    expect(rowTitles(fixture)).toEqual(['Round trip']);
    const notice = root(fixture).querySelector('.notice');
    expect(notice?.textContent).toContain('Imported “Round trip”');
    expect(notice?.textContent).toContain('contains code components');
    expect(notice?.textContent).toContain('stay switched off');
    expect(notice?.querySelector('a')?.getAttribute('href')).toMatch(/^\/deck\/dk_/);
    expect(TestBed.inject(Router).navigate).not.toHaveBeenCalled();
  });

  it('does not mention code for a deck without any', async () => {
    const { fixture, files } = await setup();
    files.chosen = asFile(await packed(await deckFixture()));
    button(fixture, 'Import deck…').click();
    await settle(fixture);
    expect(root(fixture).querySelector('[role="alert"]')?.textContent).toBeUndefined();
    expect(root(fixture).querySelector('.notice')?.textContent).not.toContain('code components');
  });

  it('shows why a file was rejected and changes nothing', async () => {
    const { fixture, files, repo } = await setup();
    files.chosen = asFile(new TextEncoder().encode('not a zip'));
    button(fixture, 'Import deck…').click();
    await settle(fixture);
    expect(root(fixture).querySelector('[role="alert"]')?.textContent).toContain('This file cannot be imported.');
    expect(root(fixture).querySelector('.notice-info')).toBeNull();
    expect(rowTitles(fixture)).toEqual([]);
    const listed = await repo.list();
    expect(listed.ok && listed.value).toEqual([]);
  });

  it('does nothing when the dialog is dismissed', async () => {
    const { fixture } = await setup();
    button(fixture, 'Import deck…').click();
    await settle(fixture);
    expect(root(fixture).querySelector('[role="alert"]')).toBeNull();
    expect(root(fixture).querySelector('.notice-info')).toBeNull();
  });

  it('exports one deck from its row and says where it went', async () => {
    const { fixture, files, repo } = await setup();
    await stored(repo, await deckFixture());
    await fixture.componentInstance['library'].refresh();
    await settle(fixture);
    button(fixture, /^Export Round trip$/).click();
    await settle(fixture);
    expect(files.saved.map((s) => s.name)).toEqual(['Round-trip.deck']);
    expect(root(fixture).querySelector('.notice')?.textContent).toContain('Exported “Round trip” to Round-trip.deck.');
  });

  it('exports all decks and stays quiet when the dialog is dismissed', async () => {
    const { fixture, files, repo } = await setup();
    await stored(repo, await deckFixture());
    files.outcome = 'cancelled';
    button(fixture, 'Export all decks').click();
    await settle(fixture);
    expect(root(fixture).querySelector('.notice-info')).toBeNull();
    files.outcome = 'saved';
    button(fixture, 'Export all decks').click();
    await settle(fixture);
    expect(files.saved.map((s) => s.name)).toEqual(['decktech-decks.zip']);
    expect(root(fixture).querySelector('.notice')?.textContent).toContain('Exported all decks to decktech-decks.zip.');
  });

  it('reports an empty library on export all', async () => {
    const { fixture } = await setup();
    button(fixture, 'Export all decks').click();
    await settle(fixture);
    expect(root(fixture).querySelector('[role="alert"]')?.textContent).toContain('You have no decks to export.');
  });

  it('passes AXE with a notice and an error', async () => {
    const { fixture, files, repo } = await setup();
    await stored(repo, await deckFixture());
    files.chosen = asFile(await packed(await deckFixture({ code: true })));
    button(fixture, 'Import deck…').click();
    await settle(fixture);
    const results = await axe.run(root(fixture), { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
  });
});
