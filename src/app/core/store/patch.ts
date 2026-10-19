// Minimal JSON Patch (RFC 6902 subset: add / replace / remove) over immutable documents.
// See docs/arc42/08-crosscutting-concepts.md §8.4.

export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string };

export type Patch = readonly PatchOp[];

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

/** Keys that must never be written through a patch (prototype pollution). */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const escapeKey = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');
const unescapeKey = (key: string): string => key.replaceAll('~1', '/').replaceAll('~0', '~');

/**
 * Computes the patch that turns `before` into `after`. Subtrees that are referentially equal are
 * skipped, so the cost is proportional to what changed. Arrays of `{ id }` objects are matched by id.
 * A property whose value is `undefined` counts as absent.
 */
export function diff(before: unknown, after: unknown): PatchOp[] {
  const ops: PatchOp[] = [];
  diffInto(before, after, '', ops);
  return ops;
}

function diffInto(before: unknown, after: unknown, path: string, ops: PatchOp[]): void {
  if (before === after) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    diffArray(before, after, path, ops);
    return;
  }
  if (isRecord(before) && isRecord(after) && !hasForbiddenKey(before) && !hasForbiddenKey(after)) {
    for (const key of Object.keys(before)) {
      if (before[key] !== undefined && own(after, key) === undefined) ops.push({ op: 'remove', path: `${path}/${escapeKey(key)}` });
    }
    for (const key of Object.keys(after)) {
      const next = after[key];
      if (next === undefined) continue;
      const child = `${path}/${escapeKey(key)}`;
      const previous = own(before, key);
      if (previous === undefined) ops.push({ op: 'add', path: child, value: next });
      else diffInto(previous, next, child, ops);
    }
    return;
  }
  // Objects with keys that must not be traversed (see FORBIDDEN_KEYS) are replaced as a whole.
  ops.push({ op: 'replace', path, value: after });
}

/** Own property value; inherited names such as `toString` count as absent. */
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);

const hasForbiddenKey = (record: Record<string, unknown>): boolean => Object.keys(record).some((k) => FORBIDDEN_KEYS.has(k));

/** The ids of an array of `{ id: string }` objects, or `undefined` if it is not such an array or ids repeat. */
function idsOf(items: readonly unknown[]): string[] | undefined {
  const ids = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || typeof item['id'] !== 'string' || ids.has(item['id'])) return undefined;
    ids.add(item['id']);
  }
  return [...ids];
}

/**
 * Arrays of identified objects (slides, elements) are matched by id, so inserting or removing
 * one item yields one operation instead of a rewrite of everything after it. A reorder of the
 * items that exist on both sides, and arrays without ids, are compared by index; an index whose
 * item changed identity is replaced as a whole.
 */
function diffArray(before: readonly unknown[], after: readonly unknown[], path: string, ops: PatchOp[]): void {
  const beforeIds = idsOf(before);
  const afterIds = idsOf(after);
  if (beforeIds && afterIds) {
    const inBefore = new Set(beforeIds);
    const inAfter = new Set(afterIds);
    const keptIds = beforeIds.filter((id) => inAfter.has(id));
    const commonAfter = afterIds.filter((id) => inBefore.has(id));
    if (keptIds.every((id, i) => id === commonAfter[i])) {
      for (let i = before.length - 1; i >= 0; i--) {
        if (!inAfter.has(beforeIds[i])) ops.push({ op: 'remove', path: `${path}/${i}` });
      }
      const kept = before.filter((_, i) => inAfter.has(beforeIds[i]));
      let k = 0;
      for (let i = 0; i < after.length; i++) {
        if (inBefore.has(afterIds[i])) diffInto(kept[k++], after[i], `${path}/${i}`, ops);
        else ops.push({ op: 'add', path: `${path}/${i}`, value: after[i] });
      }
      return;
    }
  }

  const common = Math.min(before.length, after.length);
  for (let i = 0; i < common; i++) {
    const a = before[i];
    const b = after[i];
    if (a !== b && isRecord(a) && isRecord(b) && typeof a['id'] === 'string' && a['id'] !== b['id']) {
      ops.push({ op: 'replace', path: `${path}/${i}`, value: b });
    } else {
      diffInto(a, b, `${path}/${i}`, ops);
    }
  }
  for (let i = common; i < after.length; i++) ops.push({ op: 'add', path: `${path}/${i}`, value: after[i] });
  for (let i = before.length - 1; i >= common; i--) ops.push({ op: 'remove', path: `${path}/${i}` });
}

/**
 * Applies a patch without mutating `doc`. Only the nodes on the changed paths are copied;
 * everything else keeps its identity. Throws `PatchError` if a path does not resolve.
 */
export function applyPatch<T>(doc: T, patch: Patch): T {
  let result: unknown = doc;
  for (const op of patch) result = applyOp(result, op);
  return result as T;
}

function applyOp(doc: unknown, op: PatchOp): unknown {
  if (op.path === '') {
    if (op.op !== 'replace') throw new PatchError(`Cannot ${op.op} the document root`);
    return op.value;
  }
  if (!op.path.startsWith('/')) throw new PatchError(`Invalid path "${op.path}"`);
  return applyAt(doc, op.path.slice(1).split('/').map(unescapeKey), 0, op);
}

function applyAt(node: unknown, parts: string[], depth: number, op: PatchOp): unknown {
  const key = parts[depth];
  const last = depth === parts.length - 1;

  if (Array.isArray(node)) {
    const index = arrayIndex(key, node.length, op.op === 'add' && last, op.path);
    const copy = node.slice();
    if (!last) copy[index] = applyAt(node[index], parts, depth + 1, op);
    else if (op.op === 'add') copy.splice(index, 0, op.value);
    else if (op.op === 'replace') copy[index] = op.value;
    else copy.splice(index, 1);
    return copy;
  }

  if (isRecord(node)) {
    if (FORBIDDEN_KEYS.has(key)) throw new PatchError(`Forbidden key "${key}" in path "${op.path}"`);
    const exists = Object.hasOwn(node, key) && node[key] !== undefined;
    const copy = { ...node };
    if (!last) {
      if (!exists) throw new PatchError(`Path "${op.path}" does not exist`);
      copy[key] = applyAt(node[key], parts, depth + 1, op);
    } else if (op.op === 'add') {
      copy[key] = op.value;
    } else if (!exists) {
      throw new PatchError(`Path "${op.path}" does not exist`);
    } else if (op.op === 'replace') {
      copy[key] = op.value;
    } else {
      delete copy[key];
    }
    return copy;
  }

  throw new PatchError(`Path "${op.path}" does not exist`);
}

function arrayIndex(key: string, length: number, allowEnd: boolean, path: string): number {
  if (!/^(0|[1-9]\d*)$/.test(key)) throw new PatchError(`Invalid array index "${key}" in path "${path}"`);
  const index = Number(key);
  if (index > length || (index === length && !allowEnd)) {
    throw new PatchError(`Array index ${index} out of range in path "${path}"`);
  }
  return index;
}
