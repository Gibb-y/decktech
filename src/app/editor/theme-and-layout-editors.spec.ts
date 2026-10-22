import { createElement, type Deck, type TextEl } from '../core/model';
import { openEditor, press, runAxe, settle, type Editor } from './editor-test-setup';

afterEach(() => document.body.replaceChildren());

const button = (root: ParentNode, text: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text)!;
const dialog = (e: Editor) => e.root.querySelector<HTMLElement>('[role="dialog"]')!;

async function click(e: Editor, el: HTMLElement): Promise<void> {
  el.click();
  await settle(e.fixture);
}

async function typeInto(e: Editor, input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await settle(e.fixture);
}

async function choose(e: Editor, select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await settle(e.fixture);
}

const rowInput = (e: Editor, label: string) => dialog(e).querySelector<HTMLInputElement>(`input[aria-labelledby="row-${label}"]`)!;

describe('theme editor', () => {
  const open = async (options = {}) => {
    const e = await openEditor(options);
    await click(e, button(e.root, 'Edit theme…'));
    return e;
  };

  it('opens as a labelled modal dialog that passes AXE', async () => {
    const e = await open();
    expect(dialog(e).getAttribute('aria-modal')).toBe('true');
    expect(dialog(e).getAttribute('aria-labelledby')).toBe('theme-editor-title');
    expect((await runAxe(dialog(e))).violations).toEqual([]);
  });

  it('shows the contrast of text, muted and accent and passes for the built-in theme', async () => {
    const e = await open();
    const items = Array.from(dialog(e).querySelectorAll('.contrast li'));
    expect(items).toHaveLength(3);
    expect(items.every((li) => li.textContent?.includes('meets WCAG AA'))).toBe(true);
  });

  it('warns below 4.5:1 as the colour is edited', async () => {
    const e = await open();
    await typeInto(e, rowInput(e, 'colors-muted'), '#cccccc');
    const warning = dialog(e).querySelector('.warning')!;
    expect(warning.textContent).toContain('Warning: 1.6');
    expect(warning.textContent).toContain('below WCAG AA (4.5:1)');
    await typeInto(e, rowInput(e, 'colors-muted'), '#444444');
    expect(dialog(e).querySelector('.warning')).toBeNull();
  });

  it('does not measure a colour that is not hex', async () => {
    const e = await open();
    await typeInto(e, rowInput(e, 'colors-accent'), 'rebeccapurple');
    expect(dialog(e).textContent).toContain('not measured');
  });

  it('applies a custom theme with a name as one undo step; undo restores it', async () => {
    const e = await open();
    const before = e.store.deck().theme;
    await typeInto(e, dialog(e).querySelector<HTMLInputElement>('#theme-name')!, 'Ocean');
    await typeInto(e, rowInput(e, 'colors-accent'), '#004488');
    await typeInto(e, rowInput(e, 'typeScale-body'), '48');
    await click(e, button(dialog(e), 'Apply theme'));
    expect(e.root.querySelector('[role="dialog"]')).toBeNull();
    expect(e.store.deck().theme).toMatchObject({ name: 'Ocean', colors: { accent: '#004488' }, typeScale: { body: 48 } });
    expect(e.root.querySelector('app-editor-toolbar select option[disabled]')?.textContent).toContain('Ocean');
    e.store.undo();
    expect(e.store.deck().theme).toEqual(before);
    expect(e.store.canUndo()).toBe(false);
  });

  it('adds a colour token, and rejects bad names and duplicates', async () => {
    const e = await open();
    const colours = Array.from(dialog(e).querySelectorAll('fieldset'))[0];
    const [name, value] = Array.from(colours.querySelectorAll<HTMLInputElement>('.add input'));
    await typeInto(e, name, 'bad name');
    await typeInto(e, value, '#123456');
    await click(e, button(colours, 'Add'));
    expect(colours.querySelector('[role="alert"]')?.textContent).toContain('A name is 1 to 64');
    await typeInto(e, name, 'accent');
    await click(e, button(colours, 'Add'));
    expect(colours.querySelector('[role="alert"]')?.textContent).toContain('exists already');
    await typeInto(e, name, 'highlight');
    await click(e, button(colours, 'Add'));
    expect(rowInput(e, 'colors-highlight').value).toBe('#123456');
    await click(e, button(dialog(e), 'Apply theme'));
    expect(e.store.deck().theme.colors['highlight']).toBe('#123456');
  });

  it('will not remove a required token, and removes one nothing uses', async () => {
    const e = await open();
    await click(e, button(dialog(e), 'Remove text'));
    expect(dialog(e).textContent).toContain('needed by every theme');
    expect(rowInput(e, 'colors-text')).not.toBeNull();
    await click(e, button(dialog(e), 'Remove accent'));
    expect(rowInput(e, 'colors-accent')).toBeNull();
  });

  it('will not remove a token that slides use, and says so', async () => {
    const e = await openEditor({ prepare: (d: Deck) => d.slides[0].elements.push(createElement('shape')) });
    await click(e, button(e.root, 'Edit theme…'));
    expect(dialog(e).textContent).toContain('in use');
    await click(e, button(dialog(e), 'Remove accent'));
    expect(dialog(e).textContent).toContain('still used by the deck');
    expect(rowInput(e, 'colors-accent')).not.toBeNull();
  });

  it('blocks Apply while a value is invalid and flags the row', async () => {
    const e = await open();
    await typeInto(e, rowInput(e, 'colors-accent'), 'url(javascript:1)');
    expect(rowInput(e, 'colors-accent').getAttribute('aria-invalid')).toBe('true');
    await click(e, button(dialog(e), 'Apply theme'));
    expect(dialog(e).textContent).toContain('Fix the highlighted values');
    expect(e.store.canUndo()).toBe(false);
    await typeInto(e, rowInput(e, 'typeScale-body'), '-3');
    expect(rowInput(e, 'typeScale-body').getAttribute('aria-invalid')).toBe('true');
    await typeInto(e, rowInput(e, 'fonts-body'), 'a; b');
    expect(rowInput(e, 'fonts-body').getAttribute('aria-invalid')).toBe('true');
  });

  it('asks before discarding changes on Escape, and closes at once when nothing changed', async () => {
    const e = await open();
    press(dialog(e), 'Escape');
    await settle(e.fixture);
    expect(e.root.querySelector('[role="dialog"]')).toBeNull();
    await click(e, button(e.root, 'Edit theme…'));
    await typeInto(e, rowInput(e, 'colors-accent'), '#004488');
    press(dialog(e), 'Escape');
    await settle(e.fixture);
    expect(dialog(e).querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.activeElement?.hasAttribute('data-keep')).toBe(true);
    await click(e, button(dialog(e), 'Keep editing'));
    expect(rowInput(e, 'colors-accent').value).toBe('#004488');
    press(dialog(e), 'Escape');
    await settle(e.fixture);
    await click(e, button(dialog(e), 'Discard'));
    expect(e.root.querySelector('[role="dialog"]')).toBeNull();
    expect(e.store.deck().theme.colors['accent']).not.toBe('#004488');
  });

  it('a type scale change resizes text that uses a size token, with no element edits', async () => {
    const e = await openEditor({
      prepare: (d: Deck) => d.slides[0].elements.push(createElement('text', { text: 'Sized', fontSize: 40, sizeToken: 'body' })),
    });
    const sizeOf = () => Array.from(e.root.querySelectorAll<HTMLElement>('app-canvas .text')).find((n) => n.textContent?.includes('Sized'))!.style.fontSize;
    expect(sizeOf()).toBe('40px');
    await click(e, button(e.root, 'Edit theme…'));
    await typeInto(e, rowInput(e, 'typeScale-body'), '60');
    await click(e, button(dialog(e), 'Apply theme'));
    expect(sizeOf()).toBe('60px');
    const text = e.store.currentSlide().elements.find((x) => x.type === 'text' && x.text === 'Sized') as TextEl;
    expect(text.fontSize).toBe(40);
  });
});

describe('layout editor', () => {
  const open = async (options = {}) => {
    const e = await openEditor(options);
    await click(e, button(e.root, 'Layouts…'));
    return e;
  };
  const layoutSelect = (e: Editor) => dialog(e).querySelector<HTMLSelectElement>('select[data-autofocus]')!;
  const onTitleContent = (d: Deck) => {
    d.slides[0].layoutId = 'ly_title-content';
  };

  it('opens as a modal dialog on the current slide’s layout and passes AXE', async () => {
    const e = await open({ prepare: onTitleContent });
    expect(layoutSelect(e).value).toBe('ly_title-content');
    expect(dialog(e).querySelectorAll('.ph')).toHaveLength(2);
    expect((await runAxe(dialog(e))).violations).toEqual([]);
  });

  it('adds, renames and duplicates layouts, each as an undo step', async () => {
    const e = await open();
    const count = () => e.store.deck().layouts.length;
    const start = count();
    await click(e, button(dialog(e), 'Add layout'));
    expect(count()).toBe(start + 1);
    await typeInto(e, dialog(e).querySelector<HTMLInputElement>('#layout-name')!, '  Gallery ');
    expect(e.store.deck().layouts.at(-1)!.name).toBe('Gallery');
    await click(e, button(dialog(e), 'Duplicate'));
    expect(e.store.deck().layouts.at(-1)!.name).toBe('Gallery copy');
    e.store.undo();
    e.store.undo();
    e.store.undo();
    expect(count()).toBe(start);
  });

  it('refuses a blank name, shows why and restores the field', async () => {
    const e = await open();
    const input = dialog(e).querySelector<HTMLInputElement>('#layout-name')!;
    await typeInto(e, input, '   ');
    expect(dialog(e).querySelector('p.error')?.textContent).toContain('layout name');
    expect(input.value.trim()).not.toBe('');
  });

  it('adds a placeholder, moves it with keys and fields, and removes it', async () => {
    const e = await open();
    await click(e, button(dialog(e), 'Add layout'));
    const id = e.store.deck().layouts.at(-1)!.id;
    const ph = () => e.store.deck().layouts.find((l) => l.id === id)!.placeholders[0];
    await click(e, button(dialog(e), 'Add placeholder'));
    expect(ph()).toMatchObject({ kind: 'title', x: 660, y: 470, w: 600, h: 140 });
    const handle = () => dialog(e).querySelector<HTMLButtonElement>('.ph')!;
    press(handle(), 'ArrowRight');
    press(handle(), 'ArrowDown', { shiftKey: true });
    expect(ph()).toMatchObject({ x: 661, y: 480 });
    press(handle(), 'ArrowRight', { ctrlKey: true, shiftKey: true });
    expect(ph().w).toBe(610);
    await settle(e.fixture);
    const x = dialog(e).querySelectorAll<HTMLInputElement>('fieldset input[type="number"]')[0];
    await typeInto(e, x, '100');
    expect(ph().x).toBe(100);
    await typeInto(e, x, '5000');
    expect(ph().x).toBe(100);
    expect(x.value).toBe('100');
    expect(dialog(e).querySelector('p.error')?.textContent).toContain('inside');
    press(handle(), 'Delete');
    await settle(e.fixture);
    expect(e.store.deck().layouts.find((l) => l.id === id)!.placeholders).toHaveLength(0);
  });

  it('keeps a placeholder inside the stage when moved by keys', async () => {
    const e = await open({ prepare: onTitleContent });
    const ph = () => e.store.deck().layouts.find((l) => l.id === 'ly_title-content')!.placeholders[0];
    const handle = dialog(e).querySelector<HTMLButtonElement>('.ph')!;
    for (let i = 0; i < 20; i++) press(handle, 'ArrowLeft', { shiftKey: true });
    expect(ph().x).toBe(0);
  });

  it('a key burst is one undo step, and slides on the layout follow', async () => {
    const e = await open({ prepare: onTitleContent });
    const title = () => e.store.currentSlide().elements.find((x) => x.placeholder === 'title');
    const x0 = title()?.x ?? 0;
    const handle = dialog(e).querySelector<HTMLButtonElement>('.ph')!;
    for (let i = 0; i < 30; i++) press(handle, 'ArrowRight');
    expect(e.store.deck().layouts.find((l) => l.id === 'ly_title-content')!.placeholders[0].x).toBe(150);
    e.store.undo();
    expect(e.store.deck().layouts.find((l) => l.id === 'ly_title-content')!.placeholders[0].x).toBe(120);
    expect(title()?.x ?? 0).toBe(x0);
  });

  it('changes the layout background', async () => {
    const e = await open({ prepare: onTitleContent });
    await choose(e, dialog(e).querySelector<HTMLSelectElement>('app-fill-control select')!, 'solid');
    expect(e.store.deck().layouts.find((l) => l.id === 'ly_title-content')!.background).toMatchObject({ kind: 'solid' });
  });

  it('deleting a used layout asks for a replacement and never leaves a dangling layoutId', async () => {
    const e = await open({ prepare: onTitleContent });
    await choose(e, layoutSelect(e), 'ly_two-column');
    await click(e, button(dialog(e), 'Delete…'));
    await click(e, button(dialog(e), 'Delete'));
    expect(e.store.deck().layouts.some((l) => l.id === 'ly_two-column')).toBe(false);

    await choose(e, layoutSelect(e), 'ly_title-content');
    await click(e, button(dialog(e), 'Delete…'));
    expect(dialog(e).querySelector('[role="alertdialog"]')!.textContent).toContain('1 slide uses');
    await choose(e, dialog(e).querySelector<HTMLSelectElement>('select[aria-label="Replacement layout"]')!, 'ly_title');
    await click(e, button(dialog(e), 'Move slides and delete'));
    const ids = new Set(e.store.deck().layouts.map((l) => l.id));
    expect(e.store.slides().every((s) => ids.has(s.layoutId))).toBe(true);
    expect(e.store.slides()[0].layoutId).toBe('ly_title');
    e.store.undo();
    expect(e.store.slides()[0].layoutId).toBe('ly_title-content');
  });

  it('Escape closes the delete question first, then the dialog', async () => {
    const e = await open({ prepare: onTitleContent });
    const n = e.store.deck().layouts.length;
    await click(e, button(dialog(e), 'Delete…'));
    press(dialog(e), 'Escape');
    await settle(e.fixture);
    expect(dialog(e).querySelector('[role="alertdialog"]')).toBeNull();
    expect(e.store.deck().layouts).toHaveLength(n);
    press(dialog(e), 'Escape');
    await settle(e.fixture);
    expect(e.root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('refuses to delete the only layout', async () => {
    const e = await open({
      prepare: (d: Deck) => {
        d.layouts = [d.layouts[0]];
        d.slides.forEach((s) => (s.layoutId = d.layouts[0].id));
      },
    });
    await click(e, button(dialog(e), 'Delete…'));
    expect(dialog(e).textContent).toContain('at least one layout');
    expect(dialog(e).querySelector('[role="alertdialog"]')).toBeNull();
  });
});

describe('placeholder outlines on the canvas', () => {
  it('are drawn for the current slide’s layout in the editor, never in thumbnails', async () => {
    const e = await openEditor({ prepare: (d: Deck) => (d.slides[0].layoutId = 'ly_two-column') });
    const outlines = () => e.root.querySelectorAll('app-canvas .placeholder-outline');
    expect(outlines()).toHaveLength(3);
    expect(Array.from(outlines()).every((o) => o.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(e.root.querySelectorAll('.sorter .placeholder-outline')).toHaveLength(0);
    e.store.selectSlide(e.store.slides()[1].id);
    await settle(e.fixture);
    expect(outlines()).toHaveLength(0);
  });
});
