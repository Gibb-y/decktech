import { computed, signal } from '@angular/core';
import { ALL_STEPS } from '../renderer';
import type { Slide } from '../core/model';

/** The steps of one slide. A step is one press of "next" that changes what the slide shows. */
export interface StepPlan {
  /** Distinct `step` values above 0 of the elements that can be shown, ascending: one step each. */
  readonly elementSteps: readonly number[];
  /** Code elements that can be shown, in z-order, with the internal steps they declared. */
  readonly components: readonly { readonly id: string; readonly steps: number }[];
  /** `elementSteps.length` plus the internal steps of every component. */
  readonly total: number;
}

/** What a slide shows at one step. */
export interface StepView {
  /** Highest element `step` shown, for the renderer's `step` input. */
  readonly elementStep: number;
  /** The internal step each component with internal steps is on. */
  readonly componentSteps: ReadonlyMap<string, number>;
}

/** Where the presentation is: a slide and a step on it (0 = nothing revealed yet). */
export interface StepPosition {
  readonly slide: number;
  readonly step: number;
}

export interface StepEngineDeps {
  slides(): readonly Slide[];
  /** Internal steps a code element declared with `deck.steps(n)` (0 when it declared none or has no frame). */
  componentSteps(elementId: string): number;
}

/** A count from a component is untrusted: only a whole number from 0 up counts. */
const wholeSteps = (count: number): number => (Number.isInteger(count) && count > 0 ? count : 0);

/**
 * Steps of a slide. Hidden elements never appear while presenting, so they cost no step. Element
 * steps come first, one per distinct `step` value (gaps such as 1, 5 cost no empty presses), then
 * the internal steps of each component in z-order: a component hidden until step 2 has not
 * started before step 2 has been shown.
 */
export function planSlide(slide: Slide, componentSteps: (elementId: string) => number): StepPlan {
  const values = new Set<number>();
  const components: { id: string; steps: number }[] = [];
  for (const element of slide.elements) {
    if (element.hidden === true) continue;
    const step = element.step ?? 0;
    if (Number.isFinite(step) && step > 0) values.add(step);
    if (element.type === 'code') {
      const steps = wholeSteps(componentSteps(element.id));
      if (steps > 0) components.push({ id: element.id, steps });
    }
  }
  const elementSteps = [...values].sort((a, b) => a - b);
  return { elementSteps, components, total: elementSteps.length + components.reduce((sum, c) => sum + c.steps, 0) };
}

/** What `plan` shows at `step` (clamped to `0..plan.total`). */
export function viewAt(plan: StepPlan, step: number): StepView {
  const at = Math.min(Math.max(step, 0), plan.total);
  const shown = Math.min(at, plan.elementSteps.length);
  const elementStep = shown === plan.elementSteps.length ? ALL_STEPS : shown === 0 ? 0 : plan.elementSteps[shown - 1];
  const componentSteps = new Map<string, number>();
  let remaining = at - shown;
  for (const component of plan.components) {
    const done = Math.min(component.steps, remaining);
    componentSteps.set(component.id, done);
    remaining -= done;
  }
  return { elementStep, componentSteps };
}

/**
 * Where "next" and "previous" lead (arc42 §5.5). Pure bookkeeping over signals, so it needs no
 * DOM: `next()` spends the steps of the slide (its elements, then its components) before it moves
 * on, `prev()` takes them back and lands on the last step of the slide before. Counts come from
 * running components and can change under it (a frame that died takes its steps with it), so
 * every read clamps the position to what the slide has now.
 */
export class StepEngine {
  private readonly position = signal<StepPosition>({ slide: 0, step: 0 });

  /** The slide shown, always a valid index (0 when the deck has no slides). */
  readonly slide = computed(() => this.clampSlide(this.position().slide));
  readonly plan = computed(() => {
    const slide = this.deps.slides()[this.slide()];
    return slide ? planSlide(slide, (id) => this.deps.componentSteps(id)) : { elementSteps: [], components: [], total: 0 };
  });
  /** The step on the slide shown, within `0..plan().total`. */
  readonly step = computed(() => Math.min(this.position().step, this.plan().total));
  readonly view = computed(() => viewAt(this.plan(), this.step()));
  readonly slideCount = computed(() => this.deps.slides().length);

  constructor(private readonly deps: StepEngineDeps) {}

  /** Moves forward one step, or to the next slide once the slide's steps are spent. False at the very end. */
  next(): boolean {
    const slide = this.slide();
    if (this.step() < this.plan().total) {
      this.position.set({ slide, step: this.step() + 1 });
      return true;
    }
    if (slide + 1 >= this.slideCount()) return false;
    this.position.set({ slide: slide + 1, step: 0 });
    return true;
  }

  /** Moves back one step, or to the last step of the slide before. False at the very start. */
  prev(): boolean {
    const slide = this.slide();
    if (this.step() > 0) {
      this.position.set({ slide, step: this.step() - 1 });
      return true;
    }
    if (slide === 0) return false;
    this.position.set({ slide: slide - 1, step: Number.POSITIVE_INFINITY });
    return true;
  }

  /** First slide, nothing revealed. */
  first(): void {
    this.position.set({ slide: 0, step: 0 });
  }

  /** Last slide with everything revealed. */
  last(): void {
    this.position.set({ slide: Math.max(this.slideCount() - 1, 0), step: Number.POSITIVE_INFINITY });
  }

  /** Jumps to `slide` (clamped to the deck) at `step` (0 = nothing revealed). */
  goTo(slide: number, step = 0): void {
    if (!Number.isFinite(slide)) return;
    this.position.set({ slide: this.clampSlide(Math.trunc(slide)), step: Math.max(0, step) });
  }

  /** Jumps to the slide with `slideId`; false when the deck has none. */
  goToSlideId(slideId: string): boolean {
    const index = this.deps.slides().findIndex((slide) => slide.id === slideId);
    if (index < 0) return false;
    this.goTo(index);
    return true;
  }

  private clampSlide(index: number): number {
    return Math.min(Math.max(index, 0), Math.max(this.slideCount() - 1, 0));
  }
}
