// WCAG 2.x contrast for the colour literals the built-in themes use (hex only). arc42 §8.8.

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Relative luminance of a `#rgb` / `#rrggbb` colour, or `null` for anything else. */
export function relativeLuminance(color: string): number | null {
  const m = HEX.exec(color);
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two hex colours (1 to 21); `NaN` when either is not a hex colour. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return NaN;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for normal text. */
export const AA_TEXT_CONTRAST = 4.5;

/** Colour tokens whose contrast against the theme's `background` the theme editor reports. */
export const CONTRAST_TOKENS = ['text', 'muted', 'accent'] as const;

export interface ContrastCheck {
  token: string;
  /** Ratio against the background, or `null` when either colour is not a hex literal (not measurable here). */
  ratio: number | null;
  /** `null` when the ratio is unknown. */
  passes: boolean | null;
}

/** Contrast of the text, muted and accent colours the theme defines against its background (arc42 §8.7, §8.8). */
export function themeContrast(theme: { colors: Readonly<Record<string, string>> }): ContrastCheck[] {
  const background = Object.hasOwn(theme.colors, 'background') ? theme.colors['background'] : undefined;
  return CONTRAST_TOKENS.filter((token) => Object.hasOwn(theme.colors, token)).map((token) => {
    const ratio = background === undefined ? NaN : contrastRatio(theme.colors[token], background);
    return Number.isNaN(ratio) ? { token, ratio: null, passes: null } : { token, ratio, passes: ratio >= AA_TEXT_CONTRAST };
  });
}
