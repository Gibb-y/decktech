// Deck document model. See docs/arc42/05-building-block-view.md §5.2 and ADR-009 / ADR-010.
// All geometry is in logical stage units (1920x1080 by default).

export type Fill =
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; angle: number; stops: { offset: number; color: string }[] }
  | { kind: 'image'; assetId: string; fit: 'cover' | 'contain' | 'stretch' };

export interface Transition {
  type: 'none' | 'fade' | 'slide' | 'zoom';
  durationMs: number;
}

/** Design tokens, referenced by name from elements and injected into code components as CSS variables. */
export interface Theme {
  colors: Record<string, string>;
  fonts: Record<string, string>;
  typeScale: Record<string, number>;
  spacing: Record<string, number>;
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
  /** Asset ids addressable by relative URL. */
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
}

export interface TextEl extends ElementBase {
  type: 'text';
  text: string;
  fontSize: number;
  color: string;
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
  stroke?: string;
  strokeWidth: number;
}

export interface LineEl extends ElementBase {
  type: 'line';
  stroke: string;
  strokeWidth: number;
}

export interface TableEl extends ElementBase {
  type: 'table';
  rows: string[][];
}

export interface VideoEl extends ElementBase {
  type: 'video';
  assetId: string;
  autoplay: boolean;
  loop: boolean;
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
  theme: Theme;
  layouts: Layout[];
  slides: Slide[];
  assets: Record<string, AssetRef>;
  components: ComponentDef[];
}
