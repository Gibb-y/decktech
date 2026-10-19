import type { ElementBase } from '../core/model';

export type RenderMode = 'edit' | 'present' | 'thumbnail';

/** Every step revealed; the default for thumbnails and export. */
export const ALL_STEPS = Number.POSITIVE_INFINITY;

/**
 * Whether an element is part of the output. Presenting and thumbnails omit hidden and not yet
 * reached elements entirely (not just visually), so they are also out of the accessibility tree.
 * The editor keeps every element so it can be selected; hidden ones are marked by the renderer.
 */
export function isElementShown(element: ElementBase, mode: RenderMode, step: number): boolean {
  if (mode === 'edit') return true;
  return element.hidden !== true && (element.step ?? 0) <= step;
}
