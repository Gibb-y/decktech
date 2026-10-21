import { InsertActions } from './insert-actions';
import { ShortcutRegistry } from './shortcut-registry';
import { currentSlideButton, openEditor, press, runAxe, settle, slideButtons, type as typeInto } from './editor-test-setup';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const blank = (deck: { slides: { elements: unknown[] }[] }) => {
  deck.slides[0].elements.length = 0;
};

const dialog = (root: HTMLElement) => root.querySelector<HTMLElement>('[role="dialog"]');

describe('the insert menu', () => {
  it('opens with / from the sorter, focuses its filter and closes with Escape, giving focus back', async () => {
    const { fixture, root } = await openEditor();
    const button = slideButtons(root)[0];
    button.focus();
    const event = press(button, '/');
    await settle(fixture);
    expect(event.defaultPrevented).toBe(true);
    expect(dialog(root)?.getAttribute('aria-modal')).toBe('true');
    expect(root.querySelector('#insert-title')?.textContent).toBe('Insert');
    expect(document.activeElement?.id).toBe('insert-filter');
    press(document.activeElement!, 'Escape');
    await settle(fixture);
    expect(dialog(root)).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('opens from the toolbar button as well', async () => {
    const { fixture, root } = await openEditor();
    root.querySelector<HTMLButtonElement>('app-editor-toolbar button[aria-haspopup]')!.click();
    await settle(fixture);
    expect(dialog(root)).not.toBeNull();
  });

  it('filters while typing and says how many remain', async () => {
    const { fixture, root } = await openEditor();
    press(slideButtons(root)[0], '/');
    await settle(fixture);
    const filter = root.querySelector<HTMLInputElement>('#insert-filter')!;
    typeInto(filter, 'ang');
    await settle(fixture);
    const names = Array.from(root.querySelectorAll('app-insert-menu li .label'), (l) => l.textContent);
    expect(names).toEqual(['Rectangle', 'Triangle']);
    expect(root.querySelector('#insert-count')?.textContent).toContain('2 to choose from');
    typeInto(filter, 'zzz');
    await settle(fixture);
    expect(root.querySelector('#insert-count')?.textContent).toContain('No element matches');
    expect(root.querySelectorAll('app-insert-menu li')).toHaveLength(0);
    press(filter, 'Enter'); // nothing to take
    expect(dialog(root)).not.toBeNull();
  });

  it('Enter takes the first match, inserts it as one undo step and selects it', async () => {
    const { fixture, root, store } = await openEditor();
    press(slideButtons(root)[0], '/');
    await settle(fixture);
    typeInto(root.querySelector<HTMLInputElement>('#insert-filter')!, 'ellipse');
    await settle(fixture);
    press(document.activeElement!, 'Enter');
    await settle(fixture);
    expect(dialog(root)).toBeNull();
    const added = store.currentSlide().elements.at(-1)!;
    expect(added).toMatchObject({ type: 'shape', shape: 'ellipse' });
    expect(store.selection()).toEqual([added.id]);
    store.undo();
    expect(store.currentSlide().elements).toHaveLength(1);
    expect(store.canUndo()).toBe(false);
  });

  it('the arrow keys move between the filter and the list; a click chooses', async () => {
    const { fixture, root, store } = await openEditor();
    press(slideButtons(root)[0], '/');
    await settle(fixture);
    const filter = root.querySelector<HTMLInputElement>('#insert-filter')!;
    press(filter, 'ArrowDown');
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('app-insert-menu li button'));
    expect(document.activeElement).toBe(buttons[0]);
    press(buttons[0], 'ArrowDown');
    expect(document.activeElement).toBe(buttons[1]);
    press(buttons[1], 'ArrowUp');
    press(buttons[0], 'ArrowUp');
    expect(document.activeElement).toBe(filter);
    press(filter, 'ArrowDown');
    press(buttons[0], 'End'); // not a menu key: ignored
    buttons[5].click(); // Ellipse... any item
    await settle(fixture);
    expect(dialog(root)).toBeNull();
    expect(store.currentSlide().elements).toHaveLength(2);
  });

  it('offers every kind of element, and each one inserts', async () => {
    const { fixture, root, store } = await openEditor({ prepare: blank });
    const kinds: [string, string][] = [
      ['title', 'text'],
      ['bullet', 'text'],
      ['text', 'text'],
      ['rectangle', 'shape'],
      ['ellipse', 'shape'],
      ['triangle', 'shape'],
      ['line', 'line'],
      ['code', 'code'],
    ];
    for (const [query, type] of kinds) {
      press(slideButtons(root)[0], '/');
      await settle(fixture);
      typeInto(root.querySelector<HTMLInputElement>('#insert-filter')!, query);
      await settle(fixture);
      press(document.activeElement!, 'Enter');
      await settle(fixture);
      expect(store.currentSlide().elements.at(-1)!.type, query).toBe(type);
    }
    expect(store.currentSlide().elements).toHaveLength(kinds.length);
    expect(store.deck().components).toHaveLength(1);
  });

  it('Image opens the file picker instead of inserting', async () => {
    const { fixture, root, store } = await openEditor();
    const pick = vi.spyOn(TestBed.inject(InsertActions), 'pickImage').mockImplementation(() => undefined);
    press(slideButtons(root)[0], '/');
    await settle(fixture);
    typeInto(root.querySelector<HTMLInputElement>('#insert-filter')!, 'image');
    await settle(fixture);
    press(document.activeElement!, 'Enter');
    await settle(fixture);
    expect(pick).toHaveBeenCalledOnce();
    expect(store.currentSlide().elements).toHaveLength(1);
    expect(dialog(root)).toBeNull();
  });

  it('is not opened by / while typing in a text field, nor when a key was already used', async () => {
    const { fixture, root } = await openEditor();
    const notes = root.querySelector<HTMLTextAreaElement>('#speaker-notes')!;
    notes.focus();
    press(notes, '/');
    await settle(fixture);
    expect(dialog(root)).toBeNull();
    const canvas = root.querySelector<HTMLElement>('[aria-label="Slide canvas"]')!;
    press(canvas, '/'); // the canvas handles it (global shortcuts reach it through the registry) once, not twice
    await settle(fixture);
    expect(root.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it('has no AXE violations', async () => {
    const { fixture, root } = await openEditor();
    press(slideButtons(root)[0], '/');
    await settle(fixture);
    expect((await runAxe(root)).violations).toEqual([]);
  });
});

describe('the keyboard shortcut help', () => {
  it('opens with ? and lists every registered shortcut, grouped by scope', async () => {
    const { fixture, root } = await openEditor();
    press(slideButtons(root)[0], '?', { shiftKey: true });
    await settle(fixture);
    expect(dialog(root)?.getAttribute('aria-labelledby')).toBe('shortcut-help-title');
    const registry = TestBed.inject(ShortcutRegistry);
    const listed = Array.from(root.querySelectorAll('app-shortcut-help dt kbd'), (k) => k.textContent);
    expect(listed).toHaveLength(registry.shortcuts().length);
    const headings = Array.from(root.querySelectorAll('app-shortcut-help h3'), (h) => h.textContent);
    expect(headings).toEqual(['Anywhere in the editor', 'Slide canvas', 'Slide sorter', 'While editing text']);
    expect(listed).toEqual(expect.arrayContaining(['/', '?', 'Ctrl+D', 'Alt+Arrow up', 'Enter', 'Tab', 'Ctrl+B', 'Ctrl+K']));
  });

  it('closes with its button and gives focus back', async () => {
    const { fixture, root } = await openEditor();
    const open = root.querySelector<HTMLButtonElement>('app-editor-toolbar button:last-child')!;
    open.focus();
    open.click();
    await settle(fixture);
    expect(document.activeElement?.textContent).toBe('Close');
    (document.activeElement as HTMLButtonElement).click();
    await settle(fixture);
    expect(dialog(root)).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it('closes with Escape', async () => {
    const { fixture, root } = await openEditor();
    press(slideButtons(root)[0], '?');
    await settle(fixture);
    press(document.activeElement!, 'Escape');
    await settle(fixture);
    expect(dialog(root)).toBeNull();
  });

  it('keeps the editor shortcuts quiet while it is open', async () => {
    const { fixture, root, store } = await openEditor();
    press(slideButtons(root)[0], '?');
    await settle(fixture);
    press(document.body, '/'); // would open the insert menu
    await settle(fixture);
    expect(root.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(root.querySelector('app-insert-menu')).toBeNull();
    expect(store.canUndo()).toBe(false);
  });

  it('has no AXE violations', async () => {
    const { fixture, root } = await openEditor();
    press(slideButtons(root)[0], '?');
    await settle(fixture);
    expect((await runAxe(root)).violations).toEqual([]);
  });
});

describe('Escape', () => {
  const viewport = (root: HTMLElement) => root.querySelector<HTMLElement>('app-canvas .viewport')!;

  it('from the text field of a freshly inserted element clears the selection and returns to the canvas', async () => {
    const { fixture, root, store } = await openEditor();
    press(slideButtons(root)[0], '/');
    await settle(fixture);
    typeInto(root.querySelector<HTMLInputElement>('#insert-filter')!, 'title');
    await settle(fixture);
    press(document.activeElement!, 'Enter');
    await settle(fixture);
    expect(document.activeElement?.id).toBe('prop-text');
    expect(store.selection()).toHaveLength(1);
    const event = press(document.activeElement!, 'Escape');
    await settle(fixture);
    expect(event.defaultPrevented).toBe(true);
    expect(store.selection()).toEqual([]);
    expect(document.activeElement).toBe(viewport(root));
    expect(store.canUndo()).toBe(true); // the insertion stays
  });

  it.each([
    ['a slide button', (r: HTMLElement) => slideButtons(r)[0]],
    ['the notes', (r: HTMLElement) => r.querySelector<HTMLElement>('#speaker-notes')!],
    ['a reading-order button', (r: HTMLElement) => r.querySelector<HTMLElement>('app-reading-order .name')!],
    ['a number field', (r: HTMLElement) => r.querySelector<HTMLElement>('#prop-x')!],
  ])('from %s clears the selection and focuses the canvas', async (_label, target) => {
    const { fixture, root, store } = await openEditor();
    store.select([store.currentSlide().elements[0].id]);
    await settle(fixture);
    const element = target(root);
    element.focus();
    press(element, 'Escape');
    await settle(fixture);
    expect(store.selection()).toEqual([]);
    expect(document.activeElement).toBe(viewport(root));
  });

  it('with nothing selected only moves the focus to the canvas', async () => {
    const { fixture, root, store } = await openEditor();
    press(root.querySelector('#speaker-notes')!, 'Escape');
    await settle(fixture);
    expect(document.activeElement).toBe(viewport(root));
    expect(store.canUndo()).toBe(false);
  });

  it('on the canvas is left to the canvas, which announces once', async () => {
    const { fixture, root, store, announcer } = await openEditor();
    store.select([store.currentSlide().elements[0].id]);
    await settle(fixture);
    const announce = vi.spyOn(announcer, 'announce');
    viewport(root).focus();
    press(viewport(root), 'Escape');
    expect(store.selection()).toEqual([]);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Selection cleared');
  });

  it('does nothing while a dialog is open', async () => {
    const { fixture, root, store } = await openEditor();
    store.select([store.currentSlide().elements[0].id]);
    press(slideButtons(root)[0], '?');
    await settle(fixture);
    press(document.activeElement!, 'Escape'); // closes the dialog only
    await settle(fixture);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(store.selection()).toHaveLength(1);
  });

  it('closing the section form with Escape keeps the selection', async () => {
    const { fixture, root, store } = await openEditor();
    store.select([store.currentSlide().elements[0].id]);
    root.querySelector<HTMLButtonElement>('.tools button[aria-haspopup]')!.click();
    await settle(fixture);
    press(root.querySelector('#section-name')!, 'Escape');
    await settle(fixture);
    expect(root.querySelector('form')).toBeNull();
    expect(store.selection()).toHaveLength(1);
  });
});

describe('shortcut registration', () => {
  it('registers without conflict and removes everything when the editor is destroyed', async () => {
    const { fixture } = await openEditor();
    const registry = TestBed.inject(ShortcutRegistry);
    expect(registry.shortcuts().length).toBeGreaterThan(20);
    expect(new Set(registry.shortcuts().map((s) => s.id)).size).toBe(registry.shortcuts().length);
    fixture.destroy();
    expect(registry.shortcuts()).toEqual([]);
  });
});

describe('quality scenarios', () => {
  it('Q1: a slide with a title and a bullet list is made from the keyboard in a handful of key presses', async () => {
    const { fixture, root, store } = await openEditor({ slides: 1, prepare: blank });
    let keystrokes = 0;
    const key = (target: Element, k: string, options = {}) => {
      keystrokes++;
      press(target, k, options);
    };
    const insert = async (query: string) => {
      key(document.activeElement ?? document.body, '/');
      await settle(fixture);
      typeInto(root.querySelector<HTMLInputElement>('#insert-filter')!, query);
      keystrokes += query.length;
      await settle(fixture);
      key(document.activeElement!, 'Enter');
      await settle(fixture);
    };

    slideButtons(root)[0].focus();
    key(document.activeElement!, 'Enter'); // a new slide after the blank one
    await settle(fixture);
    expect(store.currentSlideIndex()).toBe(1);

    await insert('title');
    expect(document.activeElement?.id).toBe('prop-text'); // typing can start at once
    typeInto(document.activeElement as HTMLTextAreaElement, 'Quarterly review');
    await settle(fixture);

    slideButtons(root)[1].focus();
    await insert('bullet');
    expect(document.activeElement?.id).toBe('prop-text');
    typeInto(document.activeElement as HTMLTextAreaElement, '- Revenue up\n- Costs flat');
    await settle(fixture);

    const [title, bullets] = store.currentSlide().elements;
    expect(title).toMatchObject({ type: 'text', text: 'Quarterly review', font: 'heading' });
    expect(bullets).toMatchObject({ type: 'text', text: '- Revenue up\n- Costs flat' });
    expect(root.querySelector('.canvas')?.textContent).toContain('Quarterly review');
    expect(keystrokes).toBeLessThan(30); // well within 30 s at any typing speed
  });

  it('Q2: a slide with a titled image is made from the keyboard, ending in the alt text field', async () => {
    const { fixture, root, store } = await openEditor({ slides: 1, prepare: blank });
    const insertActions = TestBed.inject(InsertActions);
    const pick = vi.spyOn(insertActions, 'pickImage').mockImplementation(() => undefined);
    slideButtons(root)[0].focus();
    press(document.activeElement!, 'Enter');
    await settle(fixture);

    press(document.activeElement!, '/');
    await settle(fixture);
    typeInto(root.querySelector<HTMLInputElement>('#insert-filter')!, 'title');
    await settle(fixture);
    press(document.activeElement!, 'Enter');
    await settle(fixture);
    typeInto(document.activeElement as HTMLTextAreaElement, 'The team');
    await settle(fixture);

    slideButtons(root)[1].focus();
    press(document.activeElement!, '/');
    await settle(fixture);
    typeInto(root.querySelector<HTMLInputElement>('#insert-filter')!, 'image');
    await settle(fixture);
    press(document.activeElement!, 'Enter');
    await settle(fixture);
    expect(pick).toHaveBeenCalledOnce(); // the browser's file dialog takes over here
    await insertActions.insertImage(new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })); // what the dialog would hand back
    await settle(fixture);

    expect(document.activeElement?.id).toBe('prop-alt');
    typeInto(document.activeElement as HTMLInputElement, 'Five people around a table');
    await settle(fixture);

    const [title, image] = store.currentSlide().elements;
    expect(title).toMatchObject({ type: 'text', text: 'The team' });
    expect(image).toMatchObject({ type: 'image', alt: 'Five people around a table' });
    expect(Object.keys(store.deck().assets)).toHaveLength(1);
    expect(currentSlideButton(root)).not.toBeNull();
  });
});

describe('starting the presentation', () => {
  async function editorWithRouterSpy() {
    const editor = await openEditor();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    return { ...editor, navigate };
  }

  it('starts from the current slide with the Present button', async () => {
    const { fixture, root, store, navigate } = await editorWithRouterSpy();
    store.selectSlide(store.slides()[1].id);
    await settle(fixture);
    const button = Array.from(root.querySelectorAll<HTMLButtonElement>('app-editor-toolbar button')).find((b) => b.textContent?.includes('Present'))!;
    button.click();
    expect(navigate).toHaveBeenCalledWith(['/deck', store.deck().id, 'present'], { queryParams: { slide: store.currentSlideIndex() + 1 } });
  });

  it('starts with F5 from the sorter', async () => {
    const { fixture, root, store, navigate } = await editorWithRouterSpy();
    const event = press(slideButtons(root)[0], 'F5');
    await settle(fixture);
    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith(['/deck', store.deck().id, 'present'], { queryParams: { slide: 1 } });
  });

  it('lists the shortcut in the help', async () => {
    const { fixture, root } = await openEditor();
    press(slideButtons(root)[0], '?');
    await settle(fixture);
    expect(root.querySelector('app-shortcut-help')?.textContent).toContain('Present from the current slide');
  });
});
