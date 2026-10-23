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
 * A fixed pool of `size` places for the layers: an item that is still wanted keeps its place, the
 * others take the free ones in order. `@for` over the pool (tracked by place) never moves a node, so a
 * layer that stays keeps its DOM; moving an iframe reloads it, which kills a code component's frame
 * (6.5). Items beyond `size` are dropped.
 */
export function assignSlots<T>(next: readonly T[], previous: readonly (T | null)[], size: number, key: (item: T) => string): (T | null)[] {
  const wanted = new Map(next.map((item) => [key(item), item]));
  const slots: (T | null)[] = Array.from({ length: size }, (_, place) => {
    const before = previous[place];
    return before ? (wanted.get(key(before)) ?? null) : null;
  });
  const placed = new Set(slots.flatMap((item) => (item ? [key(item)] : [])));
  for (const item of next) {
    if (placed.has(key(item))) continue;
    const free = slots.indexOf(null);
    if (free < 0) break;
    slots[free] = item;
  }
  return slots;
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
