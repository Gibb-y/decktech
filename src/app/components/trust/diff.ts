export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** A run of unchanged lines folded away by `foldUnchanged`. */
export interface Folded {
  kind: 'fold';
  count: number;
}

/** Above this many cells the table of the line comparison is not built; the changed middle is then shown as replaced. */
const MAX_CELLS = 4_000_000;

/**
 * A line diff of two texts for reading (the inspector's diff against the last trusted version).
 * Common first and last lines are peeled off, the middle is compared with a longest common
 * subsequence table. A middle too big for the table is reported as all removed, then all added:
 * still correct, only coarser, and the cost stays bounded.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_CELLS) {
    out.push(...midA.map((text): DiffLine => ({ kind: 'del', text })), ...midB.map((text): DiffLine => ({ kind: 'add', text })));
  } else {
    out.push(...diffMiddle(midA, midB));
  }
  out.push(...a.slice(endA).map((text): DiffLine => ({ kind: 'same', text })));
  return out;
}

function diffMiddle(a: string[], b: string[]): DiffLine[] {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      out.push({ kind: 'del', text: a[i++] });
    } else {
      out.push({ kind: 'add', text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] });
  while (j < b.length) out.push({ kind: 'add', text: b[j++] });
  return out;
}

export const hasChanges = (lines: readonly DiffLine[]): boolean => lines.some((line) => line.kind !== 'same');

/** Keeps `context` unchanged lines around each change and folds longer runs, so only the changes need reading. */
export function foldUnchanged(lines: readonly DiffLine[], context = 3): (DiffLine | Folded)[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const out: (DiffLine | Folded)[] = [];
  let run = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (run > 0) out.push({ kind: 'fold', count: run });
      run = 0;
      out.push(line);
    } else {
      run++;
    }
  });
  if (run > 0) out.push({ kind: 'fold', count: run });
  return out;
}
