import { Component, input, output } from '@angular/core';
import { By } from '@angular/platform-browser';
import { createElement, type CodeEl, type ComponentDef, type Deck } from '../core/model';
import { SetComponentSource, SetProps } from '../core/store';
import { COMPONENT_TOOLS } from '../renderer';
import { Canvas } from './canvas';
import { openEditor, press, runAxe, settle, type Editor } from './editor-test-setup';

afterEach(() => document.body.replaceChildren());

const HASH = 'b'.repeat(64);

const everything: ComponentDef = {
  id: 'cp_all',
  name: 'Everything',
  html: '',
  css: '',
  js: '',
  propSchema: [
    { key: 'title', type: 'string', label: 'Title', default: 'Hello' },
    { key: 'count', type: 'number', label: 'Count', default: 2, min: 0, max: 10 },
    { key: 'on', type: 'boolean', label: 'Switch', default: false },
    { key: 'tint', type: 'color', label: 'Tint', default: '#336699' },
    { key: 'mode', type: 'select', label: 'Mode', default: 'a', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] },
    { key: 'pic', type: 'asset', label: 'Picture', default: '' },
  ],
  permissions: [],
  files: [],
  libs: [],
};

function prepare(deck: Deck): void {
  deck.assets[HASH] = { blobKey: HASH, hash: HASH, mime: 'image/png', size: 4 };
  deck.components.push(everything);
  deck.slides[0].elements.push(
    createElement('code', { componentId: everything.id, props: { count: 5 }, x: 100, y: 100, w: 600, h: 300 }),
    createElement('code', { componentId: everything.id, props: {}, x: 800, y: 100, w: 600, h: 300 }),
  );
}

@Component({ selector: 'app-fake-tools', template: `<div role="dialog" aria-label="fake tools" class="fake">{{ view() }}:{{ elementId() }} <button type="button" (click)="closed.emit()">Close fake</button></div>` })
class FakeTools {
  readonly view = input<'edit' | 'library'>('edit');
  readonly elementId = input<string | null>(null);
  readonly closed = output<void>();
}

const open = () => openEditor({ prepare, providers: [{ provide: COMPONENT_TOOLS, useValue: () => Promise.resolve(FakeTools) }] });
const panel = (e: Editor) => e.root.querySelector<HTMLElement>('app-code-props')!;
const codeEls = (e: Editor) => e.store.currentSlide().elements.filter((x): x is CodeEl => x.type === 'code');
const control = (e: Editor, label: string) => {
  const l = Array.from(panel(e).querySelectorAll('label')).find((x) => x.textContent?.trim().startsWith(label))!;
  return panel(e).querySelector<HTMLInputElement & HTMLSelectElement>(`#${l.getAttribute('for')}`)!;
};
const buttonNamed = (e: Editor, name: string) => Array.from(e.root.querySelectorAll('button')).find((b) => b.textContent?.trim().startsWith(name))!;

async function selectCode(e: Editor, index = 0): Promise<CodeEl> {
  const element = codeEls(e)[index];
  e.store.select([element.id]);
  await settle(e.fixture);
  return element;
}

async function edit(e: Editor, el: HTMLInputElement & HTMLSelectElement, value: string | boolean): Promise<void> {
  if (typeof value === 'boolean') el.checked = value;
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await settle(e.fixture);
}

describe('the properties form of a code component', () => {
  it('is generated from the propSchema, showing what the component gets (stored value or default)', async () => {
    const e = await open();
    await selectCode(e);
    expect(Array.from(panel(e).querySelectorAll('legend'), (l) => l.textContent)).toEqual(['Code component', 'Everything properties']);
    expect(control(e, 'Title').value).toBe('Hello');
    expect(control(e, 'Count').value).toBe('5');
    expect(control(e, 'Switch').checked).toBe(false);
    expect(control(e, 'Tint').value).toBe('#336699');
    expect(control(e, 'Mode').value).toBe('a');
    expect(Array.from(control(e, 'Mode').options, (o) => o.textContent)).toEqual(['Alpha', 'Beta']);
    expect(Array.from(control(e, 'Picture').options, (o) => o.value)).toEqual(['', HASH]);
    expect(e.store.canUndo()).toBe(false); // filling the form from the element dispatches nothing
  });

  it('applies each kind of value through SetCodeProps, one undo step each', async () => {
    const e = await open();
    const el = await selectCode(e);
    const props = () => (e.store.deck().slides[0].elements.find((x) => x.id === el.id) as CodeEl).props;
    await edit(e, control(e, 'Title'), 'Hi there');
    await edit(e, control(e, 'Count'), '7');
    await edit(e, control(e, 'Switch'), true);
    await edit(e, control(e, 'Tint'), 'rebeccapurple');
    await edit(e, control(e, 'Mode'), 'b');
    await edit(e, control(e, 'Picture'), HASH);
    expect(props()).toEqual({ count: 7, title: 'Hi there', on: true, tint: 'rebeccapurple', mode: 'b', pic: HASH });
    e.store.undo();
    expect(props()['pic']).toBeUndefined();
    expect(props()['mode']).toBe('b');
  });

  it('merges a burst of typing into one undo step', async () => {
    const e = await open();
    const el = await selectCode(e);
    for (const text of ['H', 'Hi', 'Hi!']) await edit(e, control(e, 'Title'), text);
    e.store.undo();
    expect((e.store.deck().slides[0].elements.find((x) => x.id === el.id) as CodeEl).props['title']).toBeUndefined();
    expect(e.store.canUndo()).toBe(false);
  });

  it('flags a value the schema rejects, does not send it, and keeps the valid fields working', async () => {
    const e = await open();
    const el = await selectCode(e);
    await edit(e, control(e, 'Count'), '11');
    const input = control(e, 'Count');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(panel(e).querySelector('[role="alert"]')?.textContent).toBe('Must be at most 10');
    expect(input.getAttribute('aria-describedby')).toBe(panel(e).querySelector('[role="alert"]')!.id);
    expect((e.store.currentSlide().elements.find((x) => x.id === el.id) as CodeEl).props['count']).toBe(5);
    await edit(e, control(e, 'Title'), 'Still works');
    expect((e.store.currentSlide().elements.find((x) => x.id === el.id) as CodeEl).props).toMatchObject({ count: 5, title: 'Still works' });
  });

  it.each([
    ['a colour that is CSS injection', 'Tint', 'red; background:url(x)', /Must be a colour/],
    ['an empty number', 'Count', '', /Must be a number/],
  ])('rejects %s', async (_name, label, value, message) => {
    const e = await open();
    await selectCode(e);
    await edit(e, control(e, label), value);
    expect(panel(e).querySelector('[role="alert"]')?.textContent).toMatch(message);
    expect(e.store.canUndo()).toBe(false);
  });

  it('shows the form of each element with its own values', async () => {
    const e = await open();
    await selectCode(e, 1);
    expect(control(e, 'Count').value).toBe('2');
  });

  it('is read-only while the element is locked', async () => {
    const e = await open();
    const el = await selectCode(e);
    e.store.execute(new SetProps([el.id], { locked: true }));
    await settle(e.fixture);
    expect(Array.from(panel(e).querySelectorAll('fieldset'), (f) => f.disabled)).toEqual([true, true]);
  });

  it('passes AXE', async () => {
    const e = await open();
    await selectCode(e);
    expect((await runAxe(panel(e))).violations.map((v) => v.id)).toEqual([]);
  });
});

describe('sharing and detaching', () => {
  it('says how many elements share the definition and detaches one into its own copy', async () => {
    const e = await open();
    const [first, second] = codeEls(e);
    await selectCode(e);
    expect(panel(e).textContent).toContain('Shared by 2 elements');
    buttonNamed(e, 'Detach').click();
    await settle(e.fixture);
    const now = codeEls(e);
    expect(now[0].componentId).not.toBe(everything.id);
    expect(now[1].componentId).toBe(everything.id);
    expect(now[0].props).toEqual(first.props);
    expect(e.store.deck().components.map((c) => c.name)).toEqual(['Everything', 'Everything (copy)']);
    expect(panel(e).textContent).toContain('Used only here');
    expect(Array.from(e.root.querySelectorAll('button'), (b) => b.textContent?.trim())).not.toContain('Detach (make unique)');
    // the copy is independent
    e.store.execute(new SetComponentSource(now[0].componentId, { js: 'mine()' }));
    expect(e.store.deck().components.find((c) => c.id === everything.id)!.js).toBe('');
    // and a single undo step takes the detach back
    e.store.undo();
    e.store.undo();
    expect(codeEls(e).map((x) => x.componentId)).toEqual([everything.id, everything.id]);
    expect(codeEls(e)[1]).toBe(second);
  });
});

describe('opening the code tools', () => {
  const dialog = (e: Editor) => document.querySelector('app-fake-tools .fake');
  const close = async (e: Editor) => {
    document.querySelector<HTMLButtonElement>('app-fake-tools button')!.click();
    await settle(e.fixture);
  };

  it('"Edit code…" in the panel opens the editor for the selected element, and closing removes it', async () => {
    const e = await open();
    const el = await selectCode(e);
    buttonNamed(e, 'Edit code…').click();
    await settle(e.fixture);
    expect(dialog(e)?.textContent).toContain(`edit:${el.id}`);
    await close(e);
    expect(dialog(e)).toBeNull();
  });

  it('the canvas toolbar button and Ctrl+Enter do the same, a double-click on the selected component too', async () => {
    const e = await open();
    const el = await selectCode(e);
    const viewport = e.root.querySelector<HTMLElement>('app-canvas .viewport')!;
    buttonNamed(e, 'Edit code').click();
    await settle(e.fixture);
    expect(dialog(e)?.textContent).toContain(`edit:${el.id}`);
    await close(e);

    viewport.focus();
    const event = press(viewport, 'Enter', { ctrlKey: true });
    await settle(e.fixture);
    expect(event.defaultPrevented).toBe(true);
    expect(dialog(e)?.textContent).toContain(`edit:${el.id}`);
    await close(e);

    // Enter alone still toggles interact mode rather than opening the editor
    press(viewport, 'Enter');
    await settle(e.fixture);
    expect(dialog(e)).toBeNull();
  });

  it('a double-click opens the code only on the selected code component', async () => {
    const e = await open();
    const el = await selectCode(e);
    const viewport = e.root.querySelector<HTMLElement>('app-canvas .viewport')!;
    const rect = { left: 0, top: 0, width: 1920, height: 1080, right: 1920, bottom: 1080, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect);
    const dbl = (x: number, y: number) => viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }));
    const canvas = e.fixture.debugElement.query(By.directive(Canvas)).componentInstance as unknown as { viewport(): { zoom: number; panX: number; panY: number } };
    const at = (x: number, y: number) => dbl(canvas.viewport().panX + x * canvas.viewport().zoom, canvas.viewport().panY + y * canvas.viewport().zoom);
    at(1900, 1000); // empty space
    await settle(e.fixture);
    expect(dialog(e)).toBeNull();
    at(el.x + 10, el.y + 10);
    await settle(e.fixture);
    expect(dialog(e)?.textContent).toContain(`edit:${el.id}`);
  });

  it('does nothing for a selection that is not one code component', async () => {
    const e = await open();
    const viewport = e.root.querySelector<HTMLElement>('app-canvas .viewport')!;
    e.store.select([e.store.currentSlide().elements[0].id]); // the text element
    await settle(e.fixture);
    viewport.focus();
    press(viewport, 'Enter', { ctrlKey: true });
    await settle(e.fixture);
    expect(dialog(e)).toBeNull();
  });

  it('"Components…" opens the library', async () => {
    const e = await open();
    buttonNamed(e, 'Components').click();
    await settle(e.fixture);
    expect(dialog(e)?.textContent).toContain('library:');
  });

  it('keeps the editor shortcuts away while a tool is open, and closes it when another deck opens', async () => {
    const e = await open();
    buttonNamed(e, 'Components').click();
    await settle(e.fixture);
    const event = press(document.body, '/');
    await settle(e.fixture);
    expect(event.defaultPrevented).toBe(false);
    expect(e.root.querySelector('app-insert-menu')).toBeNull();
    e.fixture.componentRef.setInput('id', 'dk_other');
    await settle(e.fixture);
    expect(dialog(e)).toBeNull();
  });

  it('shows nothing and announces it where the app provides no tools', async () => {
    const e = await openEditor({ prepare });
    const el = await selectCode(e);
    buttonNamed(e, 'Edit code…').click();
    buttonNamed(e, 'Components').click();
    await settle(e.fixture);
    expect(document.querySelector('app-fake-tools')).toBeNull();
    expect(e.store.selection()).toEqual([el.id]);
  });
});
