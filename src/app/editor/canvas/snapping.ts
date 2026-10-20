import type { Stage } from '../../core/model';
import type { Rect } from './geometry';

/** Positions of the vertical (`xs`) and horizontal (`ys`) lines a dragged edge may snap to. */
export interface SnapTargets {
  xs: readonly number[];
  ys: readonly number[];
}

export interface Guide {
  /** `x`: a vertical line at `position`; `y`: a horizontal one. */
  axis: 'x' | 'y';
  position: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

/** Snap distance on screen; divided by the zoom it becomes stage units. */
export const SNAP_DISTANCE_PX = 6;

/**
 * Lines of the slide (edges and centre) and of every other element's bounds (edges and centre).
 * Built once per gesture, so a drag costs a scan of these lines, not of the slide.
 */
export function snapTargets(stage: Stage, others: readonly Rect[]): SnapTargets {
  const xs = new Set<number>([0, stage.width / 2, stage.width]);
  const ys = new Set<number>([0, stage.height / 2, stage.height]);
  for (const r of others) {
    xs.add(r.x).add(r.x + r.w / 2).add(r.x + r.w);
    ys.add(r.y).add(r.y + r.h / 2).add(r.y + r.h);
  }
  return { xs: [...xs], ys: [...ys] };
}

/** The smallest signed distance from any of `values` to any of `lines`, if within `threshold`. */
function nearest(values: readonly number[], lines: readonly number[], threshold: number): number | undefined {
  let best: number | undefined;
  for (const value of values) {
    for (const line of lines) {
      const d = line - value;
      if (Math.abs(d) <= threshold && (best === undefined || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  return best;
}

/** Lines that the (already shifted) `values` sit on, for drawing guides. */
function touching(values: readonly number[], lines: readonly number[]): number[] {
  return lines.filter((line) => values.some((v) => Math.abs(v - line) < 1e-6));
}

const edges = (start: number, size: number): number[] => [start, start + size / 2, start + size];

/**
 * How far to shift `moving` so its edges or centre line up with a target line, per axis, plus the
 * lines that end up aligned. An axis without a target in reach is left alone.
 */
export function snapMove(moving: Rect, targets: SnapTargets, threshold: number): SnapResult {
  const xValues = edges(moving.x, moving.w);
  const yValues = edges(moving.y, moving.h);
  const dx = nearest(xValues, targets.xs, threshold) ?? 0;
  const dy = nearest(yValues, targets.ys, threshold) ?? 0;
  const guides: Guide[] = [
    ...touching(
      xValues.map((v) => v + dx),
      targets.xs,
    ).map((position): Guide => ({ axis: 'x', position })),
    ...touching(
      yValues.map((v) => v + dy),
      targets.ys,
    ).map((position): Guide => ({ axis: 'y', position })),
  ];
  return { dx, dy, guides };
}

/** Snaps a single coordinate (a dragged edge) to the nearest line within `threshold`. */
export function snapValue(value: number, lines: readonly number[], threshold: number): number {
  return value + (nearest([value], lines, threshold) ?? 0);
}
