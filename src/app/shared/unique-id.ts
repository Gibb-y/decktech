let counter = 0;

/** A document-unique id for ARIA relationships (`aria-labelledby`, `aria-controls`). */
export function uniqueId(prefix: string): string {
  return `${prefix}-${++counter}`;
}
