import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import axe from 'axe-core';
import { createDeck, type Deck } from '../core/model';
import { DeckRepository, InMemoryDeckRepository } from '../core/persistence';
import { LiveAnnouncer } from '../shared';
import { LibraryPage, PAGE_SIZE } from './library-page';

async function setup(titles: string[] = []) {
  let clock = 1_000;
  const repo = new InMemoryDeckRepository(() => clock++);
  const decks: Deck[] = [];
  for (const title of titles) {
    const deck = createDeck(title);
    await repo.save(deck, null);
    decks.push(deck);
  }
  TestBed.configureTestingModule({ providers: [{ provide: DeckRepository, useValue: repo }, provideRouter([])] });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(LibraryPage);
  document.body.appendChild(fixture.nativeElement);
  await settle(fixture);
  return { repo, decks, navigate, fixture, announcer: TestBed.inject(LiveAnnouncer) };
}

async function settle(fixture: ComponentFixture<LibraryPage>): Promise<void> {
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r));
  await fixture.whenStable();
}

const root = (f: ComponentFixture<LibraryPage>) => f.nativeElement as HTMLElement;
const rows = (f: ComponentFixture<LibraryPage>) => Array.from(root(f).querySelectorAll('li.deck'));
const rowTitles = (f: ComponentFixture<LibraryPage>) => rows(f).map((r) => r.querySelector('.title')?.textContent?.trim());
const button = (scope: ParentNode, name: string | RegExp): HTMLButtonElement => {
  const found = Array.from(scope.querySelectorAll('button')).find((b) => (typeof name === 'string' ? b.textContent.trim() === name : name.test(b.textContent.trim())));
  if (!found) throw new Error(`no button ${name}`);
  return found;
};

async function type(fixture: ComponentFixture<LibraryPage>, input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await settle(fixture);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('LibraryPage', () => {
  it('shows an empty state with the create actions', async () => {
    const { fixture } = await setup();
    expect(root(fixture).textContent).toContain('You have no decks yet');
    expect(button(root(fixture), 'New blank deck')).toBeTruthy();
    expect(button(root(fixture), 'Title and bullets')).toBeTruthy();
  });

  it('lists decks with title, thumbnail placeholder and modified date, newest first', async () => {
    const { fixture } = await setup(['First', 'Second']);
    expect(rowTitles(fixture)).toEqual(['Second', 'First']);
    const row = rows(fixture)[0];
    expect(row.querySelector('.thumb')?.getAttribute('aria-hidden')).toBe('true');
    expect(row.querySelector('time')?.getAttribute('datetime')).toMatch(/^1970-01-01T00:00:0\dZ$/);
    expect(row.querySelector('a')?.getAttribute('href')).toMatch(/^\/deck\/dk_/);
  });

  it('filters by title, case-insensitively, and says when nothing matches', async () => {
    const { fixture } = await setup(['Quarterly report', 'Holiday photos']);
    const search = root(fixture).querySelector<HTMLInputElement>('#deck-search')!;
    await type(fixture, search, 'HOLI');
    expect(rowTitles(fixture)).toEqual(['Holiday photos']);
    expect(root(fixture).textContent).toContain('1 of 2 decks match');
    await type(fixture, search, 'zzz');
    expect(rows(fixture)).toHaveLength(0);
    expect(root(fixture).textContent).toContain('No deck matches “zzz”.');
  });

  it('draws one page of a long list and adds more on request; searching starts over', async () => {
    const titles = Array.from({ length: PAGE_SIZE * 2 + 5 }, (_, i) => `Deck ${i}`);
    const { fixture } = await setup(titles);
    expect(rows(fixture)).toHaveLength(PAGE_SIZE);
    button(root(fixture), /^Show \d+ more/).click();
    await settle(fixture);
    expect(rows(fixture)).toHaveLength(PAGE_SIZE * 2);
    await type(fixture, root(fixture).querySelector<HTMLInputElement>('#deck-search')!, 'Deck 1');
    expect(rows(fixture).length).toBeLessThanOrEqual(PAGE_SIZE);
    await type(fixture, root(fixture).querySelector<HTMLInputElement>('#deck-search')!, '');
    expect(rows(fixture)).toHaveLength(PAGE_SIZE);
  });

  it('creates a blank deck and opens it', async () => {
    const { fixture, repo, navigate } = await setup();
    button(root(fixture), 'New blank deck').click();
    await settle(fixture);
    const listed = await repo.list();
    if (!listed.ok) throw new Error('list');
    expect(listed.value).toHaveLength(1);
    expect(navigate).toHaveBeenCalledWith(['/deck', listed.value[0].id]);
  });

  it('creates a deck from a template and opens it', async () => {
    const { fixture, repo, navigate } = await setup();
    button(root(fixture), 'Sections').click();
    await settle(fixture);
    const listed = await repo.list();
    if (!listed.ok) throw new Error('list');
    expect(listed.value.map((d) => d.title)).toEqual(['Sections']);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('does not open anything when creating fails', async () => {
    const { fixture, repo, navigate } = await setup();
    vi.spyOn(repo, 'save').mockResolvedValue({ ok: false, error: { kind: 'quota', message: 'full' } });
    button(root(fixture), 'New blank deck').click();
    await settle(fixture);
    expect(navigate).not.toHaveBeenCalled();
    expect(root(fixture).querySelector('[role="alert"]')?.textContent).toContain('Could not save the deck: full');
  });

  describe('rename', () => {
    it('renames through a labelled field and returns focus to the button', async () => {
      const { fixture, decks } = await setup(['Old name']);
      button(root(fixture), /^Rename/).click();
      await settle(fixture);
      const input = root(fixture).querySelector<HTMLInputElement>(`#rename-${decks[0].id}`)!;
      expect(document.activeElement).toBe(input);
      expect(root(fixture).querySelector(`label[for="rename-${decks[0].id}"]`)).toBeTruthy();
      input.value = 'New name';
      input.dispatchEvent(new Event('input'));
      button(root(fixture), 'Save').click();
      await settle(fixture);
      expect(rowTitles(fixture)).toEqual(['New name']);
      expect(document.activeElement?.id).toBe(`rename-btn-${decks[0].id}`);
    });

    it('shows the problem and keeps editing when the title is empty; Cancel leaves the title', async () => {
      const { fixture } = await setup(['Keep me']);
      button(root(fixture), /^Rename/).click();
      await settle(fixture);
      const input = root(fixture).querySelector<HTMLInputElement>('input[type="text"]')!;
      await type(fixture, input, '   ');
      button(root(fixture), 'Save').click();
      await settle(fixture);
      expect(root(fixture).querySelector('[role="alert"]')?.textContent).toContain('Enter a title.');
      expect(root(fixture).querySelector('input[type="text"]')).toBeTruthy();
      button(root(fixture), 'Cancel').click();
      await settle(fixture);
      expect(rowTitles(fixture)).toEqual(['Keep me']);
    });
  });

  it('duplicates a deck and moves focus to the copy', async () => {
    const { fixture } = await setup(['Talk']);
    button(root(fixture), /^Duplicate/).click();
    await settle(fixture);
    expect(rowTitles(fixture).sort()).toEqual(['Copy of Talk', 'Talk']);
    const copyRow = rows(fixture).find((r) => r.querySelector('.title')?.textContent?.includes('Copy of'))!;
    expect(document.activeElement).toBe(copyRow.querySelector('button[id^="rename-btn-"]'));
  });

  describe('delete', () => {
    it('asks first, traps focus in the dialog, and Cancel keeps the deck and restores focus', async () => {
      const { fixture, decks } = await setup(['Precious']);
      const trigger = root(fixture).querySelector<HTMLButtonElement>(`#delete-btn-${decks[0].id}`)!;
      trigger.focus();
      trigger.click();
      await settle(fixture);
      const dialog = root(fixture).querySelector<HTMLElement>('[role="alertdialog"]')!;
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.textContent).toContain('Precious');
      expect(document.activeElement).toBe(button(dialog, 'Cancel'));

      // Tab from the last control wraps to the first, Shift+Tab from the first wraps to the last.
      button(dialog, 'Delete deck').focus();
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      button(dialog, 'Delete deck').dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(button(dialog, 'Cancel'));
      const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
      button(dialog, 'Cancel').dispatchEvent(back);
      expect(document.activeElement).toBe(button(dialog, 'Delete deck'));

      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(fixture);
      expect(root(fixture).querySelector('[role="alertdialog"]')).toBeNull();
      expect(rowTitles(fixture)).toEqual(['Precious']);
      expect(document.activeElement).toBe(trigger);
    });

    it('deletes after confirmation, announces it and focuses the heading', async () => {
      const { fixture, decks, repo, announcer } = await setup(['Doomed', 'Survivor']);
      root(fixture).querySelector<HTMLButtonElement>(`#delete-btn-${decks[0].id}`)!.click();
      await settle(fixture);
      button(root(fixture), 'Delete deck').click();
      await settle(fixture);
      expect(rowTitles(fixture)).toEqual(['Survivor']);
      expect((await repo.load(decks[0].id)).ok).toBe(false);
      expect(document.activeElement?.id).toBe('library-heading');
      await new Promise((r) => setTimeout(r, 80));
      expect(announcer.message()).toBe('Deleted Doomed');
    });

    it('keeps the deck and says so when deleting fails', async () => {
      const { fixture, decks, repo } = await setup(['Stuck']);
      vi.spyOn(repo, 'delete').mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'closed' } });
      root(fixture).querySelector<HTMLButtonElement>(`#delete-btn-${decks[0].id}`)!.click();
      await settle(fixture);
      button(root(fixture), 'Delete deck').click();
      await settle(fixture);
      expect(rowTitles(fixture)).toEqual(['Stuck']);
      expect(root(fixture).querySelector('[role="alert"]')?.textContent).toContain('Could not delete the deck: closed');
    });
  });

  it('offers a retry when the list cannot be read', async () => {
    let clock = 1;
    const repo = new InMemoryDeckRepository(() => clock++);
    const list = vi.spyOn(repo, 'list').mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'blocked' } });
    TestBed.configureTestingModule({ providers: [{ provide: DeckRepository, useValue: repo }, provideRouter([])] });
    const fixture = TestBed.createComponent(LibraryPage);
    document.body.appendChild(fixture.nativeElement);
    await settle(fixture);
    expect(root(fixture).textContent).toContain('Your decks could not be read.');
    list.mockRestore();
    button(root(fixture), 'Try again').click();
    await settle(fixture);
    expect(root(fixture).textContent).toContain('You have no decks yet');
    expect(root(fixture).querySelector('[role="alert"]')).toBeNull();
  });

  describe('accessibility', () => {
    const violations = async (el: HTMLElement) => {
      // jsdom has no layout or computed colours, so contrast is checked by the palette instead.
      const results = await axe.run(el, { rules: { 'color-contrast': { enabled: false } } });
      return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
    };

    it('has no AXE violations when empty', async () => {
      const { fixture } = await setup();
      expect(await violations(root(fixture))).toEqual([]);
    });

    it('has no AXE violations with decks, while renaming and with the dialog open', async () => {
      const { fixture } = await setup(['One', 'Two']);
      expect(await violations(root(fixture))).toEqual([]);

      button(root(fixture), /^Rename/).click();
      await settle(fixture);
      expect(await violations(root(fixture))).toEqual([]);
      button(root(fixture), 'Cancel').click();
      await settle(fixture);

      root(fixture).querySelector<HTMLButtonElement>('button.danger')!.click();
      await settle(fixture);
      expect(root(fixture).querySelector('[role="alertdialog"]')).toBeTruthy();
      expect(await violations(root(fixture))).toEqual([]);
    });

    it('gives each action a name that includes the deck', async () => {
      const { fixture } = await setup(['Budget']);
      const names = Array.from(rows(fixture)[0].querySelectorAll('button'), (b) => b.textContent.replace(/\s+/g, ' ').trim());
      expect(names).toEqual(['Rename Budget', 'Duplicate Budget', 'Delete Budget']);
    });

    it('uses only native, tabbable controls (no click handlers on plain elements)', async () => {
      const { fixture } = await setup(['A']);
      const interactive = root(fixture).querySelectorAll('a[href], button, input');
      expect(interactive.length).toBeGreaterThan(5);
      for (const el of Array.from(interactive)) expect(el.getAttribute('tabindex')).toBeNull();
    });
  });
});
