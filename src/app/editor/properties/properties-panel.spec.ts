import { createElement, ELEMENT_TYPES, type Deck, type Element } from '../../core/model';
import { MoveElements } from '../../core/store';
import { openEditor, runAxe, settle, type Editor } from '../editor-test-setup';

afterEach(() => document.body.replaceChildren());

const HASH = 'a'.repeat(64);

function prepare(deck: Deck): void {
  deck.layouts.push({ id: 'ly_title', name: 'Title slide', placeholders: [] });
  deck.assets[HASH] = { blobKey: HASH, mime: 'image/png', hash: HASH, size: 4 };
  deck.slides[0].elements.push(
    createElement('shape', { x: 50, y: 60, w: 300, h: 200, shape: 'rect', stroke: { token: 'text' }, strokeWidth: 2 }),
    createElement('text', { text: 'Fixed', locked: true, x: 400, y: 400 }),
    createElement('image', { assetId: HASH, alt: 'Logo', x: 10, y: 10, w: 100, h: 100 }),
    createElement('line', { x: 0, y: 500, w: 800, h: 0 }),
  );
}

const open = () => openEditor({ prepare });
const panel = (e: Editor) => e.root.querySelector<HTMLElement>('app-properties-panel')!;
const field = <T extends HTMLElement = HTMLInputElement>(e: Editor, key: string) => panel(e).querySelector<T>(`#prop-${key}`)!;
const legends = (e: Editor) => Array.from(panel(e).querySelectorAll('legend'), (l) => l.textContent);

async function select(e: Editor, index: number): Promise<Element> {
  const element = e.store.currentSlide().elements[index];
  e.store.select([element.id]);
  await settle(e.fixture);
  return element;
}

/** Sets a control's value the way the browser reports a user edit. */
async function edit(e: Editor, control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string | boolean): Promise<void> {
  if (typeof value === 'boolean') (control as HTMLInputElement).checked = value;
  else control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
  await settle(e.fixture);
}

const selected = (e: Editor) => e.store.selectedElements()[0] as unknown as Record<string, unknown>;

describe('PropertiesPanel: sections', () => {
  it('shows the slide while nothing is selected', async () => {
    const e = await open();
    expect(panel(e).querySelector('h2')?.textContent).toBe('Slide 1');
    expect(legends(e)).toEqual(['Layout and background']);
    expect(panel(e).querySelector('#prop-x')).toBeNull();
  });

  it('builds the sections of a text element from its schema', async () => {
    const e = await open();
    await select(e, 0);
    expect(panel(e).querySelector('h2')?.textContent).toBe('Properties');
    expect(legends(e)).toEqual(['Position and size', 'Text formatting', 'Arrangement']);
    expect(field(e, 'text').tagName).toBe('TEXTAREA');
    expect(field<HTMLSelectElement>(e, 'align').tagName).toBe('SELECT');
    expect(field(e, 'fontSize').type).toBe('number');
    expect(panel(e).querySelector('app-color-control')).not.toBeNull();
  });

  it('shows fill and stroke for a shape, alt text and fit for an image, and only stroke for a line', async () => {
    const e = await open();
    await select(e, 1);
    expect(legends(e)).toEqual(['Position and size', 'Content', 'Fill and stroke', 'Arrangement']);
    expect(field(e, 'strokeWidth').value).toBe('2');
    expect(panel(e).querySelector('app-fill-control')).not.toBeNull();
    await select(e, 3);
    expect(field(e, 'alt').value).toBe('Logo');
    expect(field<HTMLSelectElement>(e, 'fit').value).toBe('contain');
    expect(panel(e).querySelector('#prop-assetId')).toBeNull(); // assets are not edited as text
    await select(e, 4);
    expect(legends(e)).toEqual(['Position and size', 'Fill and stroke', 'Arrangement']);
  });

  it('every element type gets at least the geometry section, with no panel code of its own', async () => {
    const e = await open();
    for (const type of ELEMENT_TYPES) {
      const extras: Record<string, unknown> = type === 'code' ? { componentId: 'cp_none' } : {};
      const element = createElement(type, extras as never);
      e.store.load({ ...e.store.deck(), components: [], slides: [{ ...e.store.currentSlide(), elements: [element] }] });
      e.store.select([element.id]);
      await settle(e.fixture);
      expect(legends(e), type).toContain('Position and size');
      for (const key of ['x', 'y', 'w', 'h', 'rotation']) expect(field(e, key), `${type}.${key}`).not.toBeNull();
    }
  });

  it('says how many are selected, and offers no fields, for several elements', async () => {
    const e = await open();
    e.store.select(e.store.currentSlide().elements.slice(0, 2).map((x) => x.id));
    await settle(e.fixture);
    expect(panel(e).textContent).toContain('2 elements selected');
    expect(legends(e)).toEqual([]);
  });
});

describe('PropertiesPanel: edits dispatch commands', () => {
  it('a number edit is one SetProps and one undo step, and the field shows the stored value', async () => {
    const e = await open();
    const shape = await select(e, 1);
    await edit(e, field(e, 'x'), '120');
    expect(selected(e)['x']).toBe(120);
    expect(selected(e)['y']).toBe(60); // untouched
    e.store.undo();
    await settle(e.fixture);
    expect(selected(e)['x']).toBe((shape as { x: number }).x);
    expect(field(e, 'x').value).toBe('50');
    expect(e.store.canUndo()).toBe(false);
  });

  it('typing in a field is one undo step however many characters', async () => {
    const e = await open();
    await select(e, 0);
    for (const value of ['M', 'Mo', 'Mon', 'Mond']) await edit(e, field(e, 'text'), value);
    expect(selected(e)['text']).toBe('Mond');
    e.store.undo();
    expect(selected(e)['text']).toBe('Welcome');
    expect(e.store.canUndo()).toBe(false);
  });

  it('an unchanged form dispatches nothing: selecting and looking leaves the history empty', async () => {
    const e = await open();
    for (let i = 0; i < 5; i++) await select(e, i);
    expect(e.store.canUndo()).toBe(false);
  });

  it('follows changes made elsewhere without writing them back', async () => {
    const e = await open();
    const shape = await select(e, 1);
    e.store.execute(new MoveElements([shape.id], 25, 0));
    await settle(e.fixture);
    expect(field(e, 'x').value).toBe('75');
    e.store.undo();
    await settle(e.fixture);
    expect(field(e, 'x').value).toBe('50');
    expect(e.store.canUndo()).toBe(false); // the panel added no entries of its own
  });

  it('refills when the selection moves to another element', async () => {
    const e = await open();
    await select(e, 0);
    expect(field(e, 'text').value).toBe('Welcome');
    await select(e, 3);
    expect(field(e, 'alt').value).toBe('Logo');
    await select(e, 0);
    expect(field(e, 'text').value).toBe('Welcome');
  });

  it('rejects an out-of-range number: shows why, dispatches nothing, and leaves the other fields working', async () => {
    const e = await open();
    await select(e, 1);
    await edit(e, field(e, 'w'), '-5');
    expect(panel(e).querySelector('.error')?.textContent).toBe('Width must be at least 0');
    expect(field(e, 'w').getAttribute('aria-invalid')).toBe('true');
    expect(selected(e)['w']).toBe(300);
    await edit(e, field(e, 'x'), '10');
    expect(selected(e)['x']).toBe(10);
    expect(selected(e)['w']).toBe(300);
    await edit(e, field(e, 'w'), '2000000');
    expect(panel(e).querySelector('.error')?.textContent).toBe('Width must be at most 1000000');
    await edit(e, field(e, 'w'), '400');
    expect(panel(e).querySelector('.error')).toBeNull();
    expect(selected(e)['w']).toBe(400);
  });

  it('rejects a fraction for the whole-number step field, and an empty number does nothing', async () => {
    const e = await open();
    await select(e, 1);
    await edit(e, field(e, 'step'), '1.5');
    expect(panel(e).querySelector('.error')?.textContent).toBe('Appears at step must be a whole number');
    expect(selected(e)['step']).toBeUndefined();
    await edit(e, field(e, 'step'), '2');
    expect(selected(e)['step']).toBe(2);
    await edit(e, field(e, 'x'), '');
    expect(selected(e)['x']).toBe(50);
    expect(e.store.canUndo()).toBe(true);
  });

  it('checkboxes set and clear flags', async () => {
    const e = await open();
    await select(e, 1);
    await edit(e, field(e, 'hidden'), true);
    expect(selected(e)['hidden']).toBe(true);
    await edit(e, field(e, 'hidden'), false);
    expect(selected(e)['hidden']).toBe(false);
  });

  it('selects set enums; the font select can fall back to the default, which removes the font', async () => {
    const e = await open();
    await select(e, 0);
    await edit(e, field<HTMLSelectElement>(e, 'align'), 'center');
    expect(selected(e)['align']).toBe('center');
    await edit(e, field<HTMLSelectElement>(e, 'font'), 'heading');
    expect(selected(e)['font']).toBe('heading');
    await edit(e, field<HTMLSelectElement>(e, 'font'), '');
    expect('font' in selected(e)).toBe(false);
  });

  it('colours: a theme token, a custom colour, and none for an optional stroke', async () => {
    const e = await open();
    await select(e, 1);
    const colour = (label: string) => Array.from(panel(e).querySelectorAll('app-color-control')).find((c) => c.textContent?.includes(label))!;
    const strokeSelect = () => colour('Stroke').querySelector<HTMLSelectElement>('select')!;
    expect(strokeSelect().value).toBe('token:text');
    await edit(e, strokeSelect(), 'token:accent');
    expect(selected(e)['stroke']).toEqual({ token: 'accent' });
    await edit(e, strokeSelect(), 'custom');
    expect(selected(e)['stroke']).toBe('#000000');
    const picker = colour('Stroke').querySelector<HTMLInputElement>('input[type="color"]')!;
    expect(picker.getAttribute('aria-label')).toBe('Stroke, custom colour');
    await edit(e, picker, '#ff8800');
    expect(selected(e)['stroke']).toBe('#ff8800');
    await edit(e, strokeSelect(), 'none');
    expect('stroke' in selected(e)).toBe(false);
  });

  it('a required colour offers no "None"', async () => {
    const e = await open();
    await select(e, 0);
    const options = Array.from(panel(e).querySelectorAll('app-color-control option'), (o) => (o as HTMLOptionElement).value);
    expect(options).not.toContain('none');
    expect(options).toContain('token:accent');
  });

  it('fills: none, solid and a kept gradient', async () => {
    const e = await open();
    await select(e, 1);
    const fill = () => panel(e).querySelector<HTMLSelectElement>('app-fill-control select')!;
    expect(fill().value).toBe('solid');
    await edit(e, fill(), 'none');
    expect('fill' in selected(e)).toBe(false);
    await edit(e, fill(), 'solid');
    expect(selected(e)['fill']).toEqual({ kind: 'solid', color: { token: 'accent' } });
    e.store.execute(new MoveElements([selected(e)['id'] as string], 0, 0));
    const gradient = { kind: 'gradient', angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] };
    const { SetProps } = await import('../../core/store');
    e.store.execute(new SetProps([selected(e)['id'] as string], { fill: gradient }));
    await settle(e.fixture);
    expect(fill().value).toBe('gradient');
    expect(fill().textContent).toContain('Gradient (kept)');
    expect(panel(e).querySelector('app-fill-control app-color-control')).toBeNull();
  });
});

describe('PropertiesPanel: locked elements', () => {
  it('disables everything but the arrangement section until unlocked', async () => {
    const e = await open();
    await select(e, 2);
    expect(panel(e).textContent).toContain('This element is locked');
    const disabled = Array.from(panel(e).querySelectorAll<HTMLFieldSetElement>('fieldset'), (f) => [f.querySelector('legend')?.textContent, f.disabled]);
    expect(disabled).toEqual([
      ['Position and size', true],
      ['Text formatting', true],
      ['Arrangement', false],
    ]);
    await edit(e, field(e, 'locked'), false);
    expect(selected(e)['locked']).toBe(false);
    expect(panel(e).textContent).not.toContain('This element is locked');
    expect(panel(e).querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(false);
    await edit(e, field(e, 'x'), '5');
    expect(selected(e)['x']).toBe(5);
  });

  it('does not change a locked element even if a value is forced into the form', async () => {
    const e = await open();
    const locked = await select(e, 2);
    await edit(e, field(e, 'x'), '999'); // a disabled control cannot be typed in; a script could
    expect((selected(e)['x'])).toBe((locked as { x: number }).x);
  });

  it('colour and fill controls ignore a locked element too', async () => {
    const e = await open();
    await select(e, 2);
    const before = e.store.deck();
    const select2 = panel(e).querySelector<HTMLSelectElement>('app-color-control select')!;
    await edit(e, select2, 'token:accent');
    expect(e.store.deck()).toBe(before);
  });
});

describe('PropertiesPanel: the slide', () => {
  it('switches the layout through a command and says nothing is wrong when it is already set', async () => {
    const e = await open();
    const layout = panel(e).querySelector<HTMLSelectElement>('#slide-layout')!;
    expect(Array.from(layout.options, (o) => o.textContent)).toEqual(['Blank', 'Title slide']);
    await edit(e, layout, 'ly_title');
    expect(e.store.currentSlide().layoutId).toBe('ly_title');
    e.store.undo();
    await settle(e.fixture);
    expect(e.store.currentSlide().layoutId).not.toBe('ly_title');
    expect(panel(e).querySelector<HTMLSelectElement>('#slide-layout')!.value).toBe(e.store.currentSlide().layoutId);
  });

  it('sets and removes a background', async () => {
    const e = await open();
    const background = () => panel(e).querySelector<HTMLSelectElement>('app-fill-control select')!;
    expect(background().value).toBe('none');
    expect(background().textContent).toContain('Layout background');
    await edit(e, background(), 'solid');
    expect(e.store.currentSlide().background).toEqual({ kind: 'solid', color: { token: 'accent' } });
    const colour = panel(e).querySelector<HTMLSelectElement>('app-fill-control app-color-control select')!;
    await edit(e, colour, 'token:background');
    expect(e.store.currentSlide().background).toEqual({ kind: 'solid', color: { token: 'background' } });
    await edit(e, background(), 'none');
    expect(e.store.currentSlide().background).toBeUndefined();
  });

  it('a command that is rejected is announced, not thrown', async () => {
    const e = await open();
    const announce = vi.spyOn(e.announcer, 'announce');
    const layout = panel(e).querySelector<HTMLSelectElement>('#slide-layout')!;
    const option = document.createElement('option');
    option.value = 'ly_missing';
    layout.append(option);
    await edit(e, layout, 'ly_missing');
    expect(announce).toHaveBeenCalledWith('Layout "ly_missing" does not exist');
  });
});

describe('PropertiesPanel: accessibility', () => {
  it('has no AXE violations for the slide, a text element, a shape and a locked element', async () => {
    const e = await open();
    expect((await runAxe(panel(e))).violations).toEqual([]);
    for (const index of [0, 1, 2, 3]) {
      await select(e, index);
      expect((await runAxe(panel(e))).violations, `element ${index}`).toEqual([]);
    }
  });

  it('every field has a label, and an invalid one is marked and explained', async () => {
    const e = await open();
    await select(e, 1);
    await edit(e, field(e, 'h'), '-1');
    const controls = Array.from(panel(e).querySelectorAll<HTMLElement>('input, select, textarea'));
    for (const control of controls) {
      const label = control.id ? panel(e).querySelector(`label[for="${control.id}"]`) : null;
      expect(label !== null || control.getAttribute('aria-label') !== null, control.outerHTML).toBe(true);
    }
    expect(panel(e).querySelector('[role="alert"]')?.textContent).toContain('Height must be at least 0');
  });
});
