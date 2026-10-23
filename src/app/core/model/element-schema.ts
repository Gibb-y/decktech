import type { ElementType } from './types';

/**
 * Declarative description of one element-specific field. The validator interprets these, so
 * adding an element type means one entry in `ELEMENT_SCHEMAS` (plus its type in `types.ts`),
 * see arc42 quality scenario Q13.
 */
export type FieldSpec = { optional?: boolean } & (
  | { kind: 'string'; long?: boolean; min?: number }
  | { kind: 'number'; min?: number; max?: number }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'color' }
  | { kind: 'fill' }
  /** Key into `Theme.fonts`. */
  | { kind: 'font' }
  /** Key into `Theme.typeScale`. */
  | { kind: 'sizeToken' }
  /** Id in `Deck.assets`. */
  | { kind: 'asset' }
  /** Id in `Deck.components`. */
  | { kind: 'component' }
  | { kind: 'table' }
  /** One positive relative width per column of the element's `rows`. */
  | { kind: 'columnWidths' }
  /** One colour or `null` per cell of the element's `rows`. */
  | { kind: 'cellFills' }
  /** Restricted ProseMirror JSON, see `rich-text.ts`. */
  | { kind: 'rich' }
  | { kind: 'props' }
);

export interface ElementSchema {
  fields: Record<string, FieldSpec>;
  /** Values `createElement` starts from, on top of the shared geometry defaults. */
  defaults: Record<string, unknown>;
}

const FITS = ['cover', 'contain', 'stretch'] as const;
const ALIGNS = ['left', 'center', 'right'] as const;
const SHAPES = ['rect', 'ellipse', 'triangle'] as const;

export const ELEMENT_SCHEMAS: Record<ElementType, ElementSchema> = {
  text: {
    fields: {
      text: { kind: 'string', long: true },
      rich: { kind: 'rich', optional: true },
      font: { kind: 'font', optional: true },
      fontSize: { kind: 'number', min: 0 },
      sizeToken: { kind: 'sizeToken', optional: true },
      color: { kind: 'color' },
      align: { kind: 'enum', values: ALIGNS },
    },
    defaults: { h: 160, text: '', fontSize: 40, color: { token: 'text' }, align: 'left' },
  },
  image: {
    fields: {
      assetId: { kind: 'asset' },
      alt: { kind: 'string' },
      fit: { kind: 'enum', values: FITS },
    },
    defaults: { assetId: '', alt: '', fit: 'contain' },
  },
  shape: {
    fields: {
      shape: { kind: 'enum', values: SHAPES },
      fill: { kind: 'fill', optional: true },
      stroke: { kind: 'color', optional: true },
      strokeWidth: { kind: 'number', min: 0 },
    },
    defaults: { shape: 'rect', fill: { kind: 'solid', color: { token: 'accent' } }, strokeWidth: 0 },
  },
  line: {
    fields: {
      stroke: { kind: 'color' },
      strokeWidth: { kind: 'number', min: 0 },
    },
    defaults: { h: 0, stroke: { token: 'text' }, strokeWidth: 4 },
  },
  table: {
    fields: {
      rows: { kind: 'table' },
      header: { kind: 'boolean', optional: true },
      columnWidths: { kind: 'columnWidths', optional: true },
      cellFills: { kind: 'cellFills', optional: true },
    },
    defaults: { h: 240, rows: [['', ''], ['', '']], header: true },
  },
  video: {
    fields: {
      assetId: { kind: 'asset' },
      poster: { kind: 'asset', optional: true },
      autoplay: { kind: 'boolean' },
      loop: { kind: 'boolean' },
      muted: { kind: 'boolean', optional: true },
      label: { kind: 'string', optional: true },
    },
    defaults: { assetId: '', autoplay: false, loop: false, muted: false },
  },
  code: {
    fields: {
      componentId: { kind: 'component' },
      props: { kind: 'props' },
    },
    defaults: { componentId: '', props: {} },
  },
};

export const ELEMENT_TYPES = Object.keys(ELEMENT_SCHEMAS) as ElementType[];

/** Fields shared by every element (`ElementBase`) plus the discriminator. */
export const ELEMENT_BASE_KEYS = ['id', 'type', 'x', 'y', 'w', 'h', 'rotation', 'locked', 'hidden', 'step', 'placeholder'] as const;
