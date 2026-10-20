import { TestBed } from '@angular/core/testing';
import { createDeck, createElement, type Deck } from '../model';
import { CommandError } from './command';
import { AddElement, Batch, DeleteElements, MoveElements } from './commands';
import { CLOCK, DeckStore } from './deck-store';

let now = 0;

function setup() {
  now = 0;
  TestBed.configureTestingModule({ providers: [{ provide: CLOCK, useValue: () => now }] });
  const store = TestBed.inject(DeckStore);
  const deck = createDeck();
  const a = createElement('shape', { x: 0, y: 0 });
  const b = createElement('shape', { x: 10, y: 10 });
  const [slide] = deck.slides;
  store.load({ ...deck, slides: [{ ...slide, elements: [a] }] });
  return { store, slideId: slide.id, a, b };
}

describe('DeckStore.beginGesture', () => {
  it('keeps a drag one undo step across a pause longer than the coalescing window', () => {
    const { store, a } = setup();
    const release = store.beginGesture('drag:1');
    store.execute(new MoveElements([a.id], 5, 0, { coalesceKey: 'drag:1' }));
    now += 5_000;
    store.execute(new MoveElements([a.id], 5, 0, { coalesceKey: 'drag:1' }));
    release();
    store.undo();
    expect(store.currentSlide().elements[0].x).toBe(0);
    expect(store.canUndo()).toBe(false);
  });

  it('without the hold the same pause splits the gesture (the window rule is unchanged)', () => {
    const { store, a } = setup();
    store.execute(new MoveElements([a.id], 5, 0, { coalesceKey: 'drag:1' }));
    now += 5_000;
    store.execute(new MoveElements([a.id], 5, 0, { coalesceKey: 'drag:1' }));
    store.undo();
    expect(store.currentSlide().elements[0].x).toBe(5);
  });

  it('only merges commands with the held key and stops after release', () => {
    const { store, a } = setup();
    const release = store.beginGesture('drag:1');
    store.execute(new MoveElements([a.id], 1, 0, { coalesceKey: 'drag:1' }));
    now += 5_000;
    store.execute(new MoveElements([a.id], 1, 0, { coalesceKey: 'other' }));
    now += 5_000;
    release();
    store.execute(new MoveElements([a.id], 1, 0, { coalesceKey: 'drag:1' }));
    store.undo();
    expect(store.currentSlide().elements[0].x).toBe(2);
    store.undo();
    expect(store.currentSlide().elements[0].x).toBe(1);
    store.undo();
    expect(store.currentSlide().elements[0].x).toBe(0);
  });

  it('a stale release does not end a newer hold', () => {
    const { store, a } = setup();
    const first = store.beginGesture('drag:1');
    const second = store.beginGesture('drag:2');
    first();
    store.execute(new MoveElements([a.id], 1, 0, { coalesceKey: 'drag:2' }));
    now += 5_000;
    store.execute(new MoveElements([a.id], 1, 0, { coalesceKey: 'drag:2' }));
    second();
    store.undo();
    expect(store.currentSlide().elements[0].x).toBe(0);
  });
});

describe('Batch', () => {
  const frozen = (deck: Deck): Deck => structuredClone(deck);

  it('applies the commands in order as one undo step', () => {
    const { store, slideId, a, b } = setup();
    const c = createElement('shape', { x: 99, y: 99 });
    store.execute(new Batch('Many', [new AddElement(slideId, b), new AddElement(slideId, c), new MoveElements([a.id], 1, 1)]));
    expect(store.currentSlide().elements.map((e) => e.id)).toEqual([a.id, b.id, c.id]);
    store.undo();
    expect(store.currentSlide().elements.map((e) => e.id)).toEqual([a.id]);
    expect(store.currentSlide().elements[0].x).toBe(0);
    store.redo();
    expect(store.currentSlide().elements).toHaveLength(3);
  });

  it('leaves the deck and history untouched when one command fails', () => {
    const { store, slideId, b } = setup();
    const before = store.deck();
    expect(() => store.execute(new Batch('Bad', [new AddElement(slideId, b), new DeleteElements(['nope'])]))).toThrow(CommandError);
    expect(store.deck()).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

  it('later commands see the effects of earlier ones', () => {
    const { store, slideId, b } = setup();
    store.execute(new Batch('AddThenMove', [new AddElement(slideId, b), new MoveElements([b.id], 5, 5)]));
    expect(store.currentSlide().elements[1]).toMatchObject({ x: 15, y: 15 });
  });

  it('rejects an empty batch and does not mutate its input', () => {
    const { store, slideId, b } = setup();
    expect(() => new Batch('Empty', []).do(store.deck())).toThrow('No commands given');
    const deck = frozen(store.deck());
    const copy = structuredClone(deck);
    new Batch('x', [new AddElement(slideId, b)]).do(deck);
    expect(deck).toEqual(copy);
  });

  it('a no-op batch records nothing', () => {
    const { store, a } = setup();
    store.execute(new Batch('Nothing', [new MoveElements([a.id], 0, 0)]));
    expect(store.canUndo()).toBe(false);
  });
});
