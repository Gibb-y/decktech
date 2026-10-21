import { TestBed } from '@angular/core/testing';
import { createDeck, createElement, validateDeck, type CodeEl, type ComponentDef, type Deck, type PropSpec } from '../model';
import { CommandError } from './command';
import { AddCodeElement, SetComponentSource } from './commands';
import { DetachComponent, SetCodeProps, SetComponentDef, componentUses } from './component-commands';
import { DeckStore } from './deck-store';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const HASH = 'a'.repeat(64);
const propSchema: PropSpec[] = [
  { key: 'title', type: 'string', label: 'Title', default: 'Hi' },
  { key: 'count', type: 'number', label: 'Count', default: 3, min: 0, max: 10 },
  { key: 'on', type: 'boolean', label: 'On', default: false },
  { key: 'tint', type: 'color', label: 'Tint', default: '#336699' },
  { key: 'pic', type: 'asset', label: 'Picture', default: '' },
  { key: 'mode', type: 'select', label: 'Mode', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
];
const def: ComponentDef = { id: 'cp_1', name: 'Chart', html: '<b></b>', css: '', js: '', propSchema, permissions: [], files: [], libs: [] };

function fixture() {
  const base = createDeck('T');
  const one = createElement('code', { componentId: def.id, props: { count: 3 } });
  const two = createElement('code', { componentId: def.id, props: {} });
  const deck: Deck = {
    ...base,
    assets: { [HASH]: { blobKey: HASH, hash: HASH, mime: 'image/png', size: 1 } },
    components: [def],
    slides: [{ ...base.slides[0], elements: [one, two] }],
  };
  return { deck: deepFreeze(deck), one, two };
}

const elementOf = (deck: Deck, id: string) => deck.slides[0].elements.find((e) => e.id === id) as CodeEl;

describe('SetCodeProps', () => {
  const { deck, one, two } = fixture();
  const run = (changes: Record<string, unknown>, id = one.id) => new SetCodeProps(id, changes).do(deck).deck;

  it('sets declared props of that element only, leaving the other element and the definition alone', () => {
    const next = run({ title: 'New', count: 7, on: true, tint: 'red', mode: 'b', pic: HASH });
    expect(elementOf(next, one.id).props).toEqual({ count: 7, title: 'New', on: true, tint: 'red', mode: 'b', pic: HASH });
    expect(elementOf(next, two.id)).toBe(two);
    expect(next.components).toBe(deck.components);
    expect(validateDeck(next).ok).toBe(true);
  });

  it('is a no-op for values that are already set', () => {
    expect(run({ count: 3 })).toBe(deck);
    expect(run({})).toBe(deck);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['unknown key', { nope: 1 }, /"nope" is not a prop/],
    ['inherited name', { toString: 'x' }, /"toString" is not a prop/],
    ['__proto__', JSON.parse('{"__proto__": 1}') as Record<string, unknown>, /"__proto__" is not a prop/],
    ['number as string', { count: '5' }, /"Count" must be a number/],
    ['NaN', { count: NaN }, /"Count" must be a number/],
    ['below min', { count: -1 }, /"Count" must be at least 0/],
    ['above max', { count: 11 }, /"Count" must be at most 10/],
    ['string as boolean', { on: 'true' }, /"On" must be true or false/],
    ['css injection as colour', { tint: 'red; background:url(x)' }, /"Tint" must be a colour/],
    ['not an option', { mode: 'c' }, /"Mode" must be one of a, b/],
    ['object as string', { title: { a: 1 } }, /"Title" must be text/],
    ['too long string', { title: 'x'.repeat(10_001) }, /"Title" must be text of at most 10000/],
    ['asset not in deck', { pic: 'b'.repeat(64) }, /asset that is not in the deck/],
    ['bad asset id', { pic: '../x' }, /"Picture" must be an asset id/],
  ])('rejects %s and changes nothing', (_name, changes, message) => {
    expect(() => run(changes)).toThrow(CommandError);
    expect(() => run(changes)).toThrow(message);
  });

  it('is atomic: a bad value after a good one changes nothing', () => {
    expect(() => run({ title: 'ok', count: 99 })).toThrow(CommandError);
    expect(elementOf(deck, one.id).props).toEqual({ count: 3 });
  });

  it('rejects non-code and unknown elements', () => {
    const text = createElement('text');
    const withText = { ...deck, slides: [{ ...deck.slides[0], elements: [text] }] };
    expect(() => new SetCodeProps(text.id, {}).do(withText)).toThrow(/not a code component/);
    expect(() => new SetCodeProps('el_nope', {}).do(deck)).toThrow(/does not exist/);
  });

  it('reports a dangling component', () => {
    expect(() => new SetCodeProps(one.id, { count: 1 }).do({ ...deck, components: [] })).toThrow(/Component "cp_1" does not exist/);
  });

  it('coalesces by key', () => {
    expect(new SetCodeProps(one.id, {}, { coalesceKey: 'k' }).coalesceKey).toBe('k');
  });
});

describe('SetComponentDef', () => {
  const { deck } = fixture();
  const run = (settings: ConstructorParameters<typeof SetComponentDef>[1]) => new SetComponentDef('cp_1', settings).do(deck).deck;

  it('changes the settings, keeping the sources and the identity of everything else', () => {
    const next = run({ name: '  Bar chart ', permissions: ['network', 'network'], propSchema: [], libs: [HASH] });
    expect(next.components[0]).toMatchObject({ name: 'Bar chart', permissions: ['network'], propSchema: [], libs: [HASH], html: '<b></b>' });
    expect(next.slides).toBe(deck.slides);
    expect(validateDeck(next).ok).toBe(true);
  });

  it('is a no-op for equal settings', () => {
    expect(run({ name: 'Chart', propSchema: structuredClone(propSchema) })).toBe(deck);
  });

  it('stores a copy of the prop schema', () => {
    const schema: PropSpec[] = [{ key: 'a', type: 'string', label: 'A', default: '' }];
    const next = run({ propSchema: schema });
    expect(next.components[0].propSchema).not.toBe(schema);
  });

  it.each<[string, Parameters<typeof run>[0], RegExp]>([
    ['empty name', { name: '   ' }, /name must be 1 to 200/],
    ['long name', { name: 'x'.repeat(201) }, /name must be 1 to 200/],
    ['duplicate prop keys', { propSchema: [propSchema[0], propSchema[0]] }, /duplicate prop key/],
    ['hostile prop key', { propSchema: [{ key: '__proto__', type: 'string', label: 'x', default: '' }] }, /not allowed|hostile|__proto__/],
    ['default outside the range', { propSchema: [{ key: 'n', type: 'number', label: 'N', default: 5, max: 1 }] }, /default/],
    ['select default not an option', { propSchema: [{ key: 's', type: 'select', label: 'S', default: 'z', options: [{ value: 'a', label: 'A' }] }] }, /one of the option values/],
    ['unknown permission', { permissions: ['camera' as never] }, /permissions\[0\]/],
    ['unknown library asset', { libs: ['c'.repeat(64)] }, /references unknown asset/],
    ['unknown file asset', { files: ['c'.repeat(64)] }, /references unknown asset/],
  ])('rejects %s', (_name, settings, message) => {
    expect(() => run(settings)).toThrow(CommandError);
    expect(() => run(settings)).toThrow(message);
  });

  it('rejects an unknown component', () => {
    expect(() => new SetComponentDef('cp_nope', {}).do(deck)).toThrow(/does not exist/);
  });
});

describe('SetComponentSource limits', () => {
  it('refuses a source the saved deck could not load again', () => {
    const { deck } = fixture();
    expect(() => new SetComponentSource('cp_1', { js: 'x'.repeat(1_000_001) }).do(deck)).toThrow(/Invalid component/);
    expect(new SetComponentSource('cp_1', { js: 'x'.repeat(1_000) }).do(deck).deck.components[0].js).toHaveLength(1_000);
  });
});

describe('AddCodeElement with a library definition', () => {
  it('refuses a definition whose assets the deck lacks', () => {
    const { deck } = fixture();
    const entry: ComponentDef = { ...def, id: 'cp_lib', libs: ['d'.repeat(64)] };
    expect(() => new AddCodeElement(deck.slides[0].id, entry).do(deck)).toThrow(/references unknown asset/);
  });
});

describe('DetachComponent', () => {
  const { deck, one, two } = fixture();

  it('gives the element its own copy and leaves the other instance on the original', () => {
    const command = new DetachComponent(one.id);
    const next = command.do(deck).deck;
    expect(next.components).toHaveLength(2);
    const copy = next.components.find((c) => c.id === command.newId)!;
    expect(copy).toEqual({ ...def, id: command.newId, name: 'Chart (copy)' });
    expect(copy.propSchema).not.toBe(def.propSchema);
    expect(elementOf(next, one.id).componentId).toBe(command.newId);
    expect(elementOf(next, one.id).props).toEqual(one.props);
    expect(elementOf(next, two.id)).toBe(two);
    expect(validateDeck(next).ok).toBe(true);
    expect(componentUses(next, def.id)).toBe(1);
  });

  it('makes the two definitions independent', () => {
    const command = new DetachComponent(one.id);
    const detached = command.do(deck).deck;
    const edited = new SetComponentSource(command.newId, { js: 'changed()' }).do(detached).deck;
    expect(edited.components.find((c) => c.id === def.id)!.js).toBe('');
    expect(edited.components.find((c) => c.id === command.newId)!.js).toBe('changed()');
  });

  it('refuses an element that is the only user', () => {
    const alone = { ...deck, slides: [{ ...deck.slides[0], elements: [one] }] };
    expect(() => new DetachComponent(one.id).do(alone)).toThrow(/already independent/);
  });

  it('refuses unknown and non-code elements', () => {
    const text = createElement('text');
    const withText = { ...deck, slides: [{ ...deck.slides[0], elements: [text, one, two] }] };
    expect(() => new DetachComponent(text.id).do(withText)).toThrow(/not a code component/);
    expect(() => new DetachComponent('el_nope').do(deck)).toThrow(/does not exist/);
  });

  it('counts uses across slides', () => {
    const base = createDeck('x');
    const second = { ...base.slides[0], id: 'sl_two', elements: [createElement('code', { componentId: def.id })] };
    expect(componentUses({ ...deck, slides: [...deck.slides, second] }, def.id)).toBe(3);
  });
});

describe('component commands through the store', () => {
  it('undo and redo replay the detach (same new id) and the edits', () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(DeckStore);
    const { deck, one } = fixture();
    store.load(structuredClone(deck));
    const command = new DetachComponent(one.id);
    store.execute(command);
    store.execute(new SetComponentDef(command.newId, { name: 'Mine' }));
    const after = store.deck();
    store.undo();
    store.undo();
    expect(store.deck().components).toHaveLength(1);
    store.redo();
    store.redo();
    expect(store.deck()).toEqual(after);
  });
});
