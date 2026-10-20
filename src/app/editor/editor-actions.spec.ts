import { TestBed } from '@angular/core/testing';
import { createDeck, createElement, type Deck, type Element } from '../core/model';
import { CLOCK, DeckStore } from '../core/store';
import { LiveAnnouncer } from '../shared';
import { EditorActions, PASTE_OFFSET } from './editor-actions';

let now = 0;

function setup(build?: (deck: Deck) => Element[]) {
  now = 0;
  TestBed.configureTestingModule({ providers: [{ provide: CLOCK, useValue: () => now }] });
  const store = TestBed.inject(DeckStore);
  const deck = createDeck();
  const elements = build?.(deck) ?? [
    createElement('text', { x: 100, y: 100, w: 200, h: 100, text: 'Hello' }),
    createElement('shape', { x: 400, y: 300, w: 100, h: 100, shape: 'rect' }),
    createElement('shape', { x: 700, y: 500, w: 100, h: 100, shape: 'ellipse' }),
  ];
  const [slide] = deck.slides;
  store.load({ ...deck, slides: [{ ...slide, elements }] });
  const announcer = TestBed.inject(LiveAnnouncer);
  const announce = vi.spyOn(announcer, 'announce');
  return { store, actions: TestBed.inject(EditorActions), announce, ids: elements.map((e) => e.id) };
}

const elementsOf = (store: DeckStore) => store.currentSlide().elements;
const byId = (store: DeckStore, id: string) => elementsOf(store).find((e) => e.id === id)!;

describe('EditorActions selection', () => {
  it('selects all and clears, announcing both', () => {
    const { store, actions, announce, ids } = setup();
    actions.selectAll();
    expect(store.selection()).toEqual(ids);
    expect(announce).toHaveBeenLastCalledWith('3 elements selected');
    actions.deselect();
    expect(store.selection()).toEqual([]);
    expect(announce).toHaveBeenLastCalledWith('Selection cleared');
  });

  it('cycles with next / previous and lets go at the ends so Tab can leave the canvas', () => {
    const { store, actions, announce, ids } = setup();
    expect(actions.selectNext(1)).toBe(true);
    expect(store.selection()).toEqual([ids[0]]);
    expect(announce).toHaveBeenLastCalledWith('Text “Hello”, 1 of 3, selected');
    expect(actions.selectNext(1)).toBe(true);
    expect(actions.selectNext(1)).toBe(true);
    expect(store.selection()).toEqual([ids[2]]);
    expect(actions.selectNext(1)).toBe(false);
    expect(store.selection()).toEqual([ids[2]]);
    expect(actions.selectNext(-1)).toBe(true);
    expect(store.selection()).toEqual([ids[1]]);
  });

  it('starts at the last element with Shift+Tab', () => {
    const { store, actions, ids } = setup();
    expect(actions.selectNext(-1)).toBe(true);
    expect(store.selection()).toEqual([ids[2]]);
  });

  it('reports false on an empty slide', () => {
    expect(setup(() => []).actions.selectNext(1)).toBe(false);
  });

  it('moves on from the last element of a multi-selection', () => {
    const { store, actions, ids } = setup();
    store.select([ids[0], ids[1]]);
    actions.selectNext(1);
    expect(store.selection()).toEqual([ids[2]]);
  });

  it('treats a selection that is not on this slide like no selection', () => {
    const { store, actions, ids } = setup();
    store.select(['el_gone']);
    expect(actions.selectNext(1)).toBe(true);
    expect(store.selection()).toEqual([ids[0]]);
  });

  it('mentions locked and hidden elements', () => {
    const { actions, announce, store } = setup(() => [createElement('text', { text: 'x', locked: true, hidden: true })]);
    store.select([store.currentSlide().elements[0].id]);
    actions.announceSelection();
    expect(announce).toHaveBeenLastCalledWith('Text “x”, 1 of 1, locked, hidden, selected');
  });
});

describe('EditorActions geometry', () => {
  it('nudges by 1 and merges a held key into one undo step', () => {
    const { store, actions, ids } = setup();
    store.select([ids[0]]);
    for (let i = 0; i < 5; i++) {
      now += 30;
      actions.nudge(1, 0);
    }
    expect(byId(store, ids[0]).x).toBe(105);
    store.undo();
    expect(byId(store, ids[0]).x).toBe(100);
    expect(store.canUndo()).toBe(false);
  });

  it('starts a new undo step after a pause', () => {
    const { store, actions, ids } = setup();
    store.select([ids[0]]);
    actions.nudge(1, 0);
    now += 2000;
    actions.nudge(1, 0);
    store.undo();
    expect(byId(store, ids[0]).x).toBe(101);
  });

  it('does not move locked elements and says so', () => {
    const { store, actions, announce } = setup(() => [createElement('shape', { x: 10, y: 10, locked: true })]);
    const [only] = elementsOf(store);
    store.select([only.id]);
    actions.nudge(5, 5);
    actions.resizeBy(5, 5);
    actions.rotateBy(10);
    actions.align('left');
    actions.deleteSelection();
    expect(byId(store, only.id)).toBe(only);
    expect(announce).toHaveBeenLastCalledWith('Locked elements cannot be changed');
  });

  it('moves only the unlocked part of a mixed selection', () => {
    const { store, actions } = setup(() => [
      createElement('shape', { x: 0, y: 0, locked: true }),
      createElement('shape', { x: 50, y: 50 }),
    ]);
    const [a, b] = elementsOf(store);
    store.select([a.id, b.id]);
    actions.nudge(10, 0);
    expect([byId(store, a.id).x, byId(store, b.id).x]).toEqual([0, 60]);
  });

  it('resizes keeping the corner, never below 1, and rotates modulo 360', () => {
    const { store, actions, ids } = setup();
    store.select([ids[1]]);
    actions.resizeBy(10, -1000);
    expect(byId(store, ids[1])).toMatchObject({ x: 400, y: 300, w: 110, h: 1 });
    actions.rotateBy(-30);
    expect(byId(store, ids[1]).rotation).toBe(330);
    actions.rotateBy(60);
    expect(byId(store, ids[1]).rotation).toBe(30);
  });

  it('rotates several elements by the same step as one undo step', () => {
    const { store, actions, ids } = setup();
    store.select([ids[0], ids[1]]);
    actions.rotateBy(15);
    expect([ids[0], ids[1]].map((id) => byId(store, id).rotation)).toEqual([15, 15]);
    store.undo();
    expect([ids[0], ids[1]].map((id) => byId(store, id).rotation)).toEqual([0, 0]);
  });

  it('aligns the selection, one undo step, and explains when nothing needs to move', () => {
    const { store, actions, ids, announce } = setup();
    store.select(ids);
    actions.align('left');
    expect(elementsOf(store).map((e) => e.x)).toEqual([100, 100, 100]);
    store.undo();
    expect(elementsOf(store).map((e) => e.x)).toEqual([100, 400, 700]);
    store.redo();
    actions.align('left');
    expect(announce).toHaveBeenLastCalledWith('Already aligned');
  });

  it('aligns a single element to the slide', () => {
    const { store, actions, ids } = setup();
    store.select([ids[1]]);
    actions.align('center');
    expect(byId(store, ids[1]).x).toBe(910);
  });

  it('distributes three elements and asks for three otherwise', () => {
    const { store, actions, ids, announce } = setup();
    store.select([ids[0], ids[1]]);
    actions.distribute('horizontal');
    expect(announce).toHaveBeenLastCalledWith('Select at least three elements to distribute');
    store.select(ids);
    actions.distribute('horizontal');
    // 100..300, 400..500, 700..800: gaps 100 and 200 become 150 each... span 100..800, widths 400.
    expect(byId(store, ids[1]).x).toBeCloseTo(100 + 200 + 150);
    expect(announce).toHaveBeenLastCalledWith('Distributed horizontally');
    actions.distribute('vertical');
    expect(announce).toHaveBeenLastCalledWith('Already evenly spaced');
    store.select([ids[1]]);
    actions.nudge(0, 50);
    store.select(ids);
    actions.distribute('vertical');
    expect(announce).toHaveBeenLastCalledWith('Distributed vertically');
  });
});

describe('EditorActions structure', () => {
  it('deletes the selection as one undo step', () => {
    const { store, actions, ids, announce } = setup();
    store.select([ids[0], ids[2]]);
    actions.deleteSelection();
    expect(elementsOf(store).map((e) => e.id)).toEqual([ids[1]]);
    expect(announce).toHaveBeenLastCalledWith('2 elements deleted');
    store.undo();
    expect(elementsOf(store).map((e) => e.id)).toEqual(ids);
  });

  it('duplicates with fresh ids, offset, selected, as one undo step', () => {
    const { store, actions, ids } = setup();
    store.select([ids[0], ids[1]]);
    actions.duplicateSelection();
    const all = elementsOf(store);
    expect(all).toHaveLength(5);
    const copies = all.slice(3);
    expect(copies.map((c) => c.id).some((id) => ids.includes(id))).toBe(false);
    expect(new Set(all.map((e) => e.id)).size).toBe(5);
    expect(copies.map((c) => [c.x, c.y])).toEqual([
      [100 + PASTE_OFFSET, 100 + PASTE_OFFSET],
      [400 + PASTE_OFFSET, 300 + PASTE_OFFSET],
    ]);
    expect(store.selection()).toEqual(copies.map((c) => c.id));
    store.undo();
    expect(elementsOf(store)).toHaveLength(3);
  });

  it('copies and pastes onto another slide, each paste one offset further, without aliasing', () => {
    const { store, actions, ids } = setup();
    store.select([ids[0]]);
    actions.copy();
    actions.paste();
    actions.paste();
    const pasted = elementsOf(store).slice(3);
    expect(pasted.map((p) => p.x)).toEqual([100 + PASTE_OFFSET, 100 + 2 * PASTE_OFFSET]);
    expect(pasted[0]).not.toBe(byId(store, ids[0]));
    expect(new Set(elementsOf(store).map((e) => e.id)).size).toBe(5);
  });

  it('pastes nothing when the clipboard is empty or belongs to another deck', () => {
    const { store, actions, announce, ids } = setup();
    actions.paste();
    expect(announce).toHaveBeenLastCalledWith('Nothing to paste');
    store.select([ids[0]]);
    actions.copy();
    expect(actions.canPaste()).toBe(true);
    store.load(createDeck());
    expect(actions.canPaste()).toBe(false);
    actions.paste();
    expect(store.currentSlide().elements).toEqual([]);
  });

  it('reorders in z-order and stays quiet when nothing changes', () => {
    const { store, actions, ids, announce } = setup();
    store.select([ids[0]]);
    actions.reorder('front');
    expect(elementsOf(store).map((e) => e.id)).toEqual([ids[1], ids[2], ids[0]]);
    announce.mockClear();
    actions.reorder('front');
    expect(announce).not.toHaveBeenCalled();
    actions.reorder('backward');
    expect(elementsOf(store).map((e) => e.id)).toEqual([ids[1], ids[0], ids[2]]);
  });

  it('undoes and redoes, announcing when there is nothing to do', () => {
    const { store, actions, announce, ids } = setup();
    actions.undo();
    expect(announce).toHaveBeenLastCalledWith('Nothing to undo');
    store.select([ids[0]]);
    actions.nudge(5, 0);
    actions.undo();
    expect(byId(store, ids[0]).x).toBe(100);
    actions.redo();
    expect(byId(store, ids[0]).x).toBe(105);
    actions.redo();
    expect(announce).toHaveBeenLastCalledWith('Nothing to redo');
  });
});
