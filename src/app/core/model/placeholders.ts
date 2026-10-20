import { createElement } from './factory';
import type { Element, Layout, Placeholder, PlaceholderKind, Slide, Theme } from './types';

/**
 * The element a new slide gets for a placeholder, styled from the theme's type scale and fonts, or
 * `null` for kinds that cannot start out as an element (a picture needs a file).
 */
export function createPlaceholderElement(placeholder: Placeholder, theme: Theme): Element | null {
  const { kind, x, y, w, h } = placeholder;
  const size = (key: string, fallback: number): number => (Object.hasOwn(theme.typeScale, key) ? theme.typeScale[key] : fallback);
  const heading = Object.hasOwn(theme.fonts, 'heading') ? { font: 'heading' } : {};
  switch (kind) {
    case 'title':
      return createElement('text', { x, y, w, h, text: 'Title', fontSize: size('heading', 64), placeholder: kind, ...heading });
    case 'body':
      return createElement('text', { x, y, w, h, text: h >= 400 ? '- First point\n- Second point' : 'Text', fontSize: size('body', 40), placeholder: kind });
    case 'footer':
      return createElement('text', { x, y, w, h, text: 'Footer', fontSize: size('caption', 28), placeholder: kind });
    case 'image':
      return null;
  }
}

/** A slide on `layout` with an element for each placeholder that can start as one. */
export function instantiateLayout(slide: Slide, layout: Layout, theme: Theme): Slide {
  const elements = layout.placeholders.flatMap((p) => createPlaceholderElement(p, theme) ?? []);
  return { ...slide, layoutId: layout.id, elements: [...slide.elements, ...elements] };
}

/**
 * Moves the elements bound to a placeholder kind into the placeholders of `layout` of the same
 * kind: the n-th bound element (in z-order) takes the n-th placeholder. Elements without a
 * placeholder, locked ones and surplus ones keep their place and binding, so no content is lost
 * and switching back finds them again. Returns the same array when nothing moves.
 */
export function reflowToLayout(elements: readonly Element[], layout: Layout): readonly Element[] {
  const used = new Map<PlaceholderKind, number>();
  let changed = false;
  const next = elements.map((e) => {
    if (e.placeholder === undefined || e.locked) return e;
    const index = used.get(e.placeholder) ?? 0;
    used.set(e.placeholder, index + 1);
    const target = layout.placeholders.filter((p) => p.kind === e.placeholder)[index];
    if (!target || (e.x === target.x && e.y === target.y && e.w === target.w && e.h === target.h && e.rotation === 0)) return e;
    changed = true;
    return { ...e, x: target.x, y: target.y, w: target.w, h: target.h, rotation: 0 };
  });
  return changed ? next : elements;
}
