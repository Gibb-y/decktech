import { LITERAL_COLOR, type Color, type Fill, type Theme } from '../core/model';

const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
/** Font stacks end up in a custom property; refuse anything that is not a plain family list. */
const UNSAFE_FONT = /[;{}<>\\]|url\s*\(|expression\s*\(|\/\*/i;

/** Custom property name for a theme entry (`--deck-color-accent`, `--deck-font-body`, ...). */
export const themeVar = (group: 'color' | 'font' | 'type' | 'space', key: string): string =>
  `--deck-${group}-${key}`;

/**
 * Theme tokens as CSS custom properties for the stage (arc42 §8.7). Keys or values that could
 * not be written safely are skipped; the elements then fall back to their defaults.
 */
export function themeVars(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  const own = (map: object): [string, unknown][] => Object.entries(map);
  for (const [key, value] of own(theme.colors)) {
    if (SAFE_KEY.test(key) && typeof value === 'string' && LITERAL_COLOR.test(value)) vars[themeVar('color', key)] = value;
  }
  for (const [key, value] of own(theme.fonts)) {
    if (SAFE_KEY.test(key) && typeof value === 'string' && !UNSAFE_FONT.test(value)) vars[themeVar('font', key)] = value;
  }
  for (const [key, value] of own(theme.typeScale)) {
    if (SAFE_KEY.test(key) && Number.isFinite(value)) vars[themeVar('type', key)] = `${value as number}px`;
  }
  for (const [key, value] of own(theme.spacing)) {
    if (SAFE_KEY.test(key) && Number.isFinite(value)) vars[themeVar('space', key)] = `${value as number}px`;
  }
  return vars;
}

const hasOwn = (map: object, key: string): boolean => Object.prototype.hasOwnProperty.call(map, key);

/**
 * CSS for a colour: a `var()` for a theme token, the literal itself when it is a plain colour,
 * otherwise `null`. Commands do not check structured values (arc42 §8.4), so this must not pass
 * arbitrary strings on into style declarations.
 */
export function resolveColor(color: Color | undefined, theme: Theme): string | null {
  if (color === undefined || color === null) return null;
  if (typeof color === 'string') return LITERAL_COLOR.test(color) ? color : null;
  const key = color.token;
  return typeof key === 'string' && SAFE_KEY.test(key) && hasOwn(theme.colors, key) ? `var(${themeVar('color', key)})` : null;
}

/** Font stack for a `Theme.fonts` key; the theme body font when absent or unknown. */
export function resolveFont(font: string | undefined, theme: Theme): string {
  const key = font !== undefined && SAFE_KEY.test(font) && hasOwn(theme.fonts, font) ? font : 'body';
  return `var(${themeVar('font', key)}, sans-serif)`;
}

const FIT_SIZE = { cover: 'cover', contain: 'contain', stretch: '100% 100%' } as const;

/** Style declarations for a fill. `assetUrl` supplies the object URL for image fills. */
export function fillStyle(
  fill: Fill | undefined,
  theme: Theme,
  assetUrl: (assetId: string) => string | null,
): Record<string, string> {
  if (!fill) return {};
  switch (fill.kind) {
    case 'solid': {
      const color = resolveColor(fill.color, theme);
      return color ? { 'background-color': color } : {};
    }
    case 'gradient': {
      const angle = Number.isFinite(fill.angle) ? fill.angle : 180;
      const stops = fill.stops.flatMap((stop) => {
        const color = resolveColor(stop.color, theme);
        return color && Number.isFinite(stop.offset) ? [`${color} ${stop.offset * 100}%`] : [];
      });
      return stops.length >= 2 ? { 'background-image': `linear-gradient(${angle}deg, ${stops.join(', ')})` } : {};
    }
    case 'image': {
      const url = assetUrl(fill.assetId);
      const size = FIT_SIZE[fill.fit] ?? FIT_SIZE.cover;
      return url
        ? { 'background-image': `url("${url}")`, 'background-size': size, 'background-position': 'center', 'background-repeat': 'no-repeat' }
        : {};
    }
  }
}
