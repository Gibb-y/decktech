import { createDeck, createElement, type Deck, type Element } from '../../core/model';

/**
 * A deck whose first slide holds `count` elements (text, shapes and lines in a grid, some
 * rotated), for profiling a drag against the 55 fps target of quality scenario Q9 and for tests
 * that count how much re-renders per move. Code components are not rendered yet (arc42 §5.7), so
 * the "3 code components" of Q9 are left out until the renderer draws them.
 */
export function createStressDeck(count = 100): Deck {
  const deck = createDeck('Stress test');
  const columns = 10;
  const cellW = 180;
  const cellH = 100;
  const elements: Element[] = Array.from({ length: count }, (_, i) => {
    const x = 20 + (i % columns) * cellW;
    const y = 20 + Math.floor(i / columns) * cellH;
    const rotation = i % 7 === 0 ? 15 : 0;
    if (i % 3 === 0) return createElement('text', { x, y, w: 160, h: 80, rotation, text: `Item ${i}`, fontSize: 32 });
    if (i % 3 === 1) return createElement('shape', { x, y, w: 160, h: 80, rotation, shape: i % 2 ? 'rect' : 'ellipse', strokeWidth: 2, stroke: '#2457d6' });
    return createElement('line', { x, y: y + 40, w: 160, h: 0, rotation });
  });
  const [slide] = deck.slides;
  return { ...deck, slides: [{ ...slide, elements }] };
}
