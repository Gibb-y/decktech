import { TestBed } from '@angular/core/testing';
import { createDeck, validateDeck, type AssetRef, type CodeEl, type ComponentDef, type Deck } from '../../core/model';
import { DeckRepository, InMemoryDeckRepository } from '../../core/persistence';
import { DeckStore } from '../../core/store';
import { LiveAnnouncer } from '../../shared';
import { BUILT_IN_COMPONENTS, CHART_COMPONENT } from './builtin-components';
import { ComponentLibrary, insertCommands } from './component-library';

const HASH = 'f'.repeat(64);
const REF: AssetRef = { blobKey: HASH, hash: HASH, mime: 'text/javascript', size: 3 };
const withLib: ComponentDef = { ...CHART_COMPONENT, id: 'cp_lib', name: 'With library', libs: [HASH] };

function setup(seed?: (deck: Deck) => Deck) {
  const repo = new InMemoryDeckRepository();
  TestBed.configureTestingModule({ providers: [{ provide: DeckRepository, useValue: repo }] });
  const store = TestBed.inject(DeckStore);
  store.load(seed ? seed(createDeck('T')) : createDeck('T'));
  return { repo, store, library: TestBed.inject(ComponentLibrary), announcer: TestBed.inject(LiveAnnouncer) };
}

describe('insertCommands', () => {
  const deck = createDeck('T');
  const slideId = deck.slides[0].id;

  it('adds the definition and a selected-able element in one command', () => {
    const { command, element } = insertCommands(deck, slideId, { def: CHART_COMPONENT, assets: {} });
    const next = command.do(deck).deck;
    expect(next.components).toEqual([CHART_COMPONENT]);
    expect(next.slides[0].elements.at(-1)).toBe(element);
    expect(element.props).toEqual({ title: 'Sales per quarter', data: 'Q1:12, Q2:18, Q3:9, Q4:24', color: '#2563eb' });
    expect(validateDeck(next).ok).toBe(true);
  });

  it('adds the assets the deck lacks and only those', () => {
    const next = insertCommands(deck, slideId, { def: withLib, assets: { [HASH]: REF } }).command.do(deck).deck;
    expect(next.assets[HASH]).toEqual(REF);
    expect(validateDeck(next).ok).toBe(true);
    const again = insertCommands(next, slideId, { def: { ...withLib }, assets: { [HASH]: REF } }).command.do(next).deck;
    expect(again.components).toHaveLength(1); // same definition: shared
    expect(again.slides[0].elements.filter((e) => e.type === 'code')).toHaveLength(2);
  });

  it('refuses an entry that lacks the ref of an asset the deck does not have, changing nothing', () => {
    expect(() => insertCommands(deck, slideId, { def: withLib, assets: {} })).toThrow(/lacks the asset/);
  });

  it('gives a library entry that differs from the deck definition under the same id a fresh id', () => {
    const edited = { ...CHART_COMPONENT, js: '// edited in this deck' };
    const local = { ...deck, components: [edited] };
    const { command, element } = insertCommands(local, slideId, { def: CHART_COMPONENT, assets: {} });
    const next = command.do(local).deck;
    expect(next.components).toHaveLength(2);
    expect(next.components[0]).toEqual(edited);
    expect(element.componentId).not.toBe(CHART_COMPONENT.id);
    expect(next.components[1]).toEqual({ ...CHART_COMPONENT, id: element.componentId });
  });

  it('does not share the entry object with the deck', () => {
    const next = insertCommands(deck, slideId, { def: CHART_COMPONENT, assets: {} }).command.do(deck).deck;
    expect(next.components[0]).not.toBe(CHART_COMPONENT);
    expect(next.components[0].propSchema).not.toBe(CHART_COMPONENT.propSchema);
  });
});

describe('ComponentLibrary', () => {
  it('offers the six built-in examples', () => {
    const { library } = setup();
    expect(library.builtIn).toBe(BUILT_IN_COMPONENTS);
    expect(library.builtIn.map((c) => c.name)).toHaveLength(6);
  });

  it('inserts into the current slide as one undo step, selects the element and announces it', async () => {
    const { library, store, announcer } = setup();
    expect(library.insert({ def: CHART_COMPONENT })).toBe(true);
    const element = store.currentSlide().elements.at(-1) as CodeEl;
    expect(element.componentId).toBe(CHART_COMPONENT.id);
    expect(store.selection()).toEqual([element.id]);
    await new Promise((r) => setTimeout(r, 80));
    expect(announcer.message()).toBe('Bar chart inserted');
    store.undo();
    expect(store.deck().components).toEqual([]);
    expect(store.currentSlide().elements).toEqual([]);
  });

  it('inserts the same component twice as two instances of one shared definition', () => {
    const { library, store } = setup();
    library.insert({ def: CHART_COMPONENT });
    library.insert({ def: CHART_COMPONENT });
    expect(store.deck().components).toHaveLength(1);
    expect(store.currentSlide().elements).toHaveLength(2);
  });

  it('reports a refusal instead of throwing', async () => {
    const { library, store, announcer } = setup();
    expect(library.insert({ def: withLib })).toBe(false);
    expect(library.error()).toMatch(/lacks the asset/);
    await new Promise((r) => setTimeout(r, 80));
    expect(announcer.message()).toMatch(/lacks the asset/);
    expect(store.deck().components).toEqual([]);
  });

  it('saves a component with the refs of its assets, lists it and removes it', async () => {
    const { library, repo } = setup((deck) => ({ ...deck, assets: { [HASH]: REF }, components: [withLib] }));
    expect(await library.save(withLib)).toBe(true);
    expect(library.saved().map((s) => s.def.id)).toEqual(['cp_lib']);
    expect(library.saved()[0].assets).toEqual({ [HASH]: REF });
    expect((await repo.listComponents()).ok).toBe(true);
    expect(await library.remove('cp_lib')).toBe(true);
    expect(library.saved()).toEqual([]);
  });

  it('saves with assets that are not in the deck yet when they are passed in', async () => {
    const { library } = setup();
    expect(await library.save(withLib, { [HASH]: REF })).toBe(true);
    expect(library.saved()[0].assets).toEqual({ [HASH]: REF });
  });

  it('refuses to save a component whose asset is unknown', async () => {
    const { library } = setup();
    expect(await library.save(withLib)).toBe(false);
    expect(library.error()).toMatch(/not in this deck/);
    expect(library.saved()).toEqual([]);
  });

  it('refuses an asset id that is an inherited name', async () => {
    const { library } = setup();
    expect(await library.save({ ...withLib, libs: [] , files: ['toString'] } as ComponentDef)).toBe(false);
  });

  it('a saved component can be inserted into another deck, bringing its library', async () => {
    const first = setup((deck) => ({ ...deck, assets: { [HASH]: REF }, components: [withLib] }));
    await first.library.save(withLib);
    const entry = first.library.saved()[0];

    TestBed.resetTestingModule();
    const second = setup();
    expect(second.library.insert({ def: entry.def, assets: entry.assets })).toBe(true);
    expect(second.store.deck().assets[HASH]).toEqual(REF);
    expect(second.store.deck().components[0].libs).toEqual([HASH]);
    expect(validateDeck(second.store.deck()).ok).toBe(true);
  });

  it('reports a failing repository', async () => {
    const { library, repo } = setup();
    vi.spyOn(repo, 'listComponents').mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'disk on fire' } });
    await library.refresh();
    expect(library.status()).toBe('error');
    expect(library.error()).toBe('disk on fire');
  });
});
