import type { Theme } from './types';

export interface BuiltInTheme {
  id: string;
  name: string;
  theme: Theme;
}

const SHARED = {
  fonts: { heading: 'sans-serif', body: 'sans-serif', mono: 'monospace' },
  typeScale: { title: 96, heading: 64, body: 40, caption: 28 },
  spacing: { sm: 16, md: 32, lg: 64 },
} as const;

const make = (colors: Theme['colors']): Theme => structuredClone({ colors, ...SHARED }) as Theme;

/**
 * The themes the editor offers (arc42 §8.7). Every text colour reaches WCAG AA (4.5:1) on the
 * theme's background; `themes.spec.ts` checks it. Both define the same token names, so switching
 * between them never leaves an element pointing at a missing token.
 */
export const BUILT_IN_THEMES: readonly BuiltInTheme[] = [
  { id: 'light', name: 'Light', theme: make({ background: '#ffffff', text: '#111111', muted: '#4d5560', accent: '#2457d6' }) },
  { id: 'dark', name: 'Dark', theme: make({ background: '#14161a', text: '#f2f4f8', muted: '#b4bac6', accent: '#8ab4ff' }) },
];

/** Colour tokens every theme must define: the renderer's defaults (slide background, text) use them. */
export const REQUIRED_COLOR_TOKENS = ['background', 'text'] as const;
/** Font keys every theme must define: elements without a font use `body`. */
export const REQUIRED_FONT_KEYS = ['body'] as const;

/** A copy of a built-in theme (decks own their theme; it is never shared by reference). */
export const createTheme = (id: string = 'light'): Theme => structuredClone((BUILT_IN_THEMES.find((t) => t.id === id) ?? BUILT_IN_THEMES[0]).theme);
