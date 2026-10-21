import { ID_PATTERN } from './ids';
import { LITERAL_COLOR } from './validate';
import type { ComponentDef, PropSpec } from './types';

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

const hasOwn = (target: object, key: string): boolean => Object.prototype.hasOwnProperty.call(target, key);

/**
 * The props a component sees: exactly the declared ones, each the stored value if it fits the
 * declared type (`propValueProblem`) and the default otherwise. Undeclared props are ignored and
 * stale values never reach the component (arc42 §8.1, "CodeEl.props are deliberately not checked").
 * The host uses it to build `init` and `props` messages and the properties panel to show what the
 * component will actually get.
 */
export function resolveProps(def: Pick<ComponentDef, 'propSchema'>, stored: Record<string, unknown>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const spec of def.propSchema) {
    const value = hasOwn(stored, spec.key) && propValueProblem(spec, stored[spec.key]) === undefined ? stored[spec.key] : spec.default;
    props[spec.key] = structuredClone(value);
  }
  return props;
}
