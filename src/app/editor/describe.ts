import type { Element } from '../core/model';

const MAX_TEXT = 40;

const SHAPE_NAMES = { rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle' } as const;

/** A short, speakable name for an element: used in announcements and accessible names. */
export function describeElement(element: Element): string {
  switch (element.type) {
    case 'text': {
      const text = element.text.replace(/\s+/g, ' ').trim();
      if (!text) return 'Empty text';
      return `Text “${text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text}”`;
    }
    case 'shape':
      return SHAPE_NAMES[element.shape];
    case 'image':
      return element.alt.trim() ? `Image “${element.alt.trim()}”` : 'Image';
    case 'line':
      return 'Line';
    case 'table':
      return 'Table';
    case 'video':
      return element.label?.trim() ? `Video “${element.label.trim()}”` : 'Video';
    case 'code':
      return 'Code component';
  }
}
