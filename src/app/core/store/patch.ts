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
 * skipped, so the cost is proportional to what changed. Arrays are compared index by index.
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
    const common = Math.min(before.length, after.length);
    for (let i = 0; i < common; i++) diffInto(before[i], after[i], `${path}/${i}`, ops);
    for (let i = common; i < after.length; i++) ops.push({ op: 'add', path: `${path}/${i}`, value: after[i] });
    for (let i = before.length - 1; i >= common; i--) ops.push({ op: 'remove', path: `${path}/${i}` });
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    for (const key of Object.keys(before)) {
      if (before[key] !== undefined && after[key] === undefined) ops.push({ op: 'remove', path: `${path}/${escapeKey(key)}` });
    }
    for (const key of Object.keys(after)) {
      const next = after[key];
      if (next === undefined) continue;
      const child = `${path}/${escapeKey(key)}`;
      if (before[key] === undefined) ops.push({ op: 'add', path: child, value: next });
      else diffInto(before[key], next, child, ops);
    }
    return;
  }
  ops.push({ op: 'replace', path, value: after });
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
