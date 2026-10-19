import { Directive, InjectionToken, computed, inject, input } from '@angular/core';
import type { Element, ElementType, Theme } from '../core/model';

/**
 * Observer called each time an element renderer receives a changed element. It exists so tests can
 * count renders (only the element whose props changed may re-render); nothing provides it in the app.
 */
export const RENDER_PROBE = new InjectionToken<(elementId: string, type: ElementType) => void>('Render probe');

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

/**
 * Base of the element renderers. Each one selects its own element by id from the slide's element
 * map in a `computed`; the map changes whenever the slide does, but an element that kept its
 * identity yields the same value, so nothing downstream of `element()` runs again (arc42 §8.1).
 * A new element type adds one subclass here, one schema entry and one editor panel section (Q13).
 */
@Directive({
  host: {
    '[style.left.px]': 'frame().x',
    '[style.top.px]': 'frame().y',
    '[style.width.px]': 'frame().w',
    '[style.height.px]': 'frame().h',
    '[style.transform]': 'frame().transform',
  },
})
export abstract class ElementView<T extends Element> {
  readonly elements = input.required<ReadonlyMap<string, Element>>();
  readonly elementId = input.required<string>();
  readonly theme = input.required<Theme>();

  protected abstract readonly type: T['type'];
  private readonly probe = inject(RENDER_PROBE, { optional: true });

  private readonly selected = computed(() => {
    const element = this.elements().get(this.elementId());
    return element?.type === this.type ? (element as T) : undefined;
  });

  /** The element, or `undefined` if the id is gone or has another type. Changes only with the element. */
  protected readonly element = computed(() => {
    const element = this.selected();
    if (element) this.probe?.(element.id, element.type);
    return element;
  });

  protected readonly frame = computed(() => {
    const el = this.element();
    return el
      ? { x: finite(el.x), y: finite(el.y), w: Math.max(0, finite(el.w)), h: Math.max(0, finite(el.h)), transform: el.rotation ? `rotate(${finite(el.rotation)}deg)` : null }
      : { x: 0, y: 0, w: 0, h: 0, transform: null };
  });
}
