import type { Slide } from '../core/model';
import { PRELOAD_DISTANCE } from '../renderer';

/** A slide the presentation keeps in the page. */
export interface MountedSlide {
  readonly slide: Slide;
  readonly index: number;
  /** Slides between this one and the one shown; handed to the renderer, which destroys frames beyond `PRELOAD_DISTANCE`. */
  readonly distance: number;
}

/** Whether the slide has a code element that would be drawn while presenting. */
export function hasCode(slide: Slide): boolean {
  return slide.elements.some((element) => element.type === 'code' && element.hidden !== true);
}

/**
 * Which slides to keep in the page while `current` is shown (arc42 §5.5): the shown slide, and the
 * neighbours within `PRELOAD_DISTANCE` that have code components, so their frames are started
 * (hidden) while the current slide is on screen and advancing only has to show them (Q10). A
 * neighbour without code is cheap to draw on demand and is not kept. Anything farther is left out
 * of the result, so its renderer is destroyed and its frames with it. The result is in slide order.
 */
export function slidesToMount(slides: readonly Slide[], current: number): MountedSlide[] {
  const result: MountedSlide[] = [];
  const from = Math.max(current - PRELOAD_DISTANCE, 0);
  const to = Math.min(current + PRELOAD_DISTANCE, slides.length - 1);
  for (let index = from; index <= to; index++) {
    const slide = slides[index];
    if (index === current || hasCode(slide)) result.push({ slide, index, distance: Math.abs(index - current) });
  }
  return result;
}
