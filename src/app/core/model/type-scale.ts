import type { TextEl, Theme } from './types';

/**
 * The size a text element is drawn at: the theme's `typeScale` entry its `sizeToken` names, else
 * its own `fontSize` (also when the token has gone, so a stale reference never hides the text).
 */
export function effectiveFontSize(el: Pick<TextEl, 'fontSize' | 'sizeToken'>, theme: Pick<Theme, 'typeScale'>): number {
  if (el.sizeToken !== undefined && Object.hasOwn(theme.typeScale, el.sizeToken)) return theme.typeScale[el.sizeToken];
  return el.fontSize;
}
