import { MAX_STAGE_SIZE, SCHEMA_VERSION, STAGE_HEIGHT, STAGE_WIDTH } from './constants';
import { ELEMENT_BASE_KEYS, ELEMENT_SCHEMAS, ELEMENT_TYPES, type FieldSpec } from './element-schema';
import { ID_PATTERN } from './ids';
import { err, ok, type Result } from './result';
import type { Deck } from './types';

export interface ValidationError {
  /** Location of the problem, e.g. `slides[2].elements[0].w`. */
  path: string;
  message: string;
}

export interface ValidationOptions {
  maxStringLength: number;
  maxArrayLength: number;
  maxSlides: number;
  maxElementsPerSlide: number;
  maxComponents: number;
  maxAssets: number;
  maxTableCells: number;
  maxPropsDepth: number;
  /** Mime types an asset may declare (arc42 §8.2, import hardening). */
  allowedMimeTypes: readonly string[];
}

export const DEFAULT_VALIDATION_OPTIONS: ValidationOptions = {
  maxStringLength: 1_000_000,
  maxArrayLength: 10_000,
  maxSlides: 2_000,
  maxElementsPerSlide: 2_000,
  maxComponents: 500,
  maxAssets: 5_000,
  maxTableCells: 10_000,
  maxPropsDepth: 16,
  allowedMimeTypes: [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif',
    'image/svg+xml',
    'video/mp4',
    'video/webm',
    'audio/mpeg',
    'audio/ogg',
    'audio/wav',
    'font/woff',
    'font/woff2',
    'font/ttf',
    'font/otf',
    'text/javascript',
    'text/css',
    'application/json',
  ],
};

const MAX_SHORT_STRING = 1_000;
const MAX_COORDINATE = 1_000_000;
const MAX_STEP = 1_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Hex, a plain keyword, or an rgb()/hsl() function: nothing that can smuggle other CSS. */
export const LITERAL_COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,30}|(rgb|hsl)a?\([0-9.,%\s/-]{1,60}\))$/;

const FITS = ['cover', 'contain', 'stretch'] as const;
const PERMISSIONS = ['network', 'storage'] as const;
const PLACEHOLDER_KINDS = ['title', 'body', 'image', 'footer'] as const;
const TRANSITIONS = ['none', 'fade', 'slide', 'zoom'] as const;
const PROP_TYPES = ['string', 'number', 'boolean', 'color', 'asset', 'select'] as const;

type Ref = { path: string; id: string };

/**
 * Validates untrusted input (import, storage) as a `Deck`. Collects every problem instead of
 * stopping at the first, and rejects unknown fields so nothing unmodelled (such as code on a
 * `CodeEl`) can ride along. On success the input object itself is returned, typed.
 */
export function validateDeck(
  input: unknown,
  options: Partial<ValidationOptions> = {},
): Result<Deck, ValidationError[]> {
  const v = new Validator({ ...DEFAULT_VALIDATION_OPTIONS, ...options });
  v.deck(input);
  return v.errors.length === 0 ? ok(input as Deck) : err(v.errors);
}

class Validator {
  readonly errors: ValidationError[] = [];

  private readonly layoutIds = new Set<string>();
  private readonly componentIds = new Set<string>();
  private readonly assetIds = new Set<string>();
  private readonly elementIds = new Set<string>();
  private readonly themeColors = new Set<string>();
  private readonly themeFonts = new Set<string>();
  private readonly layoutRefs: Ref[] = [];
  private readonly componentRefs: Ref[] = [];
  private readonly assetRefs: Ref[] = [];

  constructor(private readonly limits: ValidationOptions) {}

  deck(input: unknown): void {
    const d = this.record('', input, [
      'schemaVersion', 'id', 'title', 'stage', 'theme', 'layouts', 'slides', 'assets', 'components',
    ]);
    if (!d) return;

    if (d['schemaVersion'] !== SCHEMA_VERSION) {
      this.fail('schemaVersion', `must be ${SCHEMA_VERSION}`);
    }
    this.id('id', d['id']);
    this.string('title', d['title'], MAX_SHORT_STRING);
    this.stage('stage', d['stage']);
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

  /** Either side of the default stage must be kept so 16:9-based layouts stay meaningful (§8.1). */
  private stage(path: string, value: unknown): void {
    const s = this.record(path, value, ['width', 'height']);
    if (!s) return;
    const w = this.number(`${path}.width`, s['width'], { min: 1, max: MAX_STAGE_SIZE, int: true });
    const h = this.number(`${path}.height`, s['height'], { min: 1, max: MAX_STAGE_SIZE, int: true });
    if (w && h && s['width'] !== STAGE_WIDTH && s['height'] !== STAGE_HEIGHT) {
      this.fail(path, `must keep a width of ${STAGE_WIDTH} or a height of ${STAGE_HEIGHT}`);
    }
  }

  private theme(path: string, value: unknown): void {
    const t = this.record(path, value, ['colors', 'fonts', 'typeScale', 'spacing']);
    if (!t) return;
    this.map(`${path}.colors`, t['colors'], (p, x, key) => {
      if (this.literalColor(p, x)) this.themeColors.add(key);
    });
    this.map(`${path}.fonts`, t['fonts'], (p, x, key) => {
      if (this.string(p, x, MAX_SHORT_STRING)) this.themeFonts.add(key);
    });
    for (const key of ['typeScale', 'spacing'] as const) {
      this.map(`${path}.${key}`, t[key], (p, x) => this.number(p, x, { min: 0, max: MAX_COORDINATE }));
    }
  }

  private assets(path: string, value: unknown): void {
    this.map(path, value, (p, a, key) => {
      if (ID_PATTERN.test(key)) this.assetIds.add(key);
      else this.fail(p, 'asset key is not a valid id');
      const r = this.record(p, a, ['blobKey', 'mime', 'hash', 'size']);
      if (!r) return;
      this.string(`${p}.blobKey`, r['blobKey'], MAX_SHORT_STRING, 1);
      this.mime(`${p}.mime`, r['mime']);
      if (typeof r['hash'] !== 'string' || !SHA256_HEX.test(r['hash'])) {
        this.fail(`${p}.hash`, 'must be a lowercase hex SHA-256 digest');
      }
      this.number(`${p}.size`, r['size'], { min: 0, int: true });
    });
  }

  private mime(path: string, value: unknown): void {
    if (!this.string(path, value, MAX_SHORT_STRING, 1)) return;
    if (!this.limits.allowedMimeTypes.includes((value as string).toLowerCase())) {
      this.fail(path, `mime type "${value as string}" is not allowed`);
    }
  }

  private layout(path: string, value: unknown): void {
    const l = this.record(path, value, ['id', 'name', 'background', 'placeholders']);
    if (!l) return;
    this.unique(`${path}.id`, l['id'], this.layoutIds, 'layout');
    this.string(`${path}.name`, l['name'], MAX_SHORT_STRING);
    if (l['background'] !== undefined) this.fill(`${path}.background`, l['background']);
    const placeholders = this.array(`${path}.placeholders`, l['placeholders'], this.limits.maxArrayLength);
    const placeholderIds = new Set<string>();
    placeholders?.forEach((ph, i) => {
      const p = `${path}.placeholders[${i}]`;
      const r = this.record(p, ph, ['id', 'kind', 'x', 'y', 'w', 'h']);
      if (!r) return;
      this.unique(`${p}.id`, r['id'], placeholderIds, 'placeholder');
      this.oneOf(`${p}.kind`, r['kind'], PLACEHOLDER_KINDS);
      this.geometry(p, r);
    });
  }

  private component(path: string, value: unknown): void {
    const c = this.record(path, value, [
      'id', 'name', 'html', 'css', 'js', 'propSchema', 'permissions', 'files', 'libs',
    ]);
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
      this.array(`${path}.${key}`, c[key], this.limits.maxArrayLength)?.forEach((a, i) =>
        this.assetRef(`${path}.${key}[${i}]`, a),
      );
    }
  }

  private propSpec(path: string, value: unknown, keys: Set<string>): void {
    const s = this.record(path, value);
    if (!s) return;
    const isSelect = s['type'] === 'select';
    this.checkKeys(path, s, ['key', 'type', 'label', 'default', ...(isSelect ? ['options'] : ['min', 'max'])]);

    if (this.string(`${path}.key`, s['key'], MAX_SHORT_STRING, 1) && this.safeKey(`${path}.key`, s['key'] as string)) {
      if (keys.has(s['key'] as string)) this.fail(`${path}.key`, 'duplicate prop key');
      keys.add(s['key'] as string);
    }
    this.string(`${path}.label`, s['label'], MAX_SHORT_STRING);
    if (!this.oneOf(`${path}.type`, s['type'], PROP_TYPES)) return;

    const def = `${path}.default`;
    switch (s['type']) {
      case 'select': {
        const values: string[] = [];
        this.array(`${path}.options`, s['options'], this.limits.maxArrayLength)?.forEach((o, i) => {
          const r = this.record(`${path}.options[${i}]`, o, ['value', 'label']);
          if (!r) return;
          if (this.string(`${path}.options[${i}].value`, r['value'], MAX_SHORT_STRING)) values.push(r['value'] as string);
          this.string(`${path}.options[${i}].label`, r['label'], MAX_SHORT_STRING);
        });
        if (!values.includes(s['default'] as string)) this.fail(def, 'must be one of the option values');
        break;
      }
      case 'number': {
        const min = s['min'] === undefined ? undefined : this.number(`${path}.min`, s['min']) ? (s['min'] as number) : undefined;
        const max = s['max'] === undefined ? undefined : this.number(`${path}.max`, s['max']) ? (s['max'] as number) : undefined;
        if (min !== undefined && max !== undefined && min > max) this.fail(`${path}.min`, 'must be <= max');
        this.number(def, s['default'], { min, max });
        break;
      }
      case 'boolean':
        this.boolean(def, s['default']);
        break;
      case 'color':
        this.literalColor(def, s['default']);
        break;
      default: // string, asset
        this.string(def, s['default'], MAX_SHORT_STRING);
    }
    if (s['type'] !== 'number' && s['type'] !== 'select') {
      for (const bound of ['min', 'max'] as const) {
        if (s[bound] !== undefined) this.number(`${path}.${bound}`, s[bound]);
      }
    }
  }

  private slide(path: string, value: unknown, slideIds: Set<string>): void {
    const s = this.record(path, value, ['id', 'layoutId', 'section', 'background', 'elements', 'notes', 'transition']);
    if (!s) return;
    this.unique(`${path}.id`, s['id'], slideIds, 'slide');
    if (this.id(`${path}.layoutId`, s['layoutId'])) {
      this.layoutRefs.push({ path: `${path}.layoutId`, id: s['layoutId'] as string });
    }
    if (s['section'] !== undefined) this.string(`${path}.section`, s['section'], MAX_SHORT_STRING, 1);
    if (s['background'] !== undefined) this.fill(`${path}.background`, s['background']);
    this.string(`${path}.notes`, s['notes'], this.limits.maxStringLength, 0);
    if (s['transition'] !== undefined) this.transition(`${path}.transition`, s['transition']);
    const elements = this.array(`${path}.elements`, s['elements'], this.limits.maxElementsPerSlide);
    elements?.forEach((e, i) => this.element(`${path}.elements[${i}]`, e));
  }

  private transition(path: string, value: unknown): void {
    const t = this.record(path, value, ['type', 'durationMs']);
    if (!t) return;
    this.oneOf(`${path}.type`, t['type'], TRANSITIONS);
    this.number(`${path}.durationMs`, t['durationMs'], { min: 0, max: 60_000 });
  }

  private fill(path: string, value: unknown): void {
    const f = this.record(path, value);
    if (!f) return;
    switch (f['kind']) {
      case 'solid':
        this.checkKeys(path, f, ['kind', 'color']);
        this.color(`${path}.color`, f['color']);
        break;
      case 'gradient':
        this.checkKeys(path, f, ['kind', 'angle', 'stops']);
        this.number(`${path}.angle`, f['angle']);
        this.array(`${path}.stops`, f['stops'], 64)?.forEach((st, i) => {
          const r = this.record(`${path}.stops[${i}]`, st, ['offset', 'color']);
          if (!r) return;
          this.number(`${path}.stops[${i}].offset`, r['offset'], { min: 0, max: 1 });
          this.color(`${path}.stops[${i}].color`, r['color']);
        });
        break;
      case 'image':
        this.checkKeys(path, f, ['kind', 'assetId', 'fit']);
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
    const schema = ELEMENT_SCHEMAS[e['type'] as keyof typeof ELEMENT_SCHEMAS];
    this.checkKeys(path, e, [...ELEMENT_BASE_KEYS, ...Object.keys(schema.fields)]);
    for (const [name, spec] of Object.entries(schema.fields)) {
      if (e[name] === undefined && spec.optional) continue;
      this.field(`${path}.${name}`, spec, e[name]);
    }
  }

  private field(path: string, spec: FieldSpec, value: unknown): void {
    switch (spec.kind) {
      case 'string':
        this.string(path, value, spec.long ? this.limits.maxStringLength : MAX_SHORT_STRING, spec.min ?? 0);
        break;
      case 'number':
        this.number(path, value, { min: spec.min, max: spec.max ?? MAX_COORDINATE });
        break;
      case 'boolean':
        this.boolean(path, value);
        break;
      case 'enum':
        this.oneOf(path, value, spec.values);
        break;
      case 'color':
        this.color(path, value);
        break;
      case 'fill':
        this.fill(path, value);
        break;
      case 'font':
        if (this.string(path, value, MAX_SHORT_STRING, 1) && !this.themeFonts.has(value as string)) {
          this.fail(path, `references unknown theme font "${value as string}"`);
        }
        break;
      case 'asset':
        this.assetRef(path, value);
        break;
      case 'component':
        if (this.id(path, value)) this.componentRefs.push({ path, id: value as string });
        break;
      case 'table':
        this.table(path, value);
        break;
      case 'props': {
        const p = this.record(path, value);
        if (p) this.jsonValue(path, p, 0);
        break;
      }
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

  // --- primitives -------------------------------------------------------------------------

  private fail(path: string, message: string): false {
    this.errors.push({ path, message });
    return false;
  }

  /** Requires an object; with `keys`, also rejects any field not in the list. */
  private record(path: string, value: unknown, keys?: readonly string[]): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, 'must be an object');
      return undefined;
    }
    const r = value as Record<string, unknown>;
    if (keys) this.checkKeys(path, r, keys);
    return r;
  }

  private checkKeys(path: string, r: Record<string, unknown>, allowed: readonly string[]): void {
    for (const key of Object.keys(r)) {
      if (!allowed.includes(key)) this.fail(path ? `${path}.${key}` : key, 'unknown field');
    }
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

  private literalColor(path: string, value: unknown): boolean {
    if (typeof value === 'string' && LITERAL_COLOR.test(value)) return true;
    return this.fail(path, 'must be a hex, rgb(), hsl() or keyword colour');
  }

  /** A literal colour or a `{ token }` reference that resolves in `Theme.colors`. */
  private color(path: string, value: unknown): void {
    if (typeof value === 'string') {
      this.literalColor(path, value);
      return;
    }
    const c = this.record(path, value, ['token']);
    if (!c) return;
    if (this.string(`${path}.token`, c['token'], MAX_SHORT_STRING, 1) && !this.themeColors.has(c['token'] as string)) {
      this.fail(`${path}.token`, `references unknown theme color "${c['token'] as string}"`);
    }
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
