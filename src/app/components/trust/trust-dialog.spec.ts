import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { EditorView } from '@codemirror/view';
import axe from 'axe-core';
import { createDeck, createElement, createSlide, type CodeEl, type ComponentDef, type Deck } from '../../core/model';
import { DeckRepository, InMemoryDeckRepository, pendingRecord, snapshotOf, type TrustRecord } from '../../core/persistence';
import { DeckStore } from '../../core/store';
import { CODE_ELEMENT_VIEW, FrameRegistry, SlideRenderer } from '../../renderer';
import { CodeElementRenderer } from '../host/code-element-renderer';
import { ComponentStateStore, RuntimeSource } from '../host/host-services';
import { TrustDialog } from './trust-dialog';
import { TrustStore } from './trust-store';

// jsdom has no layout; CodeMirror measures text with these.
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  Range.prototype.getBoundingClientRect ??= () => rect;
  Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
});

afterEach(() => document.body.replaceChildren());

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const settle = async (fixture: ComponentFixture<unknown>) => {
  for (let i = 0; i < 4; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await tick();
  }
};

const LIB = 'c'.repeat(64);

const CHART: ComponentDef = {
  id: 'cmp_chart',
  name: 'Chart',
  html: '<canvas id="c"></canvas>',
  css: '#c { width: 100% }',
  js: 'import * as lib from "' + LIB + '";\nfetch("https://api.example.com/data");\ndeck.ready(() => {});',
  propSchema: [],
  permissions: ['network'],
  files: [],
  libs: [LIB],
};
const CLOCK: ComponentDef = { id: 'cmp_clock', name: 'Clock', html: '<p id="t"></p>', css: '', js: 'setInterval(() => {}, 1000)', propSchema: [], permissions: [], files: [], libs: [] };

interface Options {
  record?: (deck: Deck) => TrustRecord | null;
  lib?: boolean;
  /** A deck the user trusted before used the same library file. */
  known?: boolean;
}

async function open(options: Options = {}) {
  const repo = new InMemoryDeckRepository();
  const deck = createDeck('Their talk');
  deck.components.push(structuredClone(CHART), structuredClone(CLOCK));
  deck.assets[LIB] = { blobKey: LIB, hash: LIB, mime: 'text/javascript', size: 22 };
  deck.slides = [createSlide('l'), createSlide('l'), createSlide('l')];
  deck.slides[1].elements.push(createElement('code', { componentId: CHART.id }) as CodeEl);
  deck.slides[2].elements.push(createElement('code', { componentId: CHART.id }) as CodeEl, createElement('code', { componentId: CLOCK.id }) as CodeEl);
  const record = options.record ? options.record(deck) : pendingRecord(deck.id, deck.id, 'h', null);
  if (record) await repo.putTrust(record);
  if (options.lib !== false) {
    const put = await repo.putAsset(new Blob(['export const answer = 42;\n'], { type: 'text/javascript' }));
    if (!put.ok) throw new Error('asset');
    // the deck lists the library under the digest of what was stored
    delete deck.assets[LIB];
    const id = put.value.ref.hash;
    deck.assets[id] = put.value.ref;
    deck.components[0].libs = [id];
    if (options.known) await repo.putTrust({ ...pendingRecord('dk_old', 'dk_old', 'h', null), status: 'decided', decidedAt: 1, snapshots: [{ ...snapshotOf(deck.components[0]) }] });
  }
  TestBed.configureTestingModule({
    providers: [
      { provide: DeckRepository, useValue: repo },
      { provide: CODE_ELEMENT_VIEW, useValue: () => Promise.resolve(CodeElementRenderer) },
      { provide: RuntimeSource, useValue: { load: () => Promise.resolve('/*runtime*/') } },
      { provide: ComponentStateStore, useValue: { load: () => ({}), save: () => undefined } },
    ],
  });
  const store = TestBed.inject(DeckStore);
  store.load(deck);
  const trust = TestBed.inject(TrustStore);
  await trust.refresh(deck.id);

  // The slides are on the page too, so any frame the dialog or the inspector made would show up.
  const slides = TestBed.createComponent(SlideRenderer);
  slides.componentRef.setInput('slide', deck.slides[2]);
  slides.componentRef.setInput('theme', deck.theme);
  slides.componentRef.setInput('mode', 'edit');
  slides.componentRef.setInput('deckId', deck.id);
  slides.componentRef.setInput('components', deck.components);

  // TestBed removes the root element of an earlier component when it creates another, so both exist before either is put on the page.
  const fixture = TestBed.createComponent(TrustDialog);
  const closed = vi.fn();
  fixture.componentInstance.closed.subscribe(closed);
  document.body.append(slides.nativeElement, fixture.nativeElement);
  await settle(slides);
  await settle(fixture);
  const root = fixture.nativeElement as HTMLElement;
  // the slide is on the page and shows its code elements as switched off, so a frame could appear next to them
  if (record?.status !== 'decided') expect(document.body.textContent).toContain('Code switched off');
  return { fixture, slides, root, store, trust, repo, deck, closed };
}

type Dialog = Awaited<ReturnType<typeof open>>;

const button = (root: HTMLElement, name: string | RegExp) =>
  Array.from(root.querySelectorAll('button')).find((b) => (typeof name === 'string' ? b.textContent?.trim() === name : name.test(b.textContent?.trim() ?? '')))!;
const click = async (d: Dialog, el: HTMLElement) => {
  el.click();
  await settle(d.fixture);
};
const framesOnPage = () => document.querySelectorAll('iframe').length;
const editorText = (root: HTMLElement) => EditorView.findFromDOM(root.querySelector<HTMLElement>('.cm-editor')!)!.state.doc.toString();
const tabs = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('[role="tab"]')).map((t) => t.textContent!.trim());

describe('TrustDialog', () => {
  describe('what it shows', () => {
    it('lists each component with its slides, permissions, libraries and the things worth a look', async () => {
      const d = await open();
      const text = d.root.textContent!.replace(/\s+/g, ' ');
      expect(d.root.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
      expect(d.root.querySelector('h2')?.textContent).toContain('Their talk');
      const items = Array.from(d.root.querySelectorAll('.component'));
      expect(items).toHaveLength(2);
      expect(items[0].textContent).toContain('Chart');
      expect(items[0].textContent!.replace(/\s+/g, ' ')).toContain('slides 2, 3');
      expect(items[0].textContent).toContain('network');
      expect(items[0].textContent).toContain('1 (0 known)');
      expect(items[0].textContent).toContain('Asks for the network permission');
      expect(items[0].textContent).toContain('Mentions web addresses: https://api.example.com/data');
      expect(items[0].textContent).toContain('Uses a network API');
      expect(items[1].textContent!.replace(/\s+/g, ' ')).toContain('slide 3');
      expect(items[1].textContent).toContain('no permissions');
      expect(text).toContain('hints from a quick search of the text, not a verdict');
    });

    it('starts with nothing ticked for a deck nobody has decided on', async () => {
      const d = await open();
      expect(Array.from(d.root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).map((c) => c.checked)).toEqual([false, false]);
      expect(button(d.root, /^Run selected/).getAttribute('aria-disabled')).toBe('true');
    });
  });

  describe('no frame is created', () => {
    it('in any state of the dialog or the inspector', async () => {
      const d = await open();
      const check = () => {
        expect(framesOnPage()).toBe(0);
        expect(TestBed.inject(FrameRegistry).count()).toBe(0);
      };
      check();
      await click(d, button(d.root, /^Read code/));
      check();
      for (const name of ['HTML', 'CSS', 'JS', 'Props', 'Libraries', 'Files']) {
        await click(d, button(d.root, name));
        check();
      }
      await click(d, button(d.root, 'JS'));
      await click(d, button(d.root, 'Format'));
      check();
      await click(d, button(d.root, 'Search'));
      check();
      await click(d, button(d.root, 'Libraries'));
      await click(d, button(d.root, /^Show source/));
      check();
      await click(d, button(d.root, 'Back to the list'));
      check();
      (d.root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]).click();
      await settle(d.fixture);
      check();
    });

    it('while the choice is stored and after a failed one', async () => {
      const d = await open();
      vi.spyOn(d.repo, 'putTrust').mockResolvedValueOnce({ ok: false, error: { kind: 'quota', message: 'full' } });
      await click(d, button(d.root, 'Trust whole deck'));
      expect(framesOnPage()).toBe(0);
      expect(d.closed).not.toHaveBeenCalled();
      expect(d.root.querySelector('[role="alert"]')?.textContent).toBe('Could not save your decision: full');
      expect(d.trust.record(d.deck.id)?.status).toBe('pending');
    });

    it('also not when the sources hold markup that would be a frame if it were rendered', async () => {
      const d = await open({ lib: false });
      const evil = { ...d.deck.components[0], name: '<iframe src="javascript:alert(1)"></iframe>', html: '<iframe srcdoc="<script>alert(1)</script>"></iframe><img src=x onerror=alert(1)>' };
      d.store.load({ ...d.deck, components: [evil, d.deck.components[1]] });
      await settle(d.fixture);
      await click(d, button(d.root, /^Read code/));
      expect(framesOnPage()).toBe(0);
      expect(d.root.querySelector('img')).toBeNull();
      expect(d.root.querySelector('h2')?.textContent).toContain('<iframe');
      expect(editorText(d.root)).toContain('<iframe srcdoc');
    });
  });

  describe('reading the code', () => {
    it('reaches the source of every component in two clicks from the dialog', async () => {
      const d = await open();
      for (const [index, def] of d.deck.components.entries()) {
        await click(d, d.root.querySelectorAll<HTMLElement>('.component button')[index]); // click 1: Read code
        expect(editorText(d.root)).toBe(def.html); // opens on the HTML
        await click(d, button(d.root, 'JS')); // click 2
        expect(editorText(d.root)).toBe(def.js);
        await click(d, button(d.root, 'Back to the list'));
      }
    });

    it('shows the sources read-only: the text box refuses typing', async () => {
      const d = await open();
      await click(d, button(d.root, /^Read code/));
      const view = EditorView.findFromDOM(d.root.querySelector<HTMLElement>('.cm-editor')!)!;
      expect(view.state.readOnly).toBe(true);
      expect(view.contentDOM.getAttribute('aria-label')).toBe('HTML source, read only');
    });

    it('names the source type of the tab that is shown, not of the first one', async () => {
      const d = await open();
      await click(d, button(d.root, /^Read code/));
      for (const [tab, label] of [['CSS', 'CSS source, read only'], ['JS', 'JS source, read only']]) {
        await click(d, button(d.root, tab));
        expect(d.root.querySelector('.cm-content')?.getAttribute('aria-label')).toBe(label);
      }
    });

    it('shows the property schema as formatted text', async () => {
      const d = await open();
      await click(d, button(d.root, /^Read code/));
      await click(d, button(d.root, 'Props'));
      expect(editorText(d.root)).toBe('[]');
    });

    it('offers a formatted copy of minified code, view only, and the source again', async () => {
      const d = await open({ lib: false });
      const minified = { ...d.deck.components[1], js: 'function a(){if(x){y()}}a();b();' };
      d.store.load({ ...d.deck, components: [d.deck.components[0], minified] });
      await settle(d.fixture);
      await click(d, d.root.querySelectorAll<HTMLElement>('.component button')[1]);
      await click(d, button(d.root, 'JS'));
      expect(editorText(d.root)).toBe(minified.js);
      await click(d, button(d.root, 'Format'));
      expect(editorText(d.root)).toBe('function a(){\n  if(x){\n    y()\n  }\n}\na();\nb();\n');
      expect(button(d.root, 'Format').getAttribute('aria-pressed')).toBe('true');
      expect(d.deck.components[1].js).toBe(CLOCK.js); // the deck is not touched
      await click(d, button(d.root, 'Format'));
      expect(editorText(d.root)).toBe(minified.js);
      expect(d.store.deck().components[1].js).toBe(minified.js);
    });

    it('lists libraries with their digest and marks one the user trusted before as known', async () => {
      const d = await open({ known: true });
      await click(d, button(d.root, /^Read code/));
      await click(d, button(d.root, 'Libraries'));
      expect(d.root.querySelector('.assets')?.textContent).toContain(d.deck.components[0].libs[0]);
      expect(d.root.querySelector('.known')?.textContent).toBe('Known library');
      expect(d.root.querySelector('.unknown')).toBeNull();
    });

    it('marks a library it has not seen before, and shows its text on request', async () => {
      const d = await open();
      await click(d, button(d.root, /^Read code/));
      await click(d, button(d.root, 'Libraries'));
      expect(d.root.querySelector('.unknown')?.textContent).toBe('Not a known library');
      await click(d, button(d.root, /^Show source/));
      expect(editorText(d.root)).toBe('export const answer = 42;\n');
      await click(d, button(d.root, /^Hide source/));
      expect(d.root.querySelector('.cm-editor')).toBeNull();
    });

    it('says so when a file is not text', async () => {
      const d = await open();
      const png = 'd'.repeat(64);
      d.store.load({ ...d.deck, assets: { ...d.deck.assets, [png]: { blobKey: png, hash: png, mime: 'image/png', size: 9 } }, components: [{ ...d.deck.components[0], files: [png] }, d.deck.components[1]] });
      await settle(d.fixture);
      await click(d, button(d.root, /^Read code/));
      await click(d, button(d.root, 'Files'));
      await click(d, button(d.root, /^Show content/));
      expect(d.root.querySelector('[role="status"]')?.textContent).toContain('not text');
    });
  });

  describe('deciding', () => {
    it('"Run selected components" lets only the ticked ones run', async () => {
      const d = await open();
      d.root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click();
      await settle(d.fixture);
      expect(button(d.root, /^Run selected/).textContent).toContain('(1)');
      await click(d, button(d.root, /^Run selected/));
      expect(d.closed).toHaveBeenCalledTimes(1);
      const record = d.trust.record(d.deck.id)!;
      expect(record.status).toBe('decided');
      expect(record.decisions.map((x) => [x.componentId, x.run])).toEqual([['cmp_chart', false], ['cmp_clock', true]]);
      expect(d.trust.mayRun(d.deck.id, d.deck.components[1])).toBe(true);
      expect(d.trust.mayRun(d.deck.id, d.deck.components[0])).toBe(false);
      const stored = await d.repo.getTrust(d.deck.id);
      expect(stored.ok && stored.value?.snapshots.map((s) => s.componentId)).toEqual(['cmp_clock']);
    });

    it('does nothing when nothing is ticked', async () => {
      const d = await open();
      await click(d, button(d.root, /^Run selected/));
      expect(d.closed).not.toHaveBeenCalled();
      expect(d.trust.record(d.deck.id)?.status).toBe('pending');
    });

    it('"Trust whole deck" runs every component', async () => {
      const d = await open();
      await click(d, button(d.root, 'Trust whole deck'));
      expect(d.closed).toHaveBeenCalledTimes(1);
      expect(d.deck.components.every((def) => d.trust.mayRun(d.deck.id, def))).toBe(true);
      await settle(d.slides);
      expect(framesOnPage()).toBe(2); // the slide on the page holds a Chart and a Clock
    });

    it('"Open with code disabled" records the decision, so the dialog does not return, and runs nothing', async () => {
      const d = await open();
      await click(d, button(d.root, 'Open with code disabled'));
      expect(d.closed).toHaveBeenCalledTimes(1);
      expect(d.trust.record(d.deck.id)).toMatchObject({ status: 'decided' });
      expect(d.deck.components.some((def) => d.trust.mayRun(d.deck.id, def))).toBe(false);
      expect(d.trust.needsReview(d.deck.id, d.deck.components)).toBe(false);
      await settle(d.slides);
      expect(framesOnPage()).toBe(0);
    });

    it('"Cancel" changes nothing: the deck stays pending and nothing runs', async () => {
      const d = await open();
      await click(d, button(d.root, 'Cancel'));
      expect(d.closed).toHaveBeenCalledTimes(1);
      expect(d.trust.record(d.deck.id)?.status).toBe('pending');
      expect(d.trust.needsReview(d.deck.id, d.deck.components)).toBe(true);
      expect(framesOnPage()).toBe(0);
    });

    it('ignores a second click while the first is being stored', async () => {
      const d = await open();
      const put = vi.spyOn(d.repo, 'putTrust');
      button(d.root, 'Trust whole deck').click();
      button(d.root, 'Open with code disabled').click();
      await settle(d.fixture);
      expect(put).toHaveBeenCalledTimes(1);
      expect(d.trust.record(d.deck.id)?.decisions.every((x) => x.run)).toBe(true);
    });
  });

  describe('a deck imported again with changes', () => {
    const earlier = (deck: Deck): TrustRecord => ({
      ...pendingRecord(deck.id, 'dk_src', 'h', [
        { ...snapshotOf(CHART), js: CHART.js.replace('api.example.com', 'old.example.com') },
        // CLOCK is not in the earlier version: it is new
      ]),
    });

    it('marks what changed and what is new against the version the user trusted', async () => {
      const d = await open({ record: earlier, lib: false });
      const badges = Array.from(d.root.querySelectorAll('.badge')).map((b) => b.textContent);
      expect(badges).toEqual(['Changed since you trusted it', 'New']);
      expect(d.root.querySelector('#trust-intro')?.textContent).toContain('differ from the version you trusted before');
      expect(d.trust.needsReview(d.deck.id, d.deck.components)).toBe(true);
    });

    it('opens the inspector on the changes, with the removed and added lines', async () => {
      const d = await open({ record: earlier, lib: false });
      await click(d, d.root.querySelectorAll<HTMLElement>('.component button')[0]);
      expect(tabs(d.root)).toEqual(['Changes', 'HTML', 'CSS', 'JS', 'Props', 'Libraries', 'Files']);
      expect(d.root.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe('Changes');
      expect(d.root.querySelector('h3')?.textContent).toBe('JavaScript');
      const removed = Array.from(d.root.querySelectorAll('.line.del')).map((l) => l.textContent!.replace(/\s+/g, ' ').trim());
      const added = Array.from(d.root.querySelectorAll('.line.add')).map((l) => l.textContent!.replace(/\s+/g, ' ').trim());
      expect(removed.join()).toContain('old.example.com');
      expect(added.join()).toContain('api.example.com');
      expect(removed[0]).toContain('Removed:');
      expect(added[0]).toContain('Added:');
      expect(framesOnPage()).toBe(0);
    });

    it('has nothing to compare a component that is new with: it opens on the HTML, which is all new', async () => {
      const d = await open({ record: earlier, lib: false });
      await click(d, d.root.querySelectorAll<HTMLElement>('.component button')[1]);
      expect(tabs(d.root)).toEqual(['HTML', 'CSS', 'JS', 'Props', 'Libraries', 'Files']);
      expect(editorText(d.root)).toBe(CLOCK.html);
    });

    it('has no Changes tab when there is no earlier version, and opens on the HTML', async () => {
      const d = await open();
      await click(d, button(d.root, /^Read code/));
      expect(tabs(d.root)).toEqual(['HTML', 'CSS', 'JS', 'Props', 'Libraries', 'Files']);
    });

    it('says nothing changed for a component identical to the trusted version', async () => {
      const d = await open({
        lib: false,
        record: (deck) => pendingRecord(deck.id, 'dk_src', 'h', [snapshotOf(deck.components[0]), snapshotOf(deck.components[1])]),
      });
      expect(Array.from(d.root.querySelectorAll('.badge')).map((b) => b.textContent)).toEqual(['Unchanged since you trusted it', 'Unchanged since you trusted it']);
      await click(d, button(d.root, /^Read code/));
      expect(d.root.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe('HTML');
      await click(d, button(d.root, 'Changes'));
      expect(d.root.querySelector('.panel')?.textContent).toContain('Nothing changed');
    });

    it('compares a decided deck whose code changed with what the user trusted', async () => {
      const d = await open({
        lib: false,
        record: (deck) => ({ ...pendingRecord(deck.id, deck.id, 'h', null), status: 'decided', decidedAt: 3, snapshots: [{ ...snapshotOf(CLOCK), js: 'older' }], decisions: [] }),
      });
      expect(d.root.querySelector('#trust-intro')?.textContent).toContain('has changed since you decided');
      expect(Array.from(d.root.querySelectorAll('.badge')).map((b) => b.textContent)).toEqual(['New', 'Changed since you trusted it']);
    });
  });

  describe('keyboard and accessibility', () => {
    it('passes AXE in the list', async () => {
      const d = await open();
      const results = await axe.run({ include: [d.root], exclude: [['iframe']] }, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
      expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    });

    it.each(['HTML', 'JS', 'Libraries', 'Files'])('passes AXE in the inspector, %s tab', async (name) => {
      const d = await open();
      await click(d, button(d.root, /^Read code/));
      await click(d, button(d.root, name));
      const results = await axe.run({ include: [d.root], exclude: [['iframe']] }, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
      expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    });

    it('passes AXE on the changes tab', async () => {
      const d = await open({ lib: false, record: (deck) => pendingRecord(deck.id, 'dk_src', 'h', [{ ...snapshotOf(CHART), js: 'old' }]) });
      await click(d, d.root.querySelectorAll<HTMLElement>('.component button')[0]);
      const results = await axe.run({ include: [d.root], exclude: [['iframe']] }, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
      expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    });

    it('moves focus into the dialog, names the Read buttons by component, and labels every control', async () => {
      const d = await open();
      expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
      expect(document.activeElement?.tagName).toBe('INPUT');
      const names = Array.from(d.root.querySelectorAll('.component button')).map((b) => b.textContent!.replace(/\s+/g, ' ').trim());
      expect(names).toEqual(['Read code of Chart', 'Read code of Clock']);
    });

    it('keeps Tab inside the dialog', async () => {
      const d = await open();
      const dialog = d.root.querySelector<HTMLElement>('[role="dialog"]')!;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button, input')).filter((el) => el.getAttribute('aria-hidden') !== 'true');
      focusable[focusable.length - 1].focus();
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      focusable[focusable.length - 1].dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(focusable[0]);
    });

    it('Escape goes back from the inspector to the list, focusing the button that opened it, and then closes', async () => {
      const d = await open();
      await click(d, d.root.querySelectorAll<HTMLElement>('.component button')[1]);
      expect(d.root.querySelector('app-code-inspector')).not.toBeNull();
      d.root.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await settle(d.fixture);
      expect(d.root.querySelector('app-code-inspector')).toBeNull();
      expect(d.closed).not.toHaveBeenCalled();
      expect(document.activeElement?.id).toBe('read-cmp_clock');
      d.root.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(d.closed).toHaveBeenCalledTimes(1);
    });

    it('leaves an Escape that the viewer already used alone', async () => {
      const d = await open();
      await click(d, button(d.root, /^Read code/));
      const used = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      used.preventDefault();
      d.root.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(used);
      await settle(d.fixture);
      expect(d.root.querySelector('app-code-inspector')).not.toBeNull();
    });

    it('moves between the inspector tabs with the arrow keys, Home and End, with one tab stop', async () => {
      const d = await open();
      await click(d, button(d.root, /^Read code/));
      const selected = () => d.root.querySelector('[role="tab"][aria-selected="true"]')!.textContent!.trim();
      const press = async (key: string) => {
        d.root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        await settle(d.fixture);
      };
      expect(selected()).toBe('HTML');
      expect(d.root.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
      await press('ArrowRight');
      expect(selected()).toBe('CSS');
      await press('End');
      expect(selected()).toBe('Files');
      await press('ArrowRight');
      expect(selected()).toBe('HTML');
      await press('ArrowLeft');
      expect(selected()).toBe('Files');
      await press('Home');
      expect(selected()).toBe('HTML');
      expect(d.root.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe('inspect-tab-html');
    });
  });
});

