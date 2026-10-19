import { TestBed } from '@angular/core/testing';
import { createDeck, createElement, createSlide, type Deck } from '../model';
import type { Command } from './command';
import { AddElement, AddSlide, DeleteSlide, MoveElements, SetNotes } from './commands';
import { CLOCK, DeckStore, HISTORY_OPTIONS } from './deck-store';
import { PatchError } from './patch';
import { History, type HistoryOptions } from './history';

function setup(options: HistoryOptions = {}) {
  const now = { value: 1_000 };
  TestBed.configureTestingModule({
    providers: [
      { provide: CLOCK, useValue: () => now.value },
      { provide: HISTORY_OPTIONS, useValue: options },
    ],
  });
  return { store: TestBed.inject(DeckStore), now };
}

function deckWithElement() {
  const deck = createDeck();
  const el = createElement('shape', { x: 0, y: 0 });
  const full: Deck = { ...deck, slides: [{ ...deck.slides[0], elements: [el] }] };
  return { deck: full, el };
}

function undoAll(store: DeckStore): number {
  let steps = 0;
  while (store.canUndo()) {
    store.undo();
    steps++;
  }
  return steps;
}

describe('DeckStore', () => {
  it('starts with a valid empty deck and a current slide', () => {
    const { store } = setup();
    expect(store.deck().slides).toHaveLength(1);
    expect(store.currentSlide()).toBe(store.deck().slides[0]);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
  });

  it('exposes a read-only deck signal', () => {
    const { store } = setup();
    expect((store.deck as unknown as { set?: unknown }).set).toBeUndefined();
  });

  it('load replaces the document and resets history and selection', () => {
    const { store } = setup();
    store.execute(new SetNotes(store.currentSlide().id, 'x'));
    const { deck, el } = deckWithElement();
    store.load(deck);
    store.select([el.id]);
    store.load(deck);
    expect(store.deck()).toBe(deck);
    expect(store.canUndo()).toBe(false);
    expect(store.selection()).toEqual([]);
    expect(() => store.load({ ...deck, slides: [] })).toThrow(/at least one slide/);
  });

  describe('current slide and selection', () => {
    it('selectSlide changes the current slide and clears the selection; unknown ids are ignored', () => {
      const { store } = setup();
      const { deck, el } = deckWithElement();
      const second = createSlide(deck.layouts[0].id);
      store.load({ ...deck, slides: [...deck.slides, second] });
      store.select([el.id]);
      expect(store.selection()).toEqual([el.id]);
      store.selectSlide(second.id);
      expect(store.currentSlide().id).toBe(second.id);
      expect(store.selection()).toEqual([]);
      store.selectSlide('sl_nope');
      expect(store.currentSlide().id).toBe(second.id);
    });

    it('only reports selected ids that exist on the current slide', () => {
      const { store } = setup();
      const { deck, el } = deckWithElement();
      store.load(deck);
      store.select(['el_ghost', el.id]);
      expect(store.selection()).toEqual([el.id]);
      expect(store.selectedElements()).toEqual([el]);
      store.clearSelection();
      expect(store.selection()).toEqual([]);
    });

    it('selection changes are not history entries', () => {
      const { store } = setup();
      const { deck, el } = deckWithElement();
      store.load(deck);
      store.select([el.id]);
      store.selectSlide(deck.slides[0].id);
      expect(store.canUndo()).toBe(false);
    });

    it('keeps the selection stable (same array) while unrelated parts change', () => {
      const { store } = setup();
      const { deck, el } = deckWithElement();
      store.load(deck);
      store.select([el.id]);
      const before = store.selection();
      store.execute(new SetNotes(deck.slides[0].id, 'n'));
      expect(store.selection()).toBe(before);
    });

    it('moves to the neighbouring slide when the current one is deleted, and survives undo', () => {
      const { store } = setup();
      const base = createDeck();
      const slides = [base.slides[0], createSlide(base.layouts[0].id), createSlide(base.layouts[0].id)];
      store.load({ ...base, slides });
      store.selectSlide(slides[1].id);
      store.execute(new DeleteSlide(slides[1].id));
      expect(store.currentSlide().id).toBe(slides[2].id);
      store.undo();
      expect(store.deck().slides).toHaveLength(3);
      expect(store.currentSlide().id).toBe(slides[2].id);

      store.execute(new DeleteSlide(slides[2].id));
      expect(store.currentSlide().id).toBe(slides[1].id);
    });

    it('does not switch the current slide when a slide is added', () => {
      const { store } = setup();
      const added = createSlide(store.deck().layouts[0].id);
      store.execute(new AddSlide(added));
      expect(store.currentSlide().id).not.toBe(added.id);
      store.selectSlide(added.id);
      expect(store.currentSlide()).toBe(added);
    });
  });

  describe('history', () => {
    it('undo and redo are no-ops on empty stacks', () => {
      const { store } = setup();
      const deck = store.deck();
      store.undo();
      store.redo();
      expect(store.deck()).toBe(deck);
    });

    it('a new command clears the redo stack', () => {
      const { store } = setup();
      const { deck, el } = deckWithElement();
      store.load(deck);
      store.execute(new MoveElements([el.id], 1, 0));
      store.undo();
      expect(store.canRedo()).toBe(true);
      store.execute(new MoveElements([el.id], 0, 1));
      expect(store.canRedo()).toBe(false);
    });

    it('enforces the default bound of 200 undo steps', () => {
      const { store } = setup();
      const { deck, el } = deckWithElement();
      store.load(deck);
      for (let i = 0; i < 250; i++) store.execute(new MoveElements([el.id], 1, 0));
      expect(undoAll(store)).toBe(200);
      expect(store.deck().slides[0].elements[0].x).toBe(50);
    });

    it('honours a custom limit', () => {
      const { store } = setup({ limit: 3 });
      const { deck, el } = deckWithElement();
      store.load(deck);
      for (let i = 0; i < 10; i++) store.execute(new MoveElements([el.id], 1, 0));
      expect(undoAll(store)).toBe(3);
      expect(store.deck().slides[0].elements[0].x).toBe(7);
    });

    it.each([0, -1, 1.5, NaN])('rejects the invalid limit %s', (limit) => {
      expect(() => new History({ limit })).toThrow(/positive integer/);
    });
  });

  describe('coalescing', () => {
    it('50 MoveElements with the same key become one undo step', () => {
      const { store, now } = setup();
      const { deck, el } = deckWithElement();
      store.load(deck);
      for (let i = 0; i < 50; i++) {
        store.execute(new MoveElements([el.id], 2, 1, { coalesceKey: 'drag' }));
        now.value += 10;
      }
      expect(store.deck().slides[0].elements[0]).toMatchObject({ x: 100, y: 50 });
      store.undo();
      expect(store.deck()).toEqual(deck);
      expect(store.canUndo()).toBe(false);
      store.redo();
      expect(store.deck().slides[0].elements[0]).toMatchObject({ x: 100, y: 50 });
      expect(store.canRedo()).toBe(false);
    });

    it('merges while commands are within the window of the previous one, not after it', () => {
      const { store, now } = setup();
      const { deck, el } = deckWithElement();
      store.load(deck);
      const move = () => store.execute(new MoveElements([el.id], 1, 0, { coalesceKey: 'drag' }));
      move();
      now.value += 500; // exactly the window: still merged
      move();
      now.value += 501; // beyond the window: new entry
      move();
      store.undo();
      expect(store.deck().slides[0].elements[0].x).toBe(2);
      store.undo();
      expect(store.deck()).toEqual(deck);
      expect(store.canUndo()).toBe(false);
    });

    it('does not merge different keys, missing keys, or different commands', () => {
      const { store } = setup();
      const { deck, el } = deckWithElement();
      store.load(deck);
      store.execute(new MoveElements([el.id], 1, 0, { coalesceKey: 'a' }));
      store.execute(new MoveElements([el.id], 1, 0, { coalesceKey: 'b' }));
      store.execute(new MoveElements([el.id], 1, 0));
      store.execute(new MoveElements([el.id], 1, 0));
      store.execute(new SetNotes(deck.slides[0].id, 'n'));
      expect(undoAll(store)).toBe(5);
    });

    it('an intervening command with another key ends the burst', () => {
      const { store } = setup();
      const { deck, el } = deckWithElement();
      store.load(deck);
      store.execute(new MoveElements([el.id], 1, 0, { coalesceKey: 'drag' }));
      store.execute(new SetNotes(deck.slides[0].id, 'n'));
      store.execute(new MoveElements([el.id], 1, 0, { coalesceKey: 'drag' }));
      expect(undoAll(store)).toBe(3);
    });

    it('does not merge into an entry that was undone and redone', () => {
      const { store } = setup();
      const { deck, el } = deckWithElement();
      store.load(deck);
      const move = () => store.execute(new MoveElements([el.id], 1, 0, { coalesceKey: 'drag' }));
      move();
      store.undo();
      store.redo();
      move();
      store.undo();
      expect(store.deck().slides[0].elements[0].x).toBe(1);
    });

    it('SetNotes typing bursts coalesce per slide', () => {
      const { store, now } = setup();
      const id = store.currentSlide().id;
      for (const text of ['h', 'he', 'hel', 'hell', 'hello']) {
        store.execute(new SetNotes(id, text));
        now.value += 50;
      }
      expect(store.currentSlide().notes).toBe('hello');
      store.undo();
      expect(store.currentSlide().notes).toBe('');
      expect(store.canUndo()).toBe(false);
    });
  });

  it('AddElement then undo restores the deck', () => {
    const { store } = setup();
    const { deck } = deckWithElement();
    store.load(deck);
    store.execute(new AddElement(deck.slides[0].id, createElement('text')));
    store.undo();
    expect(store.deck()).toEqual(deck);
  });

  it('a failing undo leaves deck and history untouched', () => {
    const { store } = setup();
    const broken: Command = {
      name: 'Broken',
      do: (deck) => ({
        deck: { ...deck, title: 'changed' },
        patch: [{ op: 'replace', path: '/title', value: 'changed' }],
        inverse: [{ op: 'replace', path: '/nope/x', value: 1 }],
      }),
    };
    store.execute(broken);
    const changed = store.deck();
    expect(() => store.undo()).toThrow(PatchError);
    expect(store.deck()).toBe(changed);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);
  });
});
