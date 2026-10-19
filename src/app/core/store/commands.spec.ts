import { TestBed } from '@angular/core/testing';
import {
  createDeck,
  createElement,
  createSlide,
  validateDeck,
  type ComponentDef,
  type Deck,
  type Element,
} from '../model';
import { CommandError, type Command } from './command';
import {
  AddCodeElement,
  AddElement,
  AddSlide,
  DeleteElements,
  DeleteSlide,
  DuplicateSlide,
  MoveElements,
  ReorderElements,
  ReorderSlides,
  ResizeElements,
  SetComponentSource,
  SetNotes,
  SetProps,
  SetText,
} from './commands';
import { DeckStore } from './deck-store';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const component: ComponentDef = {
  id: 'cp_1',
  name: 'Counter',
  html: '<b>0</b>',
  css: '',
  js: '',
  propSchema: [{ key: 'start', type: 'number', label: 'Start', default: 3 }],
  permissions: [],
  files: [],
  libs: [],
};

/** A deck with three slides; slide 1 holds three elements, slide 2 one text element, plus a component. */
function fixture() {
  const deck = createDeck('T');
  const layoutId = deck.layouts[0].id;
  const [s1] = deck.slides;
  const s2 = createSlide(layoutId);
  const s3 = createSlide(layoutId);
  const a = createElement('shape', { x: 0, y: 0 });
  const b = createElement('text', { text: 'hello', x: 100, y: 100, font: 'heading' });
  const c = createElement('shape', { x: 200, y: 200 });
  const d = createElement('text', { text: 'other' });
  const code = createElement('code', { componentId: component.id, props: { start: 3 } });
  const full: Deck = {
    ...deck,
    components: [component],
    slides: [{ ...s1, elements: [a, b, c, code] }, { ...s2, elements: [d] }, s3],
  };
  return { deck: deepFreeze(full), s1: full.slides[0], s2: full.slides[1], s3: full.slides[2], a, b, c, d, code, layoutId };
}

describe('commands: do / undo / redo', () => {
  let store: DeckStore;
  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(DeckStore);
  });

  const f = fixture();
  const newSlide = createSlide(f.layoutId);
  const newEl = createElement('shape');

  const cases: [string, () => Command, (deck: Deck) => void][] = [
    ['AddSlide', () => new AddSlide(newSlide, 1), (d) => expect(d.slides.map((s) => s.id)).toEqual([f.s1.id, newSlide.id, f.s2.id, f.s3.id])],
    ['AddSlide (append)', () => new AddSlide(newSlide), (d) => expect(d.slides[3].id).toBe(newSlide.id)],
    ['DeleteSlide', () => new DeleteSlide(f.s2.id), (d) => expect(d.slides.map((s) => s.id)).toEqual([f.s1.id, f.s3.id])],
    [
      'DuplicateSlide',
      () => new DuplicateSlide(f.s1.id, 'sl_copy'),
      (d) => {
        expect(d.slides[1].id).toBe('sl_copy');
        expect(d.slides[1].elements).toHaveLength(4);
        const ids = d.slides.flatMap((s) => s.elements.map((e) => e.id));
        expect(new Set(ids).size).toBe(ids.length);
        expect(d.slides[1].elements.map(({ id, ...rest }) => rest)).toEqual(f.s1.elements.map(({ id, ...rest }) => rest));
      },
    ],
    ['ReorderSlides', () => new ReorderSlides([f.s3.id], 0), (d) => expect(d.slides.map((s) => s.id)).toEqual([f.s3.id, f.s1.id, f.s2.id])],
    ['ReorderSlides (block)', () => new ReorderSlides([f.s1.id, f.s2.id], 1), (d) => expect(d.slides.map((s) => s.id)).toEqual([f.s3.id, f.s1.id, f.s2.id])],
    ['AddElement', () => new AddElement(f.s3.id, newEl), (d) => expect(d.slides[2].elements).toEqual([newEl])],
    ['AddElement (index)', () => new AddElement(f.s1.id, newEl, 0), (d) => expect(d.slides[0].elements[0]).toBe(newEl)],
    ['DeleteElements', () => new DeleteElements([f.a.id, f.d.id]), (d) => expect(d.slides.map((s) => s.elements.length)).toEqual([3, 0, 0])],
    ['MoveElements', () => new MoveElements([f.a.id, f.b.id], 10, -5), (d) => expect(d.slides[0].elements.slice(0, 2).map((e) => [e.x, e.y])).toEqual([[10, -5], [110, 95]])],
    ['ResizeElements', () => new ResizeElements([{ id: f.a.id, x: 5, y: 6, w: 70, h: 80 }]), (d) => expect(d.slides[0].elements[0]).toMatchObject({ x: 5, y: 6, w: 70, h: 80 })],
    ['SetProps (geometry + style)', () => new SetProps([f.b.id], { fontSize: 99, rotation: 45, hidden: true }), (d) => expect(d.slides[0].elements[1]).toMatchObject({ fontSize: 99, rotation: 45, hidden: true })],
    ['SetProps (code props)', () => new SetProps([f.code.id], { props: { start: 9 } }), (d) => expect((d.slides[0].elements[3] as { props: unknown }).props).toEqual({ start: 9 })],
    ['SetProps (remove optional)', () => new SetProps([f.b.id], { font: undefined }), (d) => expect('font' in d.slides[0].elements[1]).toBe(false)],
    ['ReorderElements front', () => new ReorderElements(f.s1.id, [f.a.id], 'front'), (d) => expect(d.slides[0].elements.map((e) => e.id)).toEqual([f.b.id, f.c.id, f.code.id, f.a.id])],
    ['ReorderElements back', () => new ReorderElements(f.s1.id, [f.code.id, f.c.id], 'back'), (d) => expect(d.slides[0].elements.map((e) => e.id)).toEqual([f.c.id, f.code.id, f.a.id, f.b.id])],
    ['ReorderElements forward', () => new ReorderElements(f.s1.id, [f.a.id, f.b.id], 'forward'), (d) => expect(d.slides[0].elements.map((e) => e.id)).toEqual([f.c.id, f.a.id, f.b.id, f.code.id])],
    ['ReorderElements backward', () => new ReorderElements(f.s1.id, [f.c.id], 'backward'), (d) => expect(d.slides[0].elements.map((e) => e.id)).toEqual([f.a.id, f.c.id, f.b.id, f.code.id])],
    ['SetText', () => new SetText(f.b.id, 'changed'), (d) => expect((d.slides[0].elements[1] as { text: string }).text).toBe('changed')],
    ['SetNotes', () => new SetNotes(f.s2.id, 'speak slowly'), (d) => expect(d.slides[1].notes).toBe('speak slowly')],
    ['SetComponentSource', () => new SetComponentSource('cp_1', { js: 'run()', html: '<i></i>' }), (d) => expect(d.components[0]).toMatchObject({ js: 'run()', html: '<i></i>', css: '' })],
    [
      'AddCodeElement (new component)',
      () => new AddCodeElement(f.s3.id, { ...component, id: 'cp_new' }),
      (d) => {
        expect(d.components.map((c) => c.id)).toEqual(['cp_1', 'cp_new']);
        expect(d.slides[2].elements[0]).toMatchObject({ type: 'code', componentId: 'cp_new', props: { start: 3 } });
      },
    ],
    [
      'AddCodeElement (existing component)',
      () => new AddCodeElement(f.s3.id, component),
      (d) => {
        expect(d.components).toHaveLength(1);
        expect(d.slides[2].elements).toHaveLength(1);
      },
    ],
  ];

  it.each(cases)('%s: do, undo restores a deep-equal deck, redo reapplies', (_, make, check) => {
    store.load(f.deck);
    store.execute(make());
    const done = store.deck();
    check(done);
    expect(validateDeck(done).ok).toBe(true);
    expect(done).not.toEqual(f.deck);

    store.undo();
    expect(store.deck()).toEqual(f.deck);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(true);

    store.redo();
    expect(store.deck()).toEqual(done);
    expect(store.canRedo()).toBe(false);
    store.undo();
    expect(store.deck()).toEqual(f.deck);
  });

  it('the original deck is never mutated (inputs are deep-frozen)', () => {
    store.load(f.deck);
    expect(() => {
      store.execute(new MoveElements([f.a.id], 1, 1));
      store.execute(new DeleteSlide(f.s2.id));
      store.undo();
      store.undo();
    }).not.toThrow();
  });

  it('identity: moving one element leaves the others and other slides referentially equal', () => {
    store.load(f.deck);
    store.execute(new MoveElements([f.b.id], 5, 5));
    const next = store.deck();
    expect(next.slides[0].elements[0]).toBe(f.a);
    expect(next.slides[0].elements[1]).not.toBe(f.b);
    expect(next.slides[0].elements[2]).toBe(f.c);
    expect(next.slides[0].elements[3]).toBe(f.code);
    expect(next.slides[1]).toBe(f.s2);
    expect(next.slides[2]).toBe(f.s3);
    expect(next.theme).toBe(f.deck.theme);
    expect(next.components).toBe(f.deck.components);
  });

  it('identity is also kept across undo for untouched parts', () => {
    store.load(f.deck);
    store.execute(new MoveElements([f.b.id], 5, 5));
    store.undo();
    expect(store.deck().slides[1]).toBe(f.s2);
    expect(store.deck().slides[0].elements[0]).toBe(f.a);
  });

  describe('failures leave the deck and history untouched', () => {
    const bad: [string, () => Command, RegExp][] = [
      ['unknown slide', () => new DeleteSlide('nope'), /Slide "nope" does not exist/],
      ['AddSlide with bad index', () => new AddSlide(createSlide(f.layoutId), 99), /out of range/],
      ['AddSlide with unknown layout', () => new AddSlide(createSlide('ly_nope')), /Layout "ly_nope" does not exist/],
      ['AddSlide with duplicate id', () => new AddSlide(f.s1), /already exists/],
      ['AddElement with duplicate id', () => new AddElement(f.s2.id, f.a), /already exists/],
      ['AddElement with bad index', () => new AddElement(f.s2.id, createElement('shape'), -1), /out of range/],
      ['Move unknown element', () => new MoveElements(['el_nope'], 1, 1), /Element "el_nope" does not exist/],
      ['Move by NaN', () => new MoveElements([f.a.id], NaN, 0), /dx must be a finite number/],
      ['Move by Infinity', () => new MoveElements([f.a.id], 0, Infinity), /dy must be a finite number/],
      ['Move without ids', () => new MoveElements([], 1, 1), /No element ids/],
      ['Resize to negative size', () => new ResizeElements([{ id: f.a.id, x: 0, y: 0, w: -1, h: 5 }]), /must not be negative/],
      ['Resize to NaN', () => new ResizeElements([{ id: f.a.id, x: 0, y: 0, w: NaN, h: 5 }]), /w must be a finite number/],
      ['SetProps changing id', () => new SetProps([f.a.id], { id: 'el_x' }), /"id" is not a settable property/],
      ['SetProps changing type', () => new SetProps([f.a.id], { type: 'text' }), /"type" is not a settable property/],
      ['SetProps with a field of another type', () => new SetProps([f.a.id], { text: 'x' }), /"text" is not a settable property of a shape/],
      ['SetProps with __proto__', () => new SetProps([f.a.id], JSON.parse('{"__proto__": {"x": 1}}')), /"__proto__" is not a settable property/],
      ['SetText on a shape', () => new SetText(f.a.id, 'x'), /not text/],
      ['ReorderElements with element of another slide', () => new ReorderElements(f.s1.id, [f.d.id], 'front'), /is not on slide/],
      ['ReorderSlides out of range', () => new ReorderSlides([f.s1.id], 7), /out of range/],
      ['SetComponentSource unknown', () => new SetComponentSource('cp_nope', { js: '' }), /Component "cp_nope" does not exist/],
      ['AddCodeElement on unknown slide', () => new AddCodeElement('sl_nope', component), /Slide "sl_nope" does not exist/],
    ];

    it.each(bad)('%s', (_, make, message) => {
      store.load(f.deck);
      const before = store.deck();
      const command = make();
      expect(() => store.execute(command)).toThrow(CommandError);
      expect(() => store.execute(command)).toThrow(message);
      expect(store.deck()).toBe(before);
      expect(store.canUndo()).toBe(false);
    });
  });

  it('refuses to delete the last slide', () => {
    store.load({ ...f.deck, slides: [f.s1] });
    expect(() => store.execute(new DeleteSlide(f.s1.id))).toThrow(/at least one slide/);
  });

  it('no-op commands do not create history entries', () => {
    store.load(f.deck);
    store.execute(new MoveElements([f.a.id], 0, 0));
    store.execute(new SetText(f.b.id, 'hello'));
    store.execute(new SetNotes(f.s1.id, ''));
    store.execute(new ReorderElements(f.s1.id, [f.code.id], 'front'));
    store.execute(new SetProps([f.b.id], { fontSize: 40 }));
    expect(store.canUndo()).toBe(false);
    expect(store.deck()).toBe(f.deck);
  });
});
