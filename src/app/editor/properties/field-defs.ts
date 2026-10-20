import { ELEMENT_SCHEMAS, type Element, type ElementType, type FieldSpec } from '../../core/model';

/** Largest coordinate the document validator accepts (`validateDeck`); the panel never writes beyond it. */
export const MAX_COORDINATE = 1_000_000;

export type SectionId = 'geometry' | 'content' | 'text' | 'appearance' | 'arrange';

export const SECTION_LABELS: Record<SectionId, string> = {
  geometry: 'Position and size',
  content: 'Content',
  text: 'Text formatting',
  appearance: 'Fill and stroke',
  arrange: 'Arrangement',
};

/** How the panel edits a field. `number`, `text`, `textarea`, `checkbox` and `select` go through the form; `color` and `fill` have their own controls. */
export type Control = 'number' | 'text' | 'textarea' | 'checkbox' | 'select' | 'font' | 'color' | 'fill';

export interface FieldDef {
  key: string;
  label: string;
  control: Control;
  section: SectionId;
  min?: number;
  max?: number;
  /** Whole numbers only. */
  integer?: boolean;
  /** Choices of a `select`. */
  options?: readonly string[];
  /** The field may be left empty, which removes it. */
  optional?: boolean;
}

const LABELS: Record<string, string> = {
  x: 'X',
  y: 'Y',
  w: 'Width',
  h: 'Height',
  rotation: 'Rotation (degrees)',
  locked: 'Locked',
  hidden: 'Hidden',
  step: 'Appears at step',
  text: 'Text',
  fontSize: 'Font size',
  alt: 'Alt text',
  fit: 'Fit',
  strokeWidth: 'Stroke width',
};

/** "strokeWidth" → "Stroke width" for fields without an entry in `LABELS`. */
const humanize = (key: string): string => key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

/** Keys the panel places in a section of their own rather than under "Content". */
const SECTION_OF: Record<string, SectionId> = {
  text: 'text',
  color: 'text',
  font: 'text',
  fontSize: 'text',
  align: 'text',
  fill: 'appearance',
  stroke: 'appearance',
  strokeWidth: 'appearance',
};

/** Fields that exist on every element, in the order they are shown. */
export const BASE_FIELDS: readonly FieldDef[] = [
  { key: 'x', label: LABELS['x'], control: 'number', section: 'geometry', min: -MAX_COORDINATE, max: MAX_COORDINATE },
  { key: 'y', label: LABELS['y'], control: 'number', section: 'geometry', min: -MAX_COORDINATE, max: MAX_COORDINATE },
  { key: 'w', label: LABELS['w'], control: 'number', section: 'geometry', min: 0, max: MAX_COORDINATE },
  { key: 'h', label: LABELS['h'], control: 'number', section: 'geometry', min: 0, max: MAX_COORDINATE },
  { key: 'rotation', label: LABELS['rotation'], control: 'number', section: 'geometry', min: -MAX_COORDINATE, max: MAX_COORDINATE },
  { key: 'step', label: LABELS['step'], control: 'number', section: 'arrange', min: 0, max: 1_000, integer: true, optional: true },
  { key: 'hidden', label: LABELS['hidden'], control: 'checkbox', section: 'arrange', optional: true },
  { key: 'locked', label: LABELS['locked'], control: 'checkbox', section: 'arrange', optional: true },
];

/** The panel control for one schema field, or `undefined` for kinds that have no inline editor (asset, component, table, props). */
function controlFor(key: string, spec: FieldSpec): FieldDef | undefined {
  const base = { key, label: LABELS[key] ?? humanize(key), section: SECTION_OF[key] ?? 'content' } satisfies Partial<FieldDef>;
  const optional = spec.optional === true;
  switch (spec.kind) {
    case 'number':
      return { ...base, control: 'number', min: spec.min, max: spec.max ?? MAX_COORDINATE, optional };
    case 'string':
      return { ...base, control: spec.long ? 'textarea' : 'text', optional };
    case 'boolean':
      return { ...base, control: 'checkbox', optional };
    case 'enum':
      return { ...base, control: 'select', options: spec.values, optional };
    case 'font':
      return { ...base, control: 'font', optional: true };
    case 'color':
      return { ...base, control: 'color', optional };
    case 'fill':
      return { ...base, control: 'fill', optional };
    case 'asset':
    case 'component':
    case 'table':
    case 'props':
      return undefined;
  }
}

/**
 * The editable fields of an element type, taken from `ELEMENT_SCHEMAS`: a new element type
 * appears in the panel with its schema entry alone (quality scenario Q13).
 */
export function typeFields(type: ElementType): FieldDef[] {
  return Object.entries(ELEMENT_SCHEMAS[type].fields).flatMap(([key, spec]) => controlFor(key, spec) ?? []);
}

/** Every field of an element: shared ones first, then those of its type. */
export function fieldsOf(element: Element): FieldDef[] {
  return [...BASE_FIELDS, ...typeFields(element.type)];
}

/** Fields grouped into the sections the panel shows, in display order, skipping empty ones. */
export function sectionsOf(fields: readonly FieldDef[]): { id: SectionId; label: string; fields: FieldDef[] }[] {
  const order: SectionId[] = ['geometry', 'text', 'content', 'appearance', 'arrange'];
  return order.flatMap((id) => {
    const inSection = fields.filter((f) => f.section === id);
    return inSection.length > 0 ? [{ id, label: SECTION_LABELS[id], fields: inSection }] : [];
  });
}
