import { TestBed } from '@angular/core/testing';
import { createElement, type RichDoc, type TextEl } from '../../core/model';
import { DeleteElements, SetText } from '../../core/store';
import { openEditor, press, runAxe, settle, type Editor } from '../editor-test-setup';
import { TextEditing } from './text-editing';

// jsdom has no layout; ProseMirror asks ranges for their rectangles when it scrolls the caret into view.
beforeAll(() => {
  const rects = { length: 0, item: () => null, [Symbol.iterator]: function* () {} } as unknown as DOMRectList;
  Range.prototype.getClientRects ??= () => rects;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

afterEach(() => document.body.replaceChildren());

const hit = (e: Editor) => e.root.querySelector<HTMLElement>('.hit')!;
const surface = (e: Editor) => e.root.querySelector<HTMLElement>('.ProseMirror');
const first = (e: Editor): TextEl => e.store.currentSlide().elements[0] as TextEl;
const panel = (e: Editor) => e.root.querySelector<HTMLElement>('app-properties-panel')!;
const button = (e: Editor, name: string) => Array.from(panel(e).querySelectorAll('button')).find((b) => b.textContent?.trim() === name)!;

/** The editor chunk loads asynchronously; wait until the editing surface is there. */
async function untilEditing(e: Editor): Promise<HTMLElement> {
  for (let i = 0; i < 50 && !surface(e); i++) {
    await new Promise((r) => setTimeout(r, 5));
    await settle(e.fixture);
  }
  return surface(e)!;
}

async function startEditing(e: Editor, how: 'dblclick' | 'enter' = 'dblclick'): Promise<HTMLElement> {
  e.store.select([first(e).id]);
  await settle(e.fixture);
  if (how === 'dblclick') hit(e).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  else press(e.root.querySelector<HTMLElement>('.viewport')!, 'Enter');
  return untilEditing(e);
}

/** Replaces the text the way the browser does: change the DOM, let ProseMirror's observer read it. */
async function typeText(e: Editor, value: string): Promise<void> {
  const textNode = surface(e)!.querySelector('p')!.firstChild as Text;
  textNode.nodeValue = value;
  await new Promise((r) => setTimeout(r, 20));
  await settle(e.fixture);
}

async function blur(e: Editor): Promise<void> {
  surface(e)!.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }));
  await settle(e.fixture);
}

describe('editing text in place', () => {
  it('starts on double-click, over the element, and hides the rendered text meanwhile', async () => {
    const e = await openEditor();
    const editor = await startEditing(e);
    expect(editor).toBeTruthy();
    expect(e.root.querySelector('app-text-editor')).toBeTruthy();
    expect(editor.textContent).toBe('Welcome');
    const rendered = e.root.querySelector<HTMLElement>('app-canvas app-slide-renderer app-text-element')!;
    expect(rendered.style.visibility).toBe('hidden');
    const box = e.root.querySelector<HTMLElement>('app-text-editor')!;
    expect(box.style.left).toBe('100px');
    expect(box.style.top).toBe('100px');
    expect(box.closest('.overlay')).toBeTruthy(); // inside the scaled overlay, so zoom needs no maths
  });

  it('starts on Enter with a text element selected', async () => {
    const e = await openEditor();
    expect(await startEditing(e, 'enter')).toBeTruthy();
  });

  it('does not start for a locked element and says why', async () => {
    const e = await openEditor({ prepare: (d) => void (d.slides[0].elements[0].locked = true) });
    e.store.select([first(e).id]);
    await settle(e.fixture);
    press(e.root.querySelector<HTMLElement>('.viewport')!, 'Enter');
    await settle(e.fixture);
    expect(surface(e)).toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    expect(e.announcer.message()).toMatch(/locked/);
  });

  it('does not start for other element types', async () => {
    const e = await openEditor({ prepare: (d) => d.slides[0].elements.splice(0, 1, createElement('shape')) });
    e.store.select([e.store.currentSlide().elements[0].id]);
    await settle(e.fixture);
    hit(e).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle(e.fixture);
    expect(e.root.querySelector('app-text-editor')).toBeNull();
  });

  it('commits one undo step on blur, and undo restores the previous content', async () => {
    const e = await openEditor();
    const before = first(e);
    await startEditing(e);
    await typeText(e, 'Welcome back');
    expect(first(e)).toBe(before); // nothing is committed while typing
    expect(e.store.canUndo()).toBe(false);
    await blur(e);
    expect(e.root.querySelector('app-text-editor')).toBeNull();
    expect(first(e).text).toBe('Welcome back');
    expect(first(e).rich?.content[0].content?.[0].text).toBe('Welcome back');
    expect(e.store.canUndo()).toBe(true);
    e.store.undo();
    expect(first(e).text).toBe('Welcome');
    expect(first(e).rich).toBeUndefined();
    expect(e.store.canUndo()).toBe(false);
  });

  it('commits on Escape and returns focus to the canvas', async () => {
    const e = await openEditor();
    await startEditing(e);
    await typeText(e, 'Escaped');
    press(surface(e)!, 'Escape');
    await settle(e.fixture);
    expect(e.root.querySelector('app-text-editor')).toBeNull();
    expect(first(e).text).toBe('Escaped');
    expect(document.activeElement).toBe(e.root.querySelector('.viewport'));
    expect(e.store.selection()).toEqual([first(e).id]);
  });

  it('records nothing when the text was not changed', async () => {
    const e = await openEditor();
    const before = e.store.deck();
    await startEditing(e);
    await blur(e);
    expect(e.store.deck()).toBe(before);
    expect(e.store.canUndo()).toBe(false);
  });

  it('keeps keys typed in the text away from the canvas shortcuts', async () => {
    const e = await openEditor();
    await startEditing(e);
    const before = e.store.deck();
    for (const key of ['Delete', 'Backspace', 'a', 'ArrowLeft', '[', 'd']) press(surface(e)!, key, { ctrlKey: key !== 'Delete' && key !== 'Backspace' && key !== 'ArrowLeft' });
    press(surface(e)!, 'ArrowRight');
    expect(e.store.deck()).toBe(before);
    expect(e.store.selection()).toEqual([first(e).id]);
  });

  it('ends when the selection moves to something else, committing what was typed', async () => {
    const e = await openEditor({ prepare: (d) => d.slides[0].elements.push(createElement('shape')) });
    await startEditing(e);
    await typeText(e, 'Moved on');
    e.store.select([e.store.currentSlide().elements[1].id]);
    await settle(e.fixture);
    expect(e.root.querySelector('app-text-editor')).toBeNull();
    expect(first(e).text).toBe('Moved on');
  });

  it('survives the element being deleted while editing', async () => {
    const e = await openEditor();
    await startEditing(e);
    await typeText(e, 'Gone');
    e.store.execute(new DeleteElements([first(e).id]));
    await settle(e.fixture);
    expect(e.root.querySelector('app-text-editor')).toBeNull();
  });

  it('edits an element that already has formatted content, keeping its formatting', async () => {
    const rich: RichDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bold', marks: [{ type: 'bold' }] }] }] };
    const e = await openEditor();
    e.store.execute(new SetText(first(e).id, rich));
    await startEditing(e);
    expect(surface(e)!.querySelector('strong')?.textContent).toBe('Bold');
    await blur(e);
    expect(first(e).rich).toEqual(rich);
  });

  it('shows heading text as a heading when it starts from plain text in the heading font', async () => {
    const e = await openEditor({ prepare: (d) => void ((d.slides[0].elements[0] as TextEl).font = 'heading') });
    await startEditing(e);
    expect(surface(e)!.querySelector('h2')?.textContent).toBe('Welcome');
  });
});

describe('format controls in the properties panel', () => {
  it('offer to start editing while no edit is running', async () => {
    const e = await openEditor();
    e.store.select([first(e).id]);
    await settle(e.fixture);
    expect(panel(e).querySelector('app-text-format')).toBeTruthy();
    expect(panel(e).querySelector('[data-keeps-text-editing]')).toBeNull();
    button(e, 'Edit text').click();
    expect(await untilEditing(e)).toBeTruthy();
    await settle(e.fixture);
    expect(panel(e).querySelector('[data-keeps-text-editing]')).toBeTruthy();
  });

  it('format the selection without ending the edit, and report the state', async () => {
    const e = await openEditor();
    await startEditing(e);
    surface(e)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
    await settle(e.fixture);
    const bold = button(e, 'Bold');
    expect(bold.getAttribute('aria-pressed')).toBe('false');
    // Keyboard users tab into the panel: focus lands in the marked group, so the edit goes on.
    surface(e)!.dispatchEvent(new FocusEvent('blur', { relatedTarget: bold }));
    bold.click();
    await settle(e.fixture);
    expect(e.root.querySelector('app-text-editor')).toBeTruthy();
    expect(bold.getAttribute('aria-pressed')).toBe('true');
    await blur(e);
    expect(first(e).rich?.content[0].content?.[0].marks).toEqual([{ type: 'bold' }]);
    expect(e.store.canUndo()).toBe(true);
    e.store.undo();
    expect(first(e).rich).toBeUndefined();
  });

  it('keep the pointer from stealing focus from the text', async () => {
    const e = await openEditor();
    await startEditing(e);
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button(e, 'Bold').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const select = panel(e).querySelector<HTMLSelectElement>('#rt-color')!;
    const onSelect = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    select.dispatchEvent(onSelect);
    expect(onSelect.defaultPrevented).toBe(false);
  });

  it('set a theme colour, a size, a block style and a link', async () => {
    const e = await openEditor();
    await startEditing(e);
    surface(e)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
    const choose = async (id: string, value: string) => {
      const control = panel(e).querySelector<HTMLSelectElement>(`#${id}`)!;
      control.value = value;
      control.dispatchEvent(new Event('change', { bubbles: true }));
      await settle(e.fixture);
    };
    await choose('rt-color', 'accent');
    await choose('rt-size', 'title');
    await choose('rt-block', 'h1');
    const link = panel(e).querySelector<HTMLInputElement>('#rt-link')!;
    link.value = 'example.com/page';
    button(e, 'Set link').click();
    await settle(e.fixture);
    await blur(e);
    const node = first(e).rich!.content[0];
    expect(node).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(node.content![0].marks).toEqual(
      expect.arrayContaining([
        { type: 'color', attrs: { token: 'accent' } },
        { type: 'size', attrs: { token: 'title' } },
        { type: 'link', attrs: { href: 'https://example.com/page' } },
      ]),
    );
    expect(e.store.canUndo()).toBe(true);
  });

  it('refuse an unsafe link address with a message', async () => {
    const e = await openEditor();
    await startEditing(e);
    surface(e)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
    const link = panel(e).querySelector<HTMLInputElement>('#rt-link')!;
    link.value = 'javascript:alert(1)';
    button(e, 'Set link').click();
    await settle(e.fixture);
    expect(panel(e).querySelector('#rt-link-error')?.textContent).toMatch(/web address/);
    expect(panel(e).querySelector('#rt-link')!.getAttribute('aria-invalid')).toBe('true');
    await blur(e);
    expect(e.store.canUndo()).toBe(false);
  });

  it('move focus to the link field on Ctrl+K', async () => {
    const e = await openEditor();
    await startEditing(e);
    press(surface(e)!, 'k', { ctrlKey: true });
    await settle(e.fixture);
    await new Promise((r) => setTimeout(r));
    expect(document.activeElement).toBe(panel(e).querySelector('#rt-link'));
  });

  it('replace the plain text field for formatted text, so typing there cannot drop the formatting', async () => {
    const e = await openEditor();
    e.store.execute(new SetText(first(e).id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rich', marks: [{ type: 'bold' }] }] }] }));
    e.store.select([first(e).id]);
    await settle(e.fixture);
    expect(panel(e).querySelector('textarea')).toBeNull();
    expect(panel(e).textContent).toMatch(/Formatted text/);
  });

  it('are not offered for other element types', async () => {
    const e = await openEditor({ prepare: (d) => d.slides[0].elements.splice(0, 1, createElement('shape')) });
    e.store.select([e.store.currentSlide().elements[0].id]);
    await settle(e.fixture);
    expect(panel(e).querySelector('app-text-format')).toBeNull();
  });

  it('pass AXE while editing and while not', async () => {
    const e = await openEditor();
    e.store.select([first(e).id]);
    await settle(e.fixture);
    expect((await runAxe(e.root)).violations.map((v) => `${v.id}: ${v.nodes[0].html}`)).toEqual([]);
    await startEditing(e);
    await settle(e.fixture);
    expect((await runAxe(e.root)).violations.map((v) => `${v.id}: ${v.nodes[0].html}`)).toEqual([]);
  });

  it('stop being active when the edit ends', async () => {
    const e = await openEditor();
    await startEditing(e);
    expect(TestBed.inject(TextEditing).editingId()).toBe(first(e).id);
    await blur(e);
    expect(TestBed.inject(TextEditing).editingId()).toBeNull();
    expect(TestBed.inject(TextEditing).format()).toBeNull();
  });
});
