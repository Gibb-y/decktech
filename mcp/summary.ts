import type { Deck, Element, Slide } from '../src/app/core/model';
import { componentUses } from '../src/app/core/store/component-commands';
import { ToolError } from './tool';

export function slideOf(deck: Deck, slideId: string): Slide {
  const slide = deck.slides.find((s) => s.id === slideId);
  if (!slide) throw new ToolError(`Slide "${slideId}" does not exist. Slides: ${deck.slides.map((s) => s.id).join(', ')}`);
  return slide;
}

export function elementOf(deck: Deck, elementId: string): { element: Element; slide: Slide } {
  for (const slide of deck.slides) {
    const element = slide.elements.find((e) => e.id === elementId);
    if (element) return { element, slide };
  }
  throw new ToolError(`Element "${elementId}" does not exist. Use get_deck to list element ids.`);
}

const clip = (text: string, max = 80): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** One line that tells an agent what an element is without sending its whole content. */
export function describeElement(e: Element): string {
  switch (e.type) {
    case 'text':
      return JSON.stringify(clip(e.text.replace(/\s+/g, ' ')));
    case 'image':
      return `alt ${JSON.stringify(clip(e.alt))}`;
    case 'shape':
      return e.shape;
    case 'code':
      return `component ${e.componentId}`;
    case 'table':
      return `${e.rows.length} rows`;
    default:
      return e.type;
  }
}

export function elementSummary(e: Element) {
  return { id: e.id, type: e.type, x: e.x, y: e.y, w: e.w, h: e.h, summary: describeElement(e) };
}

export function slideSummary(deck: Deck, slide: Slide, index: number) {
  return {
    id: slide.id,
    index,
    layout: deck.layouts.find((l) => l.id === slide.layoutId)?.name ?? slide.layoutId,
    layoutId: slide.layoutId,
    ...(slide.section ? { section: slide.section } : {}),
    hasNotes: slide.notes.length > 0,
    elements: slide.elements.map(elementSummary),
  };
}

export function deckOutline(deck: Deck) {
  return {
    deckId: deck.id,
    title: deck.title,
    stage: deck.stage,
    slides: deck.slides.map((s, i) => slideSummary(deck, s, i)),
    components: deck.components.map((c) => ({ id: c.id, name: c.name, instances: componentUses(deck, c.id) })),
    layouts: deck.layouts.map((l) => ({ id: l.id, name: l.name, placeholders: l.placeholders.map((p) => p.kind) })),
    assets: Object.keys(deck.assets).length,
  };
}
