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
  /** Id in `Deck.assets`. */
  | { kind: 'asset' }
  /** Id in `Deck.components`. */
  | { kind: 'component' }
  | { kind: 'table' }
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
      font: { kind: 'font', optional: true },
      fontSize: { kind: 'number', min: 0 },
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
    fields: { rows: { kind: 'table' } },
    defaults: { rows: [['', ''], ['', '']] },
  },
  video: {
    fields: {
      assetId: { kind: 'asset' },
      autoplay: { kind: 'boolean' },
      loop: { kind: 'boolean' },
    },
    defaults: { assetId: '', autoplay: false, loop: false },
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
export const ELEMENT_BASE_KEYS = ['id', 'type', 'x', 'y', 'w', 'h', 'rotation', 'locked', 'hidden', 'step'] as const;
