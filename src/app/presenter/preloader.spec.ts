import { createElement, createSlide, type Slide } from '../core/model';
import { PRELOAD_DISTANCE } from '../renderer';
import { hasCode, slidesToMount } from './preloader';

const plain = (): Slide => createSlide('layout');
const withCode = (hidden?: boolean): Slide => ({ ...createSlide('layout'), elements: [createElement('code', { hidden })] });

describe('slidesToMount', () => {
  it('keeps the shown slide even when it is the only one', () => {
    const slides = [plain()];
    expect(slidesToMount(slides, 0)).toEqual([{ slide: slides[0], index: 0, distance: 0 }]);
  });

  it('keeps neighbours with code components, with their distance', () => {
    const slides = [withCode(), plain(), withCode(), withCode(), plain()];
    expect(slidesToMount(slides, 2).map(({ index, distance }) => [index, distance])).toEqual([[2, 0], [3, 1]]);
    expect(slidesToMount(slides, 1).map(({ index, distance }) => [index, distance])).toEqual([[0, 1], [1, 0], [2, 1]]);
  });

  it('leaves out neighbours that are cheap to draw on demand', () => {
    const slides = [plain(), plain(), plain()];
    expect(slidesToMount(slides, 1).map((m) => m.index)).toEqual([1]);
  });

  it('never keeps a slide farther than the preload distance', () => {
    const slides = Array.from({ length: 7 }, withCode);
    for (let current = 0; current < slides.length; current++) {
      const mounted = slidesToMount(slides, current);
      expect(mounted.every((m) => Math.abs(m.index - current) <= PRELOAD_DISTANCE)).toBe(true);
      expect(mounted.length).toBeLessThanOrEqual(2 * PRELOAD_DISTANCE + 1);
    }
  });

  it('does not preload a slide whose code is hidden, since nothing of it is drawn', () => {
    const slides = [plain(), withCode(true)];
    expect(slidesToMount(slides, 0).map((m) => m.index)).toEqual([0]);
    expect(hasCode(slides[1])).toBe(false);
  });

  it('copes with a position outside the deck', () => {
    const slides = [withCode(), withCode()];
    expect(slidesToMount([], 0)).toEqual([]);
    expect(slidesToMount(slides, 9)).toEqual([]);
  });
});
