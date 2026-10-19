import { SCHEMA_VERSION } from './constants';
import { ID_PATTERN } from './ids';
import { err, ok, type Result } from './result';
import type { Deck } from './types';

export interface ValidationError {
  /** Location of the problem, e.g. `slides[2].elements[0].w`. */
  path: string;
  message: string;
}

export interface ValidationLimits {
  maxStringLength: number;
  maxArrayLength: number;
  maxSlides: number;
  maxElementsPerSlide: number;
  maxComponents: number;
  maxAssets: number;
  maxTableCells: number;
  maxPropsDepth: number;
}

export const DEFAULT_VALIDATION_LIMITS: ValidationLimits = {
  maxStringLength: 1_000_000,
  maxArrayLength: 10_000,
  maxSlides: 2_000,
  maxElementsPerSlide: 2_000,
  maxComponents: 500,
  maxAssets: 5_000,
  maxTableCells: 10_000,
  maxPropsDepth: 16,
};

const MAX_SHORT_STRING = 1_000;
const MAX_COORDINATE = 1_000_000;
const MAX_STEP = 1_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const ELEMENT_TYPES = ['text', 'image', 'shape', 'line', 'table', 'video', 'code'] as const;
const FITS = ['cover', 'contain', 'stretch'] as const;
const PERMISSIONS = ['network', 'storage'] as const;
const PLACEHOLDER_KINDS = ['title', 'body', 'image', 'footer'] as const;
const TRANSITIONS = ['none', 'fade', 'slide', 'zoom'] as const;
const PROP_TYPES = ['string', 'number', 'boolean', 'color', 'asset', 'select'] as const;
const SHAPES = ['rect', 'ellipse', 'triangle'] as const;
const ALIGNS = ['left', 'center', 'right'] as const;

type Ref = { path: string; id: string };

/**
 * Validates untrusted input (import, storage) as a `Deck`. Collects every problem instead of
 * stopping at the first. On success the input object itself is returned, typed.
 */
export function validateDeck(
  input: unknown,
  limits: Partial<ValidationLimits> = {},
): Result<Deck, ValidationError[]> {
  const v = new Validator({ ...DEFAULT_VALIDATION_LIMITS, ...limits });
  v.deck(input);
  return v.errors.length === 0 ? ok(input as Deck) : err(v.errors);
}

class Validator {
  readonly errors: ValidationError[] = [];

  private readonly layoutIds = new Set<string>();
  private readonly componentIds = new Set<string>();
  private readonly assetIds = new Set<string>();
  private readonly elementIds = new Set<string>();
  private readonly layoutRefs: Ref[] = [];
  private readonly componentRefs: Ref[] = [];
  private readonly assetRefs: Ref[] = [];

  constructor(private readonly limits: ValidationLimits) {}

  deck(input: unknown): void {
    const d = this.record('', input);
    if (!d) return;

    if (d['schemaVersion'] !== SCHEMA_VERSION) {
      this.fail('schemaVersion', `must be ${SCHEMA_VERSION}`);
    }
    this.id('id', d['id']);
    this.string('title', d['title'], MAX_SHORT_STRING);
    this.theme('theme', d['theme']);

    this.assets('assets', d['assets']);
    const layouts = this.array('layouts', d['layouts'], this.limits.maxArrayLength);
    layouts?.forEach((l, i) => this.layout(`layouts[${i}]`, l));
    const components = this.array('components', d['components'], this.limits.maxComponents);
    components?.forEach((c, i) => this.component(`components[${i}]`, c));
    const slides = this.array('slides', d['slides'], this.limits.maxSlides);
    const slideIds = new Set<string>();
    slides?.forEach((s, i) => this.slide(`slides[${i}]`, s, slideIds));

    this.resolve(this.layoutRefs, this.layoutIds, 'layout');
    this.resolve(this.componentRefs, this.componentIds, 'component');
    this.resolve(this.assetRefs, this.assetIds, 'asset');
  }

  // --- structures -------------------------------------------------------------------------

  private theme(path: string, value: unknown): void {
    const t = this.record(path, value);
    if (!t) return;
    for (const key of ['colors', 'fonts'] as const) {
      this.map(`${path}.${key}`, t[key], (p, x) => this.string(p, x, MAX_SHORT_STRING));
    }
    for (const key of ['typeScale', 'spacing'] as const) {
      this.map(`${path}.${key}`, t[key], (p, x) => this.number(p, x, { min: 0, max: MAX_COORDINATE }));
    }
  }

  private assets(path: string, value: unknown): void {
    this.map(path, value, (p, a, key) => {
      if (ID_PATTERN.test(key)) this.assetIds.add(key);
      else this.fail(p, 'asset key is not a valid id');
      const r = this.record(p, a);
      if (!r) return;
      this.string(`${p}.blobKey`, r['blobKey'], MAX_SHORT_STRING, 1);
      this.string(`${p}.mime`, r['mime'], MAX_SHORT_STRING, 1);
      this.string(`${p}.hash`, r['hash'], MAX_SHORT_STRING, 1);
      this.number(`${p}.size`, r['size'], { min: 0, int: true });
    });
  }

  private layout(path: string, value: unknown): void {
    const l = this.record(path, value);
    if (!l) return;
    this.unique(`${path}.id`, l['id'], this.layoutIds, 'layout');
    this.string(`${path}.name`, l['name'], MAX_SHORT_STRING);
    if (l['background'] !== undefined) this.fill(`${path}.background`, l['background']);
    const placeholders = this.array(`${path}.placeholders`, l['placeholders'], this.limits.maxArrayLength);
    placeholders?.forEach((ph, i) => {
      const p = `${path}.placeholders[${i}]`;
      const r = this.record(p, ph);
      if (!r) return;
      this.id(`${p}.id`, r['id']);
      this.oneOf(`${p}.kind`, r['kind'], PLACEHOLDER_KINDS);
      this.geometry(p, r);
    });
  }

  private component(path: string, value: unknown): void {
    const c = this.record(path, value);
    if (!c) return;
    this.unique(`${path}.id`, c['id'], this.componentIds, 'component');
    this.string(`${path}.name`, c['name'], MAX_SHORT_STRING);
    for (const key of ['html', 'css', 'js'] as const) {
      this.string(`${path}.${key}`, c[key], this.limits.maxStringLength, 0);
    }
    const specs = this.array(`${path}.propSchema`, c['propSchema'], this.limits.maxArrayLength);
    const keys = new Set<string>();
    specs?.forEach((s, i) => this.propSpec(`${path}.propSchema[${i}]`, s, keys));
    this.array(`${path}.permissions`, c['permissions'], PERMISSIONS.length)?.forEach((perm, i) =>
      this.oneOf(`${path}.permissions[${i}]`, perm, PERMISSIONS),
    );
    for (const key of ['files', 'libs'] as const) {
      this.array(`${path}.${key}`, c[key], this.limits.maxArrayLength)?.forEach((a, i) => {
        if (this.id(`${path}.${key}[${i}]`, a)) {
          this.assetRefs.push({ path: `${path}.${key}[${i}]`, id: a as string });
        }
      });
    }
  }

  private propSpec(path: string, value: unknown, keys: Set<string>): void {
    const s = this.record(path, value);
    if (!s) return;
    if (this.string(`${path}.key`, s['key'], MAX_SHORT_STRING, 1) && !this.safeKey(`${path}.key`, s['key'] as string)) {
      return;
    }
    if (keys.has(s['key'] as string)) this.fail(`${path}.key`, 'duplicate prop key');
    else if (typeof s['key'] === 'string') keys.add(s['key']);
    this.string(`${path}.label`, s['label'], MAX_SHORT_STRING);
    if (!this.oneOf(`${path}.type`, s['type'], PROP_TYPES)) return;
    if (s['type'] === 'select') {
      const options = this.array(`${path}.options`, s['options'], this.limits.maxArrayLength);
      options?.forEach((o, i) => {
        const r = this.record(`${path}.options[${i}]`, o);
        if (!r) return;
        this.string(`${path}.options[${i}].value`, r['value'], MAX_SHORT_STRING);
        this.string(`${path}.options[${i}].label`, r['label'], MAX_SHORT_STRING);
      });
      this.string(`${path}.default`, s['default'], MAX_SHORT_STRING);
    } else {
      this.jsonValue(`${path}.default`, s['default'], 0);
      for (const bound of ['min', 'max'] as const) {
        if (s[bound] !== undefined) this.number(`${path}.${bound}`, s[bound]);
      }
    }
  }

  private slide(path: string, value: unknown, slideIds: Set<string>): void {
    const s = this.record(path, value);
    if (!s) return;
    this.unique(`${path}.id`, s['id'], slideIds, 'slide');
    if (this.id(`${path}.layoutId`, s['layoutId'])) {
      this.layoutRefs.push({ path: `${path}.layoutId`, id: s['layoutId'] as string });
    }
    if (s['background'] !== undefined) this.fill(`${path}.background`, s['background']);
    this.string(`${path}.notes`, s['notes'], this.limits.maxStringLength, 0);
    if (s['transition'] !== undefined) this.transition(`${path}.transition`, s['transition']);
    const elements = this.array(`${path}.elements`, s['elements'], this.limits.maxElementsPerSlide);
    elements?.forEach((e, i) => this.element(`${path}.elements[${i}]`, e));
  }

  private transition(path: string, value: unknown): void {
    const t = this.record(path, value);
    if (!t) return;
    this.oneOf(`${path}.type`, t['type'], TRANSITIONS);
    this.number(`${path}.durationMs`, t['durationMs'], { min: 0, max: 60_000 });
  }

  private fill(path: string, value: unknown): void {
    const f = this.record(path, value);
    if (!f) return;
    switch (f['kind']) {
      case 'solid':
        this.string(`${path}.color`, f['color'], MAX_SHORT_STRING);
        break;
      case 'gradient':
        this.number(`${path}.angle`, f['angle']);
        this.array(`${path}.stops`, f['stops'], 64)?.forEach((st, i) => {
          const r = this.record(`${path}.stops[${i}]`, st);
          if (!r) return;
          this.number(`${path}.stops[${i}].offset`, r['offset'], { min: 0, max: 1 });
          this.string(`${path}.stops[${i}].color`, r['color'], MAX_SHORT_STRING);
        });
        break;
      case 'image':
        this.assetRef(`${path}.assetId`, f['assetId']);
        this.oneOf(`${path}.fit`, f['fit'], FITS);
        break;
      default:
        this.fail(`${path}.kind`, 'must be one of: solid, gradient, image');
    }
  }

  private element(path: string, value: unknown): void {
    const e = this.record(path, value);
    if (!e) return;
    this.unique(`${path}.id`, e['id'], this.elementIds, 'element');
    this.geometry(path, e);
    this.number(`${path}.rotation`, e['rotation'], { min: -MAX_COORDINATE, max: MAX_COORDINATE });
    for (const flag of ['locked', 'hidden'] as const) {
      if (e[flag] !== undefined) this.boolean(`${path}.${flag}`, e[flag]);
    }
    if (e['step'] !== undefined) this.number(`${path}.step`, e['step'], { min: 0, max: MAX_STEP, int: true });

    if (!this.oneOf(`${path}.type`, e['type'], ELEMENT_TYPES)) return;
    switch (e['type']) {
      case 'text':
        this.string(`${path}.text`, e['text'], this.limits.maxStringLength, 0);
        this.number(`${path}.fontSize`, e['fontSize'], { min: 0, max: MAX_COORDINATE });
        this.string(`${path}.color`, e['color'], MAX_SHORT_STRING);
        this.oneOf(`${path}.align`, e['align'], ALIGNS);
        break;
      case 'image':
        this.assetRef(`${path}.assetId`, e['assetId']);
        this.string(`${path}.alt`, e['alt'], MAX_SHORT_STRING, 0);
        this.oneOf(`${path}.fit`, e['fit'], FITS);
        break;
      case 'shape':
        this.oneOf(`${path}.shape`, e['shape'], SHAPES);
        if (e['fill'] !== undefined) this.fill(`${path}.fill`, e['fill']);
        if (e['stroke'] !== undefined) this.string(`${path}.stroke`, e['stroke'], MAX_SHORT_STRING);
        this.number(`${path}.strokeWidth`, e['strokeWidth'], { min: 0, max: MAX_COORDINATE });
        break;
      case 'line':
        this.string(`${path}.stroke`, e['stroke'], MAX_SHORT_STRING);
        this.number(`${path}.strokeWidth`, e['strokeWidth'], { min: 0, max: MAX_COORDINATE });
        break;
      case 'table':
        this.table(`${path}.rows`, e['rows']);
        break;
      case 'video':
        this.assetRef(`${path}.assetId`, e['assetId']);
        this.boolean(`${path}.autoplay`, e['autoplay']);
        this.boolean(`${path}.loop`, e['loop']);
        break;
      case 'code':
        if (this.id(`${path}.componentId`, e['componentId'])) {
          this.componentRefs.push({ path: `${path}.componentId`, id: e['componentId'] as string });
        }
        this.props(`${path}.props`, e['props']);
        break;
    }
  }

  private table(path: string, value: unknown): void {
    const rows = this.array(path, value, this.limits.maxArrayLength);
    let cells = 0;
    rows?.forEach((row, r) => {
      const cols = this.array(`${path}[${r}]`, row, this.limits.maxArrayLength);
      cells += cols?.length ?? 0;
      cols?.forEach((cell, c) => this.string(`${path}[${r}][${c}]`, cell, this.limits.maxStringLength, 0));
    });
    if (cells > this.limits.maxTableCells) {
      this.fail(path, `has more than ${this.limits.maxTableCells} cells`);
    }
  }

  private props(path: string, value: unknown): void {
    const p = this.record(path, value);
    if (!p) return;
    this.jsonValue(path, p, 0);
  }

  // --- primitives -------------------------------------------------------------------------

  private fail(path: string, message: string): false {
    this.errors.push({ path, message });
    return false;
  }

  private record(path: string, value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, 'must be an object');
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  private array(path: string, value: unknown, max: number): unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.fail(path, 'must be an array');
      return undefined;
    }
    if (value.length > max) {
      this.fail(path, `must have at most ${max} items`);
      return undefined;
    }
    return value;
  }

  private string(path: string, value: unknown, max: number, min = 0): boolean {
    if (typeof value !== 'string') return this.fail(path, 'must be a string');
    if (value.length > max) return this.fail(path, `must be at most ${max} characters`);
    if (value.length < min) return this.fail(path, `must be at least ${min} character(s)`);
    return true;
  }

  private number(path: string, value: unknown, opts: { min?: number; max?: number; int?: boolean } = {}): boolean {
    if (typeof value !== 'number' || !Number.isFinite(value)) return this.fail(path, 'must be a finite number');
    if (opts.int && !Number.isInteger(value)) return this.fail(path, 'must be an integer');
    if (opts.min !== undefined && value < opts.min) return this.fail(path, `must be >= ${opts.min}`);
    if (opts.max !== undefined && value > opts.max) return this.fail(path, `must be <= ${opts.max}`);
    return true;
  }

  private boolean(path: string, value: unknown): boolean {
    return typeof value === 'boolean' || this.fail(path, 'must be a boolean');
  }

  private oneOf(path: string, value: unknown, allowed: readonly string[]): boolean {
    if (typeof value === 'string' && allowed.includes(value)) return true;
    return this.fail(path, `must be one of: ${allowed.join(', ')}`);
  }

  private id(path: string, value: unknown): boolean {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      return this.fail(path, 'must be an id (1-128 chars of A-Z a-z 0-9 _ -)');
    }
    return true;
  }

  private unique(path: string, value: unknown, seen: Set<string>, what: string): void {
    if (!this.id(path, value)) return;
    if (seen.has(value as string)) this.fail(path, `duplicate ${what} id "${value as string}"`);
    else seen.add(value as string);
  }

  private safeKey(path: string, key: string): boolean {
    return !FORBIDDEN_KEYS.has(key) || this.fail(path, `key "${key}" is not allowed`);
  }

  /** Validates a string-keyed object, applying `check` to each value. */
  private map(path: string, value: unknown, check: (path: string, value: unknown, key: string) => void): void {
    const r = this.record(path, value);
    if (!r) return;
    const keys = Object.keys(r);
    if (keys.length > this.limits.maxAssets) {
      this.fail(path, `must have at most ${this.limits.maxAssets} entries`);
      return;
    }
    for (const key of keys) {
      const p = `${path}.${key}`;
      if (this.safeKey(p, key)) check(p, r[key], key);
    }
  }

  /** Per-instance props must be plain JSON: finite numbers, bounded size and depth. */
  private jsonValue(path: string, value: unknown, depth: number): void {
    if (depth > this.limits.maxPropsDepth) {
      this.fail(path, `is nested deeper than ${this.limits.maxPropsDepth} levels`);
      return;
    }
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') {
      this.string(path, value, this.limits.maxStringLength);
    } else if (typeof value === 'number') {
      this.number(path, value);
    } else if (Array.isArray(value)) {
      const items = this.array(path, value, this.limits.maxArrayLength);
      items?.forEach((item, i) => this.jsonValue(`${path}[${i}]`, item, depth + 1));
    } else if (typeof value === 'object') {
      this.map(path, value, (p, x) => this.jsonValue(p, x, depth + 1));
    } else {
      this.fail(path, 'must be JSON-serialisable');
    }
  }

  private geometry(path: string, r: Record<string, unknown>): void {
    this.number(`${path}.x`, r['x'], { min: -MAX_COORDINATE, max: MAX_COORDINATE });
    this.number(`${path}.y`, r['y'], { min: -MAX_COORDINATE, max: MAX_COORDINATE });
    this.number(`${path}.w`, r['w'], { min: 0, max: MAX_COORDINATE });
    this.number(`${path}.h`, r['h'], { min: 0, max: MAX_COORDINATE });
  }

  private assetRef(path: string, value: unknown): void {
    if (this.id(path, value)) this.assetRefs.push({ path, id: value as string });
  }

  private resolve(refs: Ref[], known: Set<string>, what: string): void {
    for (const ref of refs) {
      if (!known.has(ref.id)) this.fail(ref.path, `references unknown ${what} "${ref.id}"`);
    }
  }
}
