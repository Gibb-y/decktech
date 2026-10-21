import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { EditorView } from '@codemirror/view';
import axe from 'axe-core';
import { createDeck, createElement, type CodeEl, type ComponentDef, type Deck } from '../../core/model';
import { DeckRepository, InMemoryDeckRepository } from '../../core/persistence';
import { CommandError, DeckStore } from '../../core/store';
import { CODE_ELEMENT_VIEW } from '../../renderer';
import { COUNTER_COMPONENT } from '../host/examples';
import { ComponentStateStore, HostConsole, RuntimeSource } from '../host/host-services';
import { CodeEditorDialog } from './code-editor-dialog';
import { ComponentLibrary } from './component-library';

// jsdom has no layout; CodeMirror measures text with these.
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  Range.prototype.getBoundingClientRect ??= () => rect;
  Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const settle = async (fixture: ComponentFixture<unknown>) => {
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r));
  fixture.detectChanges();
};

interface Options {
  uses?: number;
  prepare?: (deck: Deck) => void;
}

async function open(options: Options = {}) {
  const repo = new InMemoryDeckRepository();
  TestBed.configureTestingModule({
    providers: [
      { provide: DeckRepository, useValue: repo },
      { provide: CODE_ELEMENT_VIEW, useValue: () => Promise.resolve(null) },
      { provide: RuntimeSource, useValue: { load: () => Promise.resolve('/*runtime*/') } },
      { provide: ComponentStateStore, useValue: { load: () => ({}), save: () => undefined } },
    ],
  });
  const store = TestBed.inject(DeckStore);
  const deck = createDeck('T');
  const def: ComponentDef = structuredClone(COUNTER_COMPONENT);
  const elements: CodeEl[] = Array.from({ length: options.uses ?? 1 }, () => createElement('code', { componentId: def.id, props: { start: 4 }, w: 1200, h: 600 }) as CodeEl);
  deck.components.push(def);
  deck.slides[0].elements.push(...elements);
  options.prepare?.(deck);
  store.load(deck);
  const fixture = TestBed.createComponent(CodeEditorDialog);
  fixture.componentRef.setInput('elementId', elements[0].id);
  const closed = vi.fn();
  fixture.componentInstance.closed.subscribe(closed);
  document.body.appendChild(fixture.nativeElement);
  await settle(fixture);
  const root = fixture.nativeElement as HTMLElement;
  return { fixture, root, store, def, element: elements[0], closed, repo };
}

type Dialog = Awaited<ReturnType<typeof open>>;

const button = (root: HTMLElement, name: string) => Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name)!;
const tab = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`#tab-${id}`)!;
const editorOf = (root: HTMLElement, panel: string) => EditorView.findFromDOM(root.querySelector<HTMLElement>(`#panel-${panel} .cm-editor`)!)!;
const replaceSource = async (d: Dialog, panel: 'html' | 'css' | 'js', text: string) => {
  const view = editorOf(d.root, panel);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  await settle(d.fixture);
};
const type = (control: HTMLInputElement, value: string) => {
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
};
const component = (d: Dialog) => d.store.deck().components.find((c) => c.id === d.def.id)!;

describe('CodeEditorDialog', () => {
  it('is a labelled modal dialog with the name focused, three code editors and a preview', async () => {
    const d = await open();
    const dialog = d.root.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(d.root.querySelector('#code-editor-title')?.textContent).toBe('Edit code: Counter');
    expect(document.activeElement).toBe(d.root.querySelector('input[type="text"]'));
    for (const [id, label] of [['html', 'HTML source'], ['css', 'CSS source'], ['js', 'JavaScript source']]) {
      expect(d.root.querySelector(`#panel-${id} .cm-content`)?.getAttribute('aria-label')).toBe(label);
    }
    expect(editorOf(d.root, 'js').state.doc.toString()).toBe(COUNTER_COMPONENT.js);
    expect(d.root.querySelector('.preview app-code-element')).not.toBeNull();
  });

  it('passes AXE', async () => {
    const d = await open();
    const results = await axe.run({ include: [d.root], exclude: [['iframe']] }, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });

  it('shows one panel at a time and moves between tabs with the arrow keys, Home and End', async () => {
    const d = await open();
    const panels = () => Array.from(d.root.querySelectorAll<HTMLElement>('[role="tabpanel"]')).filter((p) => !p.hidden).map((p) => p.id);
    expect(panels()).toEqual(['panel-html']);
    expect(tab(d.root, 'html').getAttribute('tabindex')).toBe('0');
    expect(tab(d.root, 'css').getAttribute('tabindex')).toBe('-1');
    const list = d.root.querySelector('[role="tablist"]')!;
    const key = (k: string) => list.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    key('ArrowRight');
    await settle(d.fixture);
    expect(panels()).toEqual(['panel-css']);
    expect(document.activeElement).toBe(tab(d.root, 'css'));
    key('End');
    await settle(d.fixture);
    expect(panels()).toEqual(['panel-perms']);
    key('ArrowRight'); // wraps
    await settle(d.fixture);
    expect(panels()).toEqual(['panel-html']);
    key('ArrowLeft');
    await settle(d.fixture);
    expect(panels()).toEqual(['panel-perms']);
    key('Home');
    await settle(d.fixture);
    expect(panels()).toEqual(['panel-html']);
  });

  it('Done without a change closes and records nothing', async () => {
    const d = await open();
    button(d.root, 'Done').click();
    expect(d.closed).toHaveBeenCalledOnce();
    expect(d.store.canUndo()).toBe(false);
  });

  it('Done applies sources, name, schema and permissions as one undo step', async () => {
    const d = await open();
    await replaceSource(d, 'js', 'deck.log("changed");');
    await replaceSource(d, 'html', '<p id="x">changed</p>');
    type(d.root.querySelector('input[type="text"]')!, '  Renamed ');
    await settle(d.fixture);
    button(d.root, 'Done').click();
    expect(d.closed).toHaveBeenCalledOnce();
    expect(component(d)).toMatchObject({ name: 'Renamed', js: 'deck.log("changed");', html: '<p id="x">changed</p>', css: COUNTER_COMPONENT.css });
    d.store.undo();
    expect(component(d)).toEqual(COUNTER_COMPONENT);
    expect(d.store.canUndo()).toBe(false);
  });

  it('keeps editing in the dialog until Done: the deck is untouched while typing', async () => {
    const d = await open();
    await replaceSource(d, 'css', 'body { color: red }');
    expect(component(d).css).toBe(COUNTER_COMPONENT.css);
    expect(d.store.canUndo()).toBe(false);
  });

  it('rebuilds the preview 300 ms after the last change, not on every key', async () => {
    const d = await open();
    vi.useFakeTimers();
    const preview = () => (d.fixture.componentInstance as unknown as { previewDef: () => ComponentDef }).previewDef().js;
    const view = editorOf(d.root, 'js');
    for (const text of ['a', 'ab', 'abc']) {
      vi.advanceTimersByTime(200);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      d.fixture.detectChanges();
    }
    expect(preview()).toBe(COUNTER_COMPONENT.js);
    vi.advanceTimersByTime(299);
    expect(preview()).toBe(COUNTER_COMPONENT.js);
    vi.advanceTimersByTime(2);
    expect(preview()).toBe('abc');
  });

  it('stops the preview timer when the dialog goes away', async () => {
    const d = await open();
    vi.useFakeTimers();
    const view = editorOf(d.root, 'js');
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'later' } });
    d.fixture.detectChanges();
    const preview = () => (d.fixture.componentInstance as unknown as { previewDef: () => ComponentDef }).previewDef().js;
    d.fixture.destroy();
    vi.advanceTimersByTime(1000);
    expect(preview()).toBe(COUNTER_COMPONENT.js);
  });

  describe('properties', () => {
    it('edits the schema, validates it like the deck and blocks Done while it is invalid', async () => {
      const d = await open();
      tab(d.root, 'props').click();
      await settle(d.fixture);
      button(d.root, 'Add property').click();
      await settle(d.fixture);
      const keys = () => Array.from(d.root.querySelectorAll<HTMLInputElement>('app-prop-schema-editor fieldset'), (f) => f.querySelector<HTMLInputElement>('input[type="text"]')!);
      expect(keys().map((k) => k.value)).toEqual(['start', 'label', 'prop3']);
      type(keys()[2], 'start'); // duplicate
      await settle(d.fixture);
      const alert = d.root.querySelector('ul.errors[role="alert"]')!;
      expect(alert.textContent).toContain('duplicate prop key');
      const done = button(d.root, 'Done');
      expect(done.getAttribute('aria-disabled')).toBe('true');
      done.click();
      expect(d.closed).not.toHaveBeenCalled();
      expect(component(d).propSchema).toHaveLength(2);

      type(keys()[2], 'mood');
      await settle(d.fixture);
      expect(d.root.querySelector('ul.errors')).toBeNull();
      button(d.root, 'Done').click();
      expect(component(d).propSchema.map((p) => p.key)).toEqual(['start', 'label', 'mood']);
    });

    it('rejects a number default outside its range', async () => {
      const d = await open();
      tab(d.root, 'props').click();
      await settle(d.fixture);
      const max = d.root.querySelectorAll<HTMLInputElement>('app-prop-schema-editor input[type="number"]')[2]; // Largest of "start"
      type(max, '-5');
      await settle(d.fixture);
      expect(d.root.querySelector('ul.errors')?.textContent).toMatch(/default|min/);
      expect(button(d.root, 'Done').getAttribute('aria-disabled')).toBe('true');
    });
  });

  describe('permissions', () => {
    const network = (d: Dialog) => d.root.querySelector<HTMLInputElement>('#panel-perms input[type="checkbox"]')!;

    it('shows what granting means and only keeps the permission once it is allowed', async () => {
      const d = await open();
      tab(d.root, 'perms').click();
      await settle(d.fixture);
      network(d).checked = true;
      network(d).dispatchEvent(new Event('change', { bubbles: true }));
      await settle(d.fixture);
      const consent = d.root.querySelector('[role="alertdialog"]')!;
      expect(consent.textContent).toContain('Allow Network?');
      expect(consent.textContent).toContain('stays blocked');
      expect(network(d).checked).toBe(false);
      expect(document.activeElement?.id).toBe('consent-allow'); // the question takes the focus
      button(d.root, 'Allow').click();
      await settle(d.fixture);
      expect(network(d).checked).toBe(true);
      expect(d.root.querySelector('[role="alertdialog"]')).toBeNull();
      button(d.root, 'Done').click();
      expect(component(d).permissions).toEqual(['network']);
    });

    it('Cancel leaves the permission off, and unticking removes it at once', async () => {
      const d = await open({ prepare: (deck) => void (deck.components[0].permissions = ['storage']) });
      tab(d.root, 'perms').click();
      await settle(d.fixture);
      network(d).checked = true;
      network(d).dispatchEvent(new Event('change', { bubbles: true }));
      await settle(d.fixture);
      button(d.root, 'Cancel').click(); // the consent's Cancel (first in the DOM)
      await settle(d.fixture);
      expect(network(d).checked).toBe(false);
      const storage = d.root.querySelectorAll<HTMLInputElement>('#panel-perms input[type="checkbox"]')[1];
      expect(storage.checked).toBe(true);
      storage.checked = false;
      storage.dispatchEvent(new Event('change', { bubbles: true }));
      await settle(d.fixture);
      button(d.root, 'Done').click();
      expect(component(d).permissions).toEqual([]);
    });
  });

  describe('libraries', () => {
    const pick = async (d: Dialog, file: File) => {
      tab(d.root, 'libs').click();
      await settle(d.fixture);
      const input = d.root.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
      await settle(d.fixture);
    };

    it('vendors a file into the asset store and the deck on Done, shows its import name and gives it to the preview', async () => {
      const d = await open();
      await pick(d, new File(['export const answer = 42;'], 'answers.mjs'));
      const status = d.root.querySelector('#panel-libs [role="status"]')!.textContent!;
      const id = /'([0-9a-f]{64})'/.exec(status)![1];
      expect(status).toContain('Added answers.mjs');
      expect(d.root.querySelector('#panel-libs .libs')?.textContent).toContain(id);
      expect(Object.keys(d.store.deck().assets)).not.toContain(id); // not in the deck until Done
      expect((await d.repo.getAsset(id)).ok).toBe(true);
      button(d.root, 'Done').click();
      expect(component(d).libs).toEqual([id]);
      expect(d.store.deck().assets[id]).toMatchObject({ mime: 'text/javascript', hash: id });
      d.store.undo();
      expect(d.store.deck().assets[id]).toBeUndefined();
      expect(component(d).libs).toEqual([]);
    });

    it('refuses a file that imports from the network and says why', async () => {
      const d = await open();
      await pick(d, new File(['import x from "https://cdn.example/x.js";'], 'bad.js'));
      expect(d.root.querySelector('#panel-libs [role="status"]')?.textContent).toContain('imports from elsewhere');
      expect(d.root.querySelectorAll('#panel-libs .libs li')).toHaveLength(0);
    });

    it('removes a library from the draft', async () => {
      const d = await open();
      await pick(d, new File(['export default 1;'], 'one.js'));
      button(d.root, 'Remove library one.js').click();
      await settle(d.fixture);
      button(d.root, 'Done').click();
      expect(component(d).libs).toEqual([]);
    });

    it('does not start a download for an invalid package name', async () => {
      const d = await open();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      tab(d.root, 'libs').click();
      await settle(d.fixture);
      type(d.root.querySelector<HTMLInputElement>('#panel-libs fieldset input')!, '../evil');
      button(d.root, 'Download and add').click();
      await new Promise((r) => setTimeout(r, 10));
      await settle(d.fixture);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(d.root.querySelector('#panel-libs [role="status"]')?.textContent).toContain('not a valid npm package name');
    });
  });

  describe('diagnostics', () => {
    it('lists the console entries of this component only, and clears them', async () => {
      const d = await open();
      const hostConsole = TestBed.inject(HostConsole);
      hostConsole.add(d.def.id, 'log', ['hello', { a: 1 }]);
      hostConsole.add('cp_other', 'error', ['not mine']);
      hostConsole.add(d.def.id, 'error', ['boom']);
      await settle(d.fixture);
      const log = d.root.querySelector('[role="log"]')!;
      expect(Array.from(log.querySelectorAll('.line'), (l) => l.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['log hello {"a":1}', 'error boom']);
      button(d.root, 'Clear console').click();
      await settle(d.fixture);
      expect(log.textContent).toContain('Nothing logged');
    });

    it('warns about code that loads from the network and about likely accessibility problems', async () => {
      const d = await open();
      await replaceSource(d, 'html', '<img src="https://cdn.example/a.png"><div onclick="go()">x</div>');
      const risk = d.root.querySelector('.risk')!;
      expect(risk.textContent).toContain('will not work offline');
      expect(risk.textContent).toContain('https://cdn.example/a.png');
      const hints = Array.from(d.root.querySelectorAll('.hints li'), (l) => l.textContent);
      expect(hints.join(' ')).toContain('no alt');
      expect(hints.join(' ')).toContain('<button>');
      expect(d.root.querySelectorAll('fieldset input[type="checkbox"]').length).toBeGreaterThanOrEqual(5);
    });

    it('says when a component is shared', async () => {
      const shared = await open({ uses: 3 });
      expect(shared.root.querySelector('header .note')?.textContent).toContain('used 3 times');
      TestBed.resetTestingModule();
      document.body.replaceChildren();
      const alone = await open();
      expect(alone.root.querySelector('header .note')).toBeNull();
    });
  });

  describe('leaving', () => {
    it('Cancel closes at once when nothing changed', async () => {
      const d = await open();
      button(d.root, 'Cancel').click();
      expect(d.closed).toHaveBeenCalledOnce();
    });

    it('Cancel and Escape ask before throwing changes away', async () => {
      const d = await open();
      await replaceSource(d, 'js', 'x');
      button(d.root, 'Cancel').click();
      await settle(d.fixture);
      expect(d.closed).not.toHaveBeenCalled();
      expect(d.root.querySelector('[role="alertdialog"]')?.textContent).toContain('Discard your changes');
      expect(document.activeElement?.id).toBe('discard-keep');
      button(d.root, 'Keep editing').click();
      await settle(d.fixture);
      expect(d.root.querySelector('[role="alertdialog"]')).toBeNull();
      d.root.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await settle(d.fixture);
      button(d.root, 'Discard').click();
      expect(d.closed).toHaveBeenCalledOnce();
      expect(d.store.canUndo()).toBe(false);
      expect(component(d)).toEqual(COUNTER_COMPONENT);
    });

    it('Escape closes when nothing changed, and leaves an Escape the editor already used alone', async () => {
      const d = await open();
      const dialog = d.root.querySelector('[role="dialog"]')!;
      const used = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      used.preventDefault();
      dialog.dispatchEvent(used);
      expect(d.closed).not.toHaveBeenCalled();
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(d.closed).toHaveBeenCalledOnce();
    });

    it('reports a refusal from the deck and stays open', async () => {
      const d = await open();
      await replaceSource(d, 'js', 'changed');
      vi.spyOn(d.store, 'execute').mockImplementation(() => {
        throw new CommandError('The deck said no');
      });
      button(d.root, 'Done').click();
      await settle(d.fixture);
      expect(d.root.querySelector('p.errors[role="alert"]')?.textContent).toBe('The deck said no');
      expect(d.closed).not.toHaveBeenCalled();
    });
  });

  it('saves the draft to the library', async () => {
    const d = await open();
    const save = vi.spyOn(TestBed.inject(ComponentLibrary), 'save').mockResolvedValue(true);
    await replaceSource(d, 'js', 'draft();');
    button(d.root, 'Save to library').click();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0]).toMatchObject({ id: d.def.id, js: 'draft();' });
    expect(component(d).js).toBe(COUNTER_COMPONENT.js); // the deck is not changed by saving to the library
  });

  it('does not save an invalid draft to the library', async () => {
    const d = await open();
    const save = vi.spyOn(TestBed.inject(ComponentLibrary), 'save').mockResolvedValue(true);
    type(d.root.querySelector('input[type="text"]')!, '   ');
    await settle(d.fixture);
    button(d.root, 'Save to library').click();
    expect(save).not.toHaveBeenCalled();
  });
});
