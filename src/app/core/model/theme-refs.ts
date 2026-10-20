import { ELEMENT_SCHEMAS } from './element-schema';
import type { Color, Deck, Fill } from './types';

export interface ThemeRefs {
  colors: Set<string>;
  fonts: Set<string>;
}

/** Every theme colour token and font key the deck's slides, layouts and elements point at. */
export function themeRefs(deck: Deck): ThemeRefs {
  const refs: ThemeRefs = { colors: new Set(), fonts: new Set() };
  const color = (c: Color | undefined): void => {
    if (c !== undefined && typeof c === 'object' && c !== null) refs.colors.add(c.token);
  };
  const fill = (f: Fill | undefined): void => {
    if (f?.kind === 'solid') color(f.color);
    else if (f?.kind === 'gradient') f.stops.forEach((s) => color(s.color));
  };
  deck.layouts.forEach((l) => fill(l.background));
  for (const slide of deck.slides) {
    fill(slide.background);
    for (const element of slide.elements) {
      const record = element as unknown as Record<string, unknown>;
      for (const [name, spec] of Object.entries(ELEMENT_SCHEMAS[element.type].fields)) {
        const value = record[name];
        if (value === undefined) continue;
        if (spec.kind === 'color') color(value as Color);
        else if (spec.kind === 'fill') fill(value as Fill);
        else if (spec.kind === 'font') refs.fonts.add(value as string);
      }
    }
  }
  return refs;
}
