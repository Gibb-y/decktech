import { TestBed } from '@angular/core/testing';
import { createElement, validateDeck, type Deck, type TableEl, type VideoEl } from '../../core/model';
import { SetProps } from '../../core/store';
import { openEditor, runAxe, settle, type Editor } from '../editor-test-setup';
import { InsertActions } from '../insert-actions';

afterEach(() => document.body.replaceChildren());

const VIDEO = 'b'.repeat(64);
const POSTER = 'a'.repeat(64);

function prepare(deck: Deck): void {
  deck.assets[VIDEO] = { blobKey: VIDEO, mime: 'video/mp4', hash: VIDEO, size: 3_145_728 };
  deck.assets[POSTER] = { blobKey: POSTER, mime: 'image/png', hash: POSTER, size: 2048 };
  deck.slides[0].elements.push(
    createElement('table', { rows: [['Name', 'Qty'], ['Apples', '3']], header: true, x: 100, y: 300 }),
    createElement('video', { assetId: VIDEO, poster: POSTER, label: 'Demo', x: 900, y: 300 }),
  );
}

const open = () => openEditor({ prepare });
const panel = (e: Editor) => e.root.querySelector<HTMLElement>('app-properties-panel')!;
const legends = (e: Editor) => Array.from(panel(e).querySelectorAll('legend'), (l) => l.textContent);
const buttons = (e: Editor) => Array.from(panel(e).querySelectorAll<HTMLButtonElement>('button'));
const button = (e: Editor, label: string) => buttons(e).find((b) => b.textContent?.trim() === label);
const cell = (e: Editor, r: number, c: number) => panel(e).querySelector<HTMLInputElement>(`#prop-cell-${r}-${c}`)!;
const input = (e: Editor, id: string) => panel(e).querySelector<HTMLInputElement>(`#${id}`)!;
const table = (e: Editor) => e.store.currentSlide().elements.find((el) => el.type === 'table') as TableEl;
const video = (e: Editor) => e.store.currentSlide().elements.find((el) => el.type === 'video') as VideoEl;

async function select(e: Editor, type: 'table' | 'video'): Promise<void> {
  e.store.select([e.store.currentSlide().elements.find((el) => el.type === type)!.id]);
  await settle(e.fixture);
}

async function typeInto(e: Editor, control: HTMLInputElement, value: string): Promise<void> {
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(e.fixture);
}

async function click(e: Editor, label: string): Promise<void> {
  button(e, label)!.click();
  await settle(e.fixture);
}

async function check(e: Editor, id: string, checked: boolean): Promise<void> {
  const box = input(e, id);
  box.checked = checked;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.dispatchEvent(new Event('change', { bubbles: true }));
  await settle(e.fixture);
}

async function focusCell(e: Editor, r: number, c: number): Promise<void> {
  cell(e, r, c).dispatchEvent(new Event('focus'));
  await settle(e.fixture);
}

describe('PropertiesPanel: table', () => {
  it('is drawn on the canvas as a semantic table', async () => {
    const e = await open();
    expect(e.root.querySelector('app-table-element')!.querySelectorAll('th[scope="col"]')).toHaveLength(2);
  });

  it('shows the header switch with the content fields, then the cells and the column widths', async () => {
    const e = await open();
    await select(e, 'table');
    expect(legends(e)).toEqual(['Position and size', 'Content', 'Arrangement', 'Table cells', 'Column widths']);
    expect(input(e, 'prop-header').checked).toBe(true);
    expect(panel(e).querySelector('label[for="prop-header"]')?.textContent).toBe('Header row');
    expect(cell(e, 1, 0).value).toBe('Apples');
    expect(cell(e, 1, 0).getAttribute('aria-label')).toBe('Row 2, column 1');
  });

  it('toggles the header row', async () => {
    const e = await open();
    await select(e, 'table');
    await check(e, 'prop-header', false);
    expect(table(e).header).toBe(false);
    await check(e, 'prop-header', true);
    expect(table(e).header).toBe(true);
  });

  it('edits a cell and merges typing into one undo step', async () => {
    const e = await open();
    await select(e, 'table');
    await typeInto(e, cell(e, 0, 1), 'Q');
    await typeInto(e, cell(e, 0, 1), 'Qt');
    await typeInto(e, cell(e, 0, 1), 'Qty!');
    expect(table(e).rows[0]).toEqual(['Name', 'Qty!']);
    e.store.undo();
    await settle(e.fixture);
    expect(table(e).rows[0]).toEqual(['Name', 'Qty']);
  });

  it('adds a row and a column after the cell that has the focus, and keeps that cell', async () => {
    const e = await open();
    await select(e, 'table');
    await focusCell(e, 0, 0);
    await click(e, 'Add row below');
    expect(table(e).rows).toEqual([['Name', 'Qty'], ['', ''], ['Apples', '3']]);
    await click(e, 'Add column after');
    expect(table(e).rows).toEqual([['Name', '', 'Qty'], ['', '', ''], ['Apples', '', '3']]);
    expect(validateDeck(e.store.deck()).ok).toBe(true);
  });

  it('removes the focused row and column but never the last one', async () => {
    const e = await open();
    await select(e, 'table');
    await focusCell(e, 1, 1);
    await click(e, 'Remove row');
    expect(table(e).rows).toEqual([['Name', 'Qty']]);
    expect(button(e, 'Remove row')!.disabled).toBe(true);
    await click(e, 'Remove column');
    expect(table(e).rows).toEqual([['Name']]);
    expect(button(e, 'Remove column')!.disabled).toBe(true);
  });

  it('sets the fill of the focused cell and clears it again', async () => {
    const e = await open();
    await select(e, 'table');
    await focusCell(e, 1, 1);
    expect(panel(e).querySelector('app-color-control label')?.textContent).toBe('Fill of row 2, column 2');
    const choose = async (value: string) => {
      const control = panel(e).querySelector<HTMLSelectElement>('app-color-control select')!;
      control.value = value;
      control.dispatchEvent(new Event('change', { bubbles: true }));
      await settle(e.fixture);
    };
    await choose('token:accent');
    expect(table(e).cellFills).toEqual([[null, null], [null, { token: 'accent' }]]);
    await choose('none');
    expect(table(e).cellFills).toBeUndefined();
  });

  it('sets column widths, ignores a width that is not positive, and goes back to equal widths', async () => {
    const e = await open();
    await select(e, 'table');
    await typeInto(e, input(e, 'prop-column-width-1'), '3');
    expect(table(e).columnWidths).toEqual([1, 3]);
    for (const bad of ['0', '', '-2']) await typeInto(e, input(e, 'prop-column-width-0'), bad);
    expect(table(e).columnWidths).toEqual([1, 3]);
    await click(e, 'Equal widths');
    expect(table(e).columnWidths).toBeUndefined();
    expect(button(e, 'Equal widths')).toBeUndefined();
  });

  it('disables the table sections for a locked table', async () => {
    const e = await open();
    e.store.execute(new SetProps([table(e).id], { locked: true }));
    await select(e, 'table');
    const sections = Array.from(panel(e).querySelectorAll('fieldset')).filter((f) => ['Table cells', 'Column widths'].includes(f.querySelector('legend')?.textContent ?? ''));
    expect(sections).toHaveLength(2);
    sections.forEach((f) => expect(f.disabled).toBe(true));
  });

  it('passes axe', async () => {
    const e = await open();
    await select(e, 'table');
    expect((await runAxe(e.root)).violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('PropertiesPanel: video', () => {
  it('shows playback options, the accessible name and the file buttons', async () => {
    const e = await open();
    await select(e, 'video');
    expect(legends(e)).toEqual(['Position and size', 'Content', 'Arrangement', 'Video file']);
    const labels = Array.from(panel(e).querySelectorAll('.field label'), (l) => l.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Play when it appears', 'Loop', 'Muted', 'Accessible name']));
    expect(input(e, 'prop-label').value).toBe('Demo');
    expect(panel(e).textContent).toContain('Video: 3.0 MB. Poster: 2 KB.');
    expect(buttons(e).map((b) => b.textContent?.trim())).toEqual(expect.arrayContaining(['Replace video…', 'Replace poster…', 'Remove poster']));
  });

  it('edits the playback options and the accessible name', async () => {
    const e = await open();
    await select(e, 'video');
    for (const key of ['autoplay', 'loop', 'muted']) await check(e, `prop-${key}`, true);
    expect(video(e)).toMatchObject({ autoplay: true, loop: true, muted: true });
    await typeInto(e, input(e, 'prop-label'), 'Intro clip');
    expect(video(e).label).toBe('Intro clip');
    expect(validateDeck(e.store.deck()).ok).toBe(true);
  });

  it('removes the poster in one undo step', async () => {
    const e = await open();
    await select(e, 'video');
    await click(e, 'Remove poster');
    expect(video(e).poster).toBeUndefined();
    expect(button(e, 'Choose poster…')).toBeDefined();
    e.store.undo();
    await settle(e.fixture);
    expect(video(e).poster).toBe(POSTER);
  });

  it.each([
    ['Replace video…', 'assetId'],
    ['Replace poster…', 'poster'],
  ] as const)('%s opens the picker for the %s', async (label, which) => {
    const e = await open();
    await select(e, 'video');
    const pick = vi.spyOn(TestBed.inject(InsertActions), 'pickVideoFile').mockReturnValue();
    await click(e, label);
    expect(pick).toHaveBeenCalledWith(video(e).id, which);
  });

  it('offers to choose a poster when there is none', async () => {
    const e = await open();
    e.store.execute(new SetProps([video(e).id], { poster: undefined }));
    await select(e, 'video');
    expect(panel(e).textContent).toContain('Poster: none');
    expect(buttons(e).map((b) => b.textContent?.trim())).toContain('Choose poster…');
  });

  it('passes axe', async () => {
    const e = await open();
    await select(e, 'video');
    expect((await runAxe(e.root)).violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});
