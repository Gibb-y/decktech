// Deck document model. See docs/arc42/05-building-block-view.md §5.2 and ADR-009 / ADR-010.
// All geometry is in logical stage units (1920x1080 by default).
import type { RichDoc } from './rich-text';

/** Reference to a named colour in `Theme.colors` (arc42 §8.7). */
export interface ColorToken {
  token: string;
}

/** A literal CSS colour (hex, rgb[a], hsl[a] or a keyword) or a theme token. */
export type Color = string | ColorToken;

export type Fill =
  | { kind: 'solid'; color: Color }
  | { kind: 'gradient'; angle: number; stops: { offset: number; color: Color }[] }
  | { kind: 'image'; assetId: string; fit: 'cover' | 'contain' | 'stretch' };

export interface Transition {
  type: 'none' | 'fade' | 'slide' | 'zoom';
  durationMs: number;
}

/** Logical stage size; either width 1920 or height 1080 (arc42 §8.1). */
export interface Stage {
  width: number;
  height: number;
}

/** Design tokens, referenced by name from elements and injected into code components as CSS variables. */
/** A font file kept as a deck asset and registered under `family` with `FontFace` (arc42 §8.7). */
export interface FontFaceRef {
  family: string;
  assetId: string;
}

export interface Theme {
  /** What the author called the theme in the theme editor; the picker shows it for a custom theme. */
  name?: string;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  typeScale: Record<string, number>;
  spacing: Record<string, number>;
  /** Embedded font files; the family names can be used in `fonts` stacks. */
  fontFaces?: FontFaceRef[];
}

export type PlaceholderKind = 'title' | 'body' | 'image' | 'footer';

export interface Placeholder {
  id: string;
  kind: PlaceholderKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  id: string;
  name: string;
  background?: Fill;
  placeholders: Placeholder[];
}

/** Metadata for a content-addressed blob held in the asset store. */
export interface AssetRef {
  blobKey: string;
  mime: string;
  hash: string;
  size: number;
}

export type Permission = 'network' | 'storage';

export type PropSpec =
  | {
      key: string;
      type: 'string' | 'number' | 'boolean' | 'color' | 'asset';
      label: string;
      default: unknown;
      min?: number;
      max?: number;
    }
  | {
      key: string;
      type: 'select';
      label: string;
      options: { value: string; label: string }[];
      default: string;
    };

export interface ComponentDef {
  id: string;
  name: string;
  html: string;
  css: string;
  js: string;
  propSchema: PropSpec[];
  permissions: Permission[];
  /** Asset ids the component may read with `deck.assets.url`. */
  files: string[];
  /** Vendored library asset ids. */
  libs: string[];
}

export interface ElementBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  locked?: boolean;
  hidden?: boolean;
  /** Appears at this step; 0 = always visible. */
  step?: number;
  /** Fills the placeholder of this kind in the slide's layout: a layout change moves it there (arc42 §8.7). */
  placeholder?: PlaceholderKind;
}

export interface TextEl extends ElementBase {
  type: 'text';
  /** Plain text. With `rich` it is only the mirror of that document (kept in sync by `SetText`). */
  text: string;
  /** Formatted content (ProseMirror JSON, ADR-004); the text element renders this instead of `text` when present. */
  rich?: RichDoc;
  /** Key into `Theme.fonts`; the theme body font when omitted. */
  font?: string;
  fontSize: number;
  /** Key into `Theme.typeScale`: when set, the size comes from the theme and `fontSize` is only the fallback (arc42 §8.7). */
  sizeToken?: string;
  color: Color;
  align: 'left' | 'center' | 'right';
}

export interface ImageEl extends ElementBase {
  type: 'image';
  assetId: string;
  alt: string;
  fit: 'cover' | 'contain' | 'stretch';
}

export interface ShapeEl extends ElementBase {
  type: 'shape';
  shape: 'rect' | 'ellipse' | 'triangle';
  fill?: Fill;
  stroke?: Color;
  strokeWidth: number;
}

export interface LineEl extends ElementBase {
  type: 'line';
  stroke: Color;
  strokeWidth: number;
}

export interface TableEl extends ElementBase {
  type: 'table';
  /** Plain-text cells; a non-empty rectangle (every row has the same number of cells). */
  rows: string[][];
  /** The first row is a header row (`<th scope="col">`). Absent means no header. */
  header?: boolean;
  /** Relative width of each column (positive numbers, one per column); equal widths when absent. */
  columnWidths?: number[];
  /** Background of each cell, `null` for none; same shape as `rows`. */
  cellFills?: (Color | null)[][];
}

export interface VideoEl extends ElementBase {
  type: 'video';
  /** A video asset (`video/mp4` or `video/webm`). */
  assetId: string;
  /** Starts playing when the element appears (presenting only). Browsers only allow this muted. */
  autoplay: boolean;
  loop: boolean;
  /** Silent playback; absent means with sound. */
  muted?: boolean;
  /** An image asset shown before playback, and in thumbnails and the editor. */
  poster?: string;
  /** Accessible name of the player. */
  label?: string;
}

export interface CodeEl extends ElementBase {
  type: 'code';
  /** References `Deck.components`; code itself lives only in the ComponentDef. */
  componentId: string;
  props: Record<string, unknown>;
}

export type Element = TextEl | ImageEl | ShapeEl | LineEl | TableEl | VideoEl | CodeEl;
export type ElementType = Element['type'];

export interface Slide {
  id: string;
  layoutId: string;
  /** Starts a named section of the deck; the section runs up to the next slide that has one. */
  section?: string;
  background?: Fill;
  /** Array order is z-order. */
  elements: Element[];
  notes: string;
  transition?: Transition;
}

export interface Deck {
  schemaVersion: number;
  id: string;
  title: string;
  stage: Stage;
  theme: Theme;
  layouts: Layout[];
  slides: Slide[];
  assets: Record<string, AssetRef>;
  components: ComponentDef[];
}
