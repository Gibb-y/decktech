import { createElement } from '../core/model';
import { openEditor, press, runAxe, settle, type as typeInto, type Editor } from './editor-test-setup';

afterEach(() => document.body.replaceChildren());

const prepare = (deck: { slides: { elements: unknown[] }[] }) => {
  deck.slides[0].elements.push(createElement('shape', { shape: 'ellipse' }), createElement('line'));
};
const notes = (e: Editor) => e.root.querySelector<HTMLTextAreaElement>('#speaker-notes')!;
const rows = (e: Editor) => Array.from(e.root.querySelectorAll<HTMLElement>('app-reading-order li'));
const names = (e: Editor) => rows(e).map((r) => r.querySelector('.name')!.textContent);

describe('NotesPane', () => {
  it('shows the notes of the current slide under a label that names the slide', async () => {
    const e = await openEditor();
    expect(e.root.querySelector('label[for="speaker-notes"]')?.textContent).toBe('Speaker notes for slide 1');
    expect(notes(e).value).toBe('');
    typeInto(notes(e), 'Open with the story');
    await settle(e.fixture);
    expect(e.store.slides()[0].notes).toBe('Open with the story');
    e.store.selectSlide(e.store.slides()[1].id);
    await settle(e.fixture);
    expect(e.root.querySelector('label[for="speaker-notes"]')?.textContent).toBe('Speaker notes for slide 2');
    expect(notes(e).value).toBe('');
    e.store.selectSlide(e.store.slides()[0].id);
    await settle(e.fixture);
    expect(notes(e).value).toBe('Open with the story');
  });

  it('typing is one undo step per slide, and undo updates the box', async () => {
    const e = await openEditor();
    for (const value of ['a', 'ab', 'abc']) typeInto(notes(e), value);
    await settle(e.fixture);
    e.store.undo();
    await settle(e.fixture);
    expect(notes(e).value).toBe('');
    expect(e.store.canUndo()).toBe(false);
    e.store.redo();
    await settle(e.fixture);
    expect(notes(e).value).toBe('abc');
  });

  it('is a labelled region without AXE violations', async () => {
    const e = await openEditor();
    expect(e.root.querySelector('section[aria-label="Speaker notes"]')).not.toBeNull();
    expect((await runAxe(e.root.querySelector('app-notes-pane')!)).violations).toEqual([]);
  });
});

describe('ReadingOrder', () => {
  it('lists the elements of the slide in order, and says so when there are none', async () => {
    const e = await openEditor({ prepare });
    expect(names(e)).toEqual(['Text “Welcome”', 'Ellipse', 'Line']);
    e.store.selectSlide(e.store.slides()[1].id);
    await settle(e.fixture);
    expect(e.root.querySelector('app-reading-order')?.textContent).toContain('This slide has no elements yet');
    expect(rows(e)).toHaveLength(0);
  });

  it('moves an element one place with a button, as one undo step, keeping it selected and the focus on the button', async () => {
    const e = await openEditor({ prepare });
    const [first, second] = e.store.currentSlide().elements.map((x) => x.id);
    const later = e.root.querySelector<HTMLButtonElement>(`[data-move="${first}:later"]`)!;
    expect(later.getAttribute('aria-label')).toBe('Move Text “Welcome” later');
    later.focus();
    later.click();
    await settle(e.fixture);
    expect(e.store.currentSlide().elements.map((x) => x.id).slice(0, 2)).toEqual([second, first]);
    expect(e.store.selection()).toEqual([first]);
    expect(names(e)).toEqual(['Ellipse', 'Text “Welcome”', 'Line']);
    expect(document.activeElement).toBe(e.root.querySelector(`[data-move="${first}:later"]`));
    e.store.undo();
    expect(e.store.currentSlide().elements[0].id).toBe(first);
    expect(e.store.canUndo()).toBe(false);
  });

  it('cannot move past either end: the button is aria-disabled, does nothing and says why', async () => {
    const e = await openEditor({ prepare });
    const announce = vi.spyOn(e.announcer, 'announce');
    const [first, , third] = e.store.currentSlide().elements.map((x) => x.id);
    const earlier = e.root.querySelector<HTMLButtonElement>(`[data-move="${first}:earlier"]`)!;
    expect(earlier.getAttribute('aria-disabled')).toBe('true');
    earlier.click();
    expect(announce).toHaveBeenLastCalledWith('Already first in reading order');
    const later = e.root.querySelector<HTMLButtonElement>(`[data-move="${third}:later"]`)!;
    expect(later.getAttribute('aria-disabled')).toBe('true');
    later.click();
    expect(announce).toHaveBeenLastCalledWith('Already last in reading order');
    expect(e.store.canUndo()).toBe(false);
  });

  it('moving to the end hands the focus to the other arrow, which is still usable', async () => {
    const e = await openEditor({ prepare });
    const [, , third] = e.store.currentSlide().elements.map((x) => x.id);
    const earlier = e.root.querySelector<HTMLButtonElement>(`[data-move="${third}:earlier"]`)!;
    earlier.click(); // third -> second place
    await settle(e.fixture);
    e.root.querySelector<HTMLButtonElement>(`[data-move="${third}:earlier"]`)!.click(); // -> first place
    await settle(e.fixture);
    expect(e.store.currentSlide().elements[0].id).toBe(third);
    expect(document.activeElement).toBe(e.root.querySelector(`[data-move="${third}:later"]`));
  });

  it('announces the new position', async () => {
    const e = await openEditor({ prepare });
    const announce = vi.spyOn(e.announcer, 'announce');
    const [first] = e.store.currentSlide().elements.map((x) => x.id);
    e.root.querySelector<HTMLButtonElement>(`[data-move="${first}:later"]`)!.click();
    expect(announce).toHaveBeenLastCalledWith('Text “Welcome” moved to position 2 of 3');
    e.root.querySelector<HTMLButtonElement>(`[data-move="${first}:earlier"]`)!.click();
    expect(announce).toHaveBeenLastCalledWith('Text “Welcome” moved to position 1 of 3');
  });

  it('selects an element from its name, and shows which one is selected', async () => {
    const e = await openEditor({ prepare });
    const [, second] = e.store.currentSlide().elements.map((x) => x.id);
    rows(e)[1].querySelector<HTMLButtonElement>('.name')!.click();
    await settle(e.fixture);
    expect(e.store.selection()).toEqual([second]);
    expect(rows(e)[1].querySelector('.name')?.getAttribute('aria-pressed')).toBe('true');
    expect(rows(e)[0].querySelector('.name')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('reads the order out to Tab: the canvas visits elements in the same order', async () => {
    const e = await openEditor({ prepare });
    const canvas = e.root.querySelector<HTMLElement>('[aria-label="Slide canvas"]')!;
    const [first, second, third] = e.store.currentSlide().elements.map((x) => x.id);
    const visited: string[][] = [];
    for (let i = 0; i < 3; i++) {
      press(canvas, 'Tab');
      visited.push([...e.store.selection()]);
    }
    expect(visited.flat()).toEqual([first, second, third]);
  });

  it('has no AXE violations', async () => {
    const e = await openEditor({ prepare });
    expect((await runAxe(e.root.querySelector('app-reading-order')!)).violations).toEqual([]);
  });
});
