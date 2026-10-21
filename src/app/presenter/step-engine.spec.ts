import { signal } from '@angular/core';
import { createElement, createSlide, type Element, type Slide } from '../core/model';
import { ALL_STEPS } from '../renderer';
import { StepEngine, planSlide, viewAt } from './step-engine';

const slideWith = (...elements: Element[]): Slide => ({ ...createSlide('layout'), elements });
const text = (step?: number, hidden?: boolean) => createElement('text', { step, hidden });
const code = (hidden?: boolean) => createElement('code', { hidden });

/** An engine over `slides`, with component step counts that a test can change like a running frame would. */
function setup(slides: Slide[], counts: Record<string, number> = {}) {
  const slidesSignal = signal(slides);
  const countsSignal = signal(counts);
  const engine = new StepEngine({ slides: () => slidesSignal(), componentSteps: (id) => countsSignal()[id] ?? 0 });
  const at = () => [engine.slide(), engine.step()];
  return { engine, at, slides: slidesSignal, counts: countsSignal };
}

describe('planSlide', () => {
  it('has no steps for a slide whose elements are all visible from the start', () => {
    expect(planSlide(slideWith(text(), text(0)), () => 0)).toEqual({ elementSteps: [], components: [], total: 0 });
  });

  it('makes one step per distinct element step value, however far apart', () => {
    const plan = planSlide(slideWith(text(5), text(1), text(5), text(1), text()), () => 0);
    expect(plan.elementSteps).toEqual([1, 5]);
    expect(plan.total).toBe(2);
  });

  it('gives hidden elements no step, and ignores a step that is not a positive number', () => {
    const plan = planSlide(slideWith(text(3, true), text(-2), text(Number.NaN), text(Number.POSITIVE_INFINITY)), () => 0);
    expect(plan).toEqual({ elementSteps: [], components: [], total: 0 });
  });

  it('adds the internal steps of each visible code element, in z-order', () => {
    const a = code();
    const b = code();
    const c = code(true);
    const plan = planSlide(slideWith(a, text(2), b, c), (id) => ({ [a.id]: 3, [b.id]: 2, [c.id]: 9 })[id] ?? 0);
    expect(plan.components).toEqual([
      { id: a.id, steps: 3 },
      { id: b.id, steps: 2 },
    ]);
    expect(plan.total).toBe(1 + 3 + 2);
  });

  it.each([-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('does not trust a count of %s from a component', (count) => {
    const el = code();
    expect(planSlide(slideWith(el), () => count).total).toBe(0);
  });
});

describe('viewAt', () => {
  const a = code();
  const b = code();
  const plan = planSlide(slideWith(text(1), text(4), a, b), (id) => (id === a.id ? 2 : id === b.id ? 1 : 0));

  it.each([
    [0, 0, 0, 0],
    [1, 1, 0, 0],
    [2, ALL_STEPS, 0, 0],
    [3, ALL_STEPS, 1, 0],
    [4, ALL_STEPS, 2, 0],
    [5, ALL_STEPS, 2, 1],
  ])('at step %i shows element step %s and the components on %i and %i', (step, elementStep, first, second) => {
    const view = viewAt(plan, step);
    expect(view.elementStep).toBe(elementStep);
    expect(view.componentSteps.get(a.id)).toBe(first);
    expect(view.componentSteps.get(b.id)).toBe(second);
  });

  it('clamps a step outside the slide', () => {
    expect(viewAt(plan, -3)).toEqual(viewAt(plan, 0));
    expect(viewAt(plan, 99)).toEqual(viewAt(plan, 5));
  });

  it('shows everything at step 0 of a slide without steps', () => {
    expect(viewAt(planSlide(slideWith(text()), () => 0), 0).elementStep).toBe(ALL_STEPS);
  });
});

describe('StepEngine', () => {
  describe('element steps', () => {
    it('reveals one step per press, then moves to the next slide', () => {
      const { engine, at } = setup([slideWith(text(), text(1), text(2)), slideWith()]);
      const seen = [at()];
      while (engine.next()) seen.push(at());
      expect(seen).toEqual([[0, 0], [0, 1], [0, 2], [1, 0]]);
    });

    it('hands the renderer the step value to draw', () => {
      const { engine } = setup([slideWith(text(2), text(7))]);
      expect(engine.view().elementStep).toBe(0);
      engine.next();
      expect(engine.view().elementStep).toBe(2);
      engine.next();
      expect(engine.view().elementStep).toBe(ALL_STEPS);
    });
  });

  describe('component steps', () => {
    it('spends the steps of a component before it changes slide', () => {
      const el = code();
      const { engine, at } = setup([slideWith(el), slideWith()], { [el.id]: 3 });
      const seen = [at()];
      while (engine.next()) seen.push(at());
      expect(seen).toEqual([[0, 0], [0, 1], [0, 2], [0, 3], [1, 0]]);
      expect(engine.plan().total).toBe(0);
    });

    it('tells each component which of its steps to show', () => {
      const a = code();
      const b = code();
      const { engine } = setup([slideWith(a, b)], { [a.id]: 1, [b.id]: 2 });
      const stepsOf = () => [engine.view().componentSteps.get(a.id), engine.view().componentSteps.get(b.id)];
      const seen = [stepsOf()];
      while (engine.next()) seen.push(stepsOf());
      expect(seen).toEqual([[0, 0], [1, 0], [1, 1], [1, 2]]);
    });

    it('shows the elements first, so a component revealed by a step starts after it', () => {
      const el = code();
      el.step = 1;
      const { engine } = setup([slideWith(el)], { [el.id]: 1 });
      expect(engine.view().elementStep).toBe(0);
      engine.next();
      expect(engine.view().elementStep).toBe(ALL_STEPS);
      expect(engine.view().componentSteps.get(el.id)).toBe(0);
      engine.next();
      expect(engine.view().componentSteps.get(el.id)).toBe(1);
    });

    it('takes up steps a component declares after the slide was shown', () => {
      const el = code();
      const { engine, counts } = setup([slideWith(el), slideWith()]);
      expect(engine.plan().total).toBe(0);
      counts.set({ [el.id]: 2 });
      expect(engine.plan().total).toBe(2);
      engine.next();
      expect(engine.step()).toBe(1);
    });

    it('drops a step the position has when the component that declared it goes away', () => {
      const el = code();
      const { engine, counts, at } = setup([slideWith(el), slideWith()], { [el.id]: 3 });
      engine.next();
      engine.next();
      engine.next();
      counts.set({});
      expect(at()).toEqual([0, 0]);
      expect(engine.next()).toBe(true);
      expect(at()).toEqual([1, 0]);
    });
  });

  describe('backwards', () => {
    it('mirrors next, landing on the last step of the slide before', () => {
      const el = code();
      const slides = [slideWith(text(1)), slideWith(el), slideWith()];
      const { engine, at } = setup(slides, { [el.id]: 2 });
      engine.last();
      const seen = [at()];
      while (engine.prev()) seen.push(at());
      expect(seen).toEqual([[2, 0], [1, 2], [1, 1], [1, 0], [0, 1], [0, 0]]);
    });

    it('retraces exactly the way forward', () => {
      const el = code();
      const { engine, at } = setup([slideWith(text(1), text(2)), slideWith(el), slideWith(text(1))], { [el.id]: 2 });
      const forward = [at()];
      while (engine.next()) forward.push(at());
      const back = [at()];
      while (engine.prev()) back.push(at());
      expect(back).toEqual(forward.slice().reverse());
    });

    it('keeps the end of a slide at its end when a component declares more steps later', () => {
      const el = code();
      const { engine, counts } = setup([slideWith(el), slideWith()]);
      engine.goTo(1);
      engine.prev();
      counts.set({ [el.id]: 2 });
      expect(engine.step()).toBe(2);
    });
  });

  describe('boundaries', () => {
    it('does not go before the first or after the last step', () => {
      const { engine, at } = setup([slideWith(text(1))]);
      expect(engine.prev()).toBe(false);
      expect(at()).toEqual([0, 0]);
      expect(engine.next()).toBe(true);
      expect(engine.next()).toBe(false);
      expect(at()).toEqual([0, 1]);
    });

    it('works on a deck of one slide without steps', () => {
      const { engine } = setup([slideWith()]);
      expect(engine.next()).toBe(false);
      expect(engine.prev()).toBe(false);
    });

    it('survives a deck without slides', () => {
      const { engine } = setup([]);
      expect(engine.slide()).toBe(0);
      expect(engine.view().elementStep).toBe(ALL_STEPS);
      expect(engine.next()).toBe(false);
      expect(engine.prev()).toBe(false);
      engine.last();
      expect(engine.slide()).toBe(0);
    });

    it('stays on a valid slide when slides are removed under it', () => {
      const { engine, slides } = setup([slideWith(), slideWith(), slideWith()]);
      engine.goTo(2);
      slides.update((list) => list.slice(0, 1));
      expect(engine.slide()).toBe(0);
      expect(engine.next()).toBe(false);
    });
  });

  describe('jumping', () => {
    it('goes to the first slide and to the last one with everything revealed', () => {
      const { engine, at } = setup([slideWith(), slideWith(), slideWith(text(1), text(2))]);
      engine.last();
      expect(at()).toEqual([2, 2]);
      expect(engine.view().elementStep).toBe(ALL_STEPS);
      engine.first();
      expect(at()).toEqual([0, 0]);
    });

    it('clamps goTo to the deck and ignores a number that is not finite', () => {
      const { engine, at } = setup([slideWith(), slideWith()]);
      engine.goTo(99);
      expect(at()).toEqual([1, 0]);
      engine.goTo(-4);
      expect(at()).toEqual([0, 0]);
      engine.goTo(1);
      engine.goTo(Number.NaN);
      engine.goTo(Number.POSITIVE_INFINITY);
      expect(at()).toEqual([1, 0]);
    });

    it('finds a slide by id, and refuses an id the deck does not have', () => {
      const slides = [slideWith(), slideWith(), slideWith()];
      const { engine, at } = setup(slides);
      expect(engine.goToSlideId(slides[2].id)).toBe(true);
      expect(at()).toEqual([2, 0]);
      expect(engine.goToSlideId('slide_missing')).toBe(false);
      expect(engine.goToSlideId('toString')).toBe(false);
      expect(at()).toEqual([2, 0]);
    });

    it('does not take a negative step', () => {
      const { engine } = setup([slideWith(text(1))]);
      engine.goTo(0, -5);
      expect(engine.step()).toBe(0);
    });
  });

  it('does not change the slides it is given', () => {
    const slides = [slideWith(text(1), code())];
    const frozen = structuredClone(slides);
    const { engine } = setup(slides);
    engine.next();
    engine.prev();
    engine.last();
    expect(slides).toEqual(frozen);
  });
});
