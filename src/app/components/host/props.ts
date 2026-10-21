import type { ComponentDef, PropSpec } from '../../core/model';

const hasOwn = (target: object, key: string): boolean => Object.prototype.hasOwnProperty.call(target, key);

/** The value for `spec`, or the spec's default when the stored one does not fit the declared type. */
function resolveProp(spec: PropSpec, stored: unknown): unknown {
  switch (spec.type) {
    case 'string':
    case 'color':
    case 'asset':
      return typeof stored === 'string' ? stored : spec.default;
    case 'boolean':
      return typeof stored === 'boolean' ? stored : spec.default;
    case 'number':
      return typeof stored === 'number' && Number.isFinite(stored) && (spec.min === undefined || stored >= spec.min) && (spec.max === undefined || stored <= spec.max)
        ? stored
        : spec.default;
    case 'select':
      return typeof stored === 'string' && spec.options.some((option) => option.value === stored) ? stored : spec.default;
  }
}

/**
 * The props a component sees: exactly the declared ones, each with the stored value if it fits
 * the declared type and the default otherwise. Undeclared props are ignored and stale values
 * never reach the component (arc42 §8.1, "CodeEl.props are deliberately not checked").
 */
export function resolveProps(def: Pick<ComponentDef, 'propSchema'>, stored: Record<string, unknown>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const spec of def.propSchema) props[spec.key] = structuredClone(resolveProp(spec, hasOwn(stored, spec.key) ? stored[spec.key] : undefined));
  return props;
}
