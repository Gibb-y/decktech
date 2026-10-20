import { TestBed } from '@angular/core/testing';
import { createDeck, createSlide } from '../core/model';
import { DeckStore } from '../core/store';
import { LiveAnnouncer } from '../shared';
import { SlideActions } from './slide-actions';

function setup(count = 4) {
  TestBed.configureTestingModule({});
  const store = TestBed.inject(DeckStore);
  const deck = createDeck('Test');
  for (let i = 1; i < count; i++) deck.slides.push(createSlide(deck.layouts[0].id));
  store.load(deck);
  const announce = vi.spyOn(TestBed.inject(LiveAnnouncer), 'announce');
  const ids = () => store.slides().map((s) => s.id);
  return { store, announce, actions: TestBed.inject(SlideActions), original: ids(), ids };
}

describe('SlideActions.moveSlideBefore', () => {
  // from, insert before, expected order of [0,1,2,3]
  it.each([
    [0, 0, [0, 1, 2, 3]],
    [0, 1, [0, 1, 2, 3]],
    [0, 2, [1, 0, 2, 3]],
    [0, 4, [1, 2, 3, 0]],
    [3, 0, [3, 0, 1, 2]],
    [3, 3, [0, 1, 2, 3]],
    [3, 4, [0, 1, 2, 3]],
    [2, 1, [0, 2, 1, 3]],
    [1, 3, [0, 2, 1, 3]],
  ])('slide %i dropped before position %i gives %j', (from, before, expected) => {
    const { actions, ids, original, store } = setup();
    actions.moveSlideBefore(original[from], before);
    expect(ids()).toEqual(expected.map((i) => original[i]));
    if (expected.every((v, i) => v === i)) expect(store.canUndo()).toBe(false); // a drop in place is not an edit
  });

  it('ignores an unknown slide', () => {
    const { actions, store } = setup();
    actions.moveSlideBefore('sl_missing', 1);
    expect(store.canUndo()).toBe(false);
  });

  it('announces, rather than throws, for a position outside the list', () => {
    const { actions, store, announce } = setup();
    expect(() => actions.moveSlideBefore(store.slides()[0].id, 99)).not.toThrow();
    expect(announce).toHaveBeenLastCalledWith('Slide index 98 out of range');
    expect(store.canUndo()).toBe(false);
  });

  it('is a single undo step', () => {
    const { actions, store, original, ids } = setup();
    actions.moveSlideBefore(original[0], 3);
    store.undo();
    expect(ids()).toEqual(original);
  });
});

describe('SlideActions.moveSlideBy', () => {
  it('moves by a step, clamps at the ends and announces the new position', () => {
    const { actions, store, announce, original, ids } = setup();
    store.selectSlide(original[1]);
    actions.moveSlideBy(1);
    expect(ids()).toEqual([original[0], original[2], original[1], original[3]]);
    expect(announce).toHaveBeenLastCalledWith('Slide moved to position 3 of 4');
    actions.moveSlideBy(5);
    expect(ids()[3]).toBe(original[1]);
    actions.moveSlideBy(-10);
    expect(ids()[0]).toBe(original[1]);
  });

  it('does nothing for an unknown slide', () => {
    const { actions, store } = setup();
    actions.moveSlideBy(1, 'sl_missing');
    expect(store.canUndo()).toBe(false);
  });
});

describe('SlideActions.addSlide', () => {
  it('adds after the current slide with its layout and selects it', () => {
    const { actions, store, original } = setup();
    store.selectSlide(original[1]);
    actions.addSlide();
    expect(store.currentSlideIndex()).toBe(2);
    expect(store.currentSlide().layoutId).toBe(store.slides()[1].layoutId);
    expect(store.currentSlide().elements).toEqual([]);
    expect(store.slides()).toHaveLength(5);
  });

  it('adds at the end when the last slide is current', () => {
    const { actions, store, original } = setup();
    store.selectSlide(original[3]);
    actions.addSlide();
    expect(store.currentSlideIndex()).toBe(4);
  });
});

describe('SlideActions.deleteSlide and duplicateSlide', () => {
  it('delete leaves the neighbour current', () => {
    const { actions, store, original } = setup();
    store.selectSlide(original[1]);
    actions.deleteSlide();
    expect(store.currentSlideId()).toBe(original[2]);
  });

  it('delete of the last remaining slide is refused and says why', () => {
    const { actions, store, announce } = setup(1);
    actions.deleteSlide();
    expect(store.slides()).toHaveLength(1);
    expect(announce).toHaveBeenLastCalledWith('A deck needs at least one slide');
    expect(store.canUndo()).toBe(false);
  });

  it('announce an unknown target instead of throwing', () => {
    const { actions, announce } = setup();
    expect(() => actions.deleteSlide('sl_missing')).not.toThrow();
    expect(announce).toHaveBeenLastCalledWith('Slide "sl_missing" does not exist');
    expect(() => actions.duplicateSlide('sl_missing')).not.toThrow();
    expect(announce).toHaveBeenLastCalledWith('Slide "sl_missing" does not exist');
  });

  it('duplicate puts the copy right after the original and selects it', () => {
    const { actions, store, original, ids } = setup();
    store.selectSlide(original[1]);
    actions.duplicateSlide();
    expect(ids()[1]).toBe(original[1]);
    expect(ids()).toHaveLength(5);
    expect(store.currentSlideIndex()).toBe(2);
  });
});

describe('SlideActions.setSection', () => {
  it('names and clears a section, announcing the position', () => {
    const { actions, store, announce, original } = setup();
    actions.setSection(original[2], ' Results ');
    expect(store.slides()[2].section).toBe('Results');
    expect(announce).toHaveBeenLastCalledWith('Section “Results” starts at slide 3');
    actions.setSection(original[2], '');
    expect('section' in store.slides()[2]).toBe(false);
    expect(announce).toHaveBeenLastCalledWith('Section removed from slide 3');
  });

  it('announces a name that is too long instead of throwing, and changes nothing', () => {
    const { actions, store, announce, original } = setup();
    expect(() => actions.setSection(original[0], 'x'.repeat(500))).not.toThrow();
    expect(announce).toHaveBeenLastCalledWith('A section name has at most 200 characters');
    expect(store.canUndo()).toBe(false);
  });

  it('typing a name in bursts is one undo step per slide', () => {
    const { actions, store, original } = setup();
    for (const name of ['R', 'Re', 'Res']) actions.setSection(original[0], name);
    store.undo();
    expect('section' in store.slides()[0]).toBe(false);
    expect(store.canUndo()).toBe(false);
  });
});
