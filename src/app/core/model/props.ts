import { ID_PATTERN } from './ids';
import { LITERAL_COLOR } from './validate';
import type { PropSpec } from './types';

/** Longest value of a `string` prop; longer text belongs in the component's own source. */
export const MAX_PROP_STRING = 10_000;

/**
 * Why `value` does not fit `spec`, or `undefined` if it does. The one rule for a prop value: the
 * properties panel shows it, `SetCodeProps` enforces it and `resolveProps` (host) falls back to the
 * default for a stored value that fails it (arc42 §8.3).
 */
export function propValueProblem(spec: PropSpec, value: unknown): string | undefined {
  switch (spec.type) {
    case 'string':
      return typeof value === 'string' && value.length <= MAX_PROP_STRING ? undefined : `text of at most ${MAX_PROP_STRING} characters`;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'true or false';
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'a number';
      if (spec.min !== undefined && value < spec.min) return `at least ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `at most ${spec.max}`;
      return undefined;
    case 'color':
      return typeof value === 'string' && LITERAL_COLOR.test(value) ? undefined : 'a colour such as #336699 or rebeccapurple';
    case 'asset':
      return value === '' || (typeof value === 'string' && ID_PATTERN.test(value)) ? undefined : 'an asset id, or empty for none';
    case 'select':
      return typeof value === 'string' && spec.options.some((option) => option.value === value) ? undefined : `one of ${spec.options.map((o) => o.value).join(', ')}`;
  }
}
