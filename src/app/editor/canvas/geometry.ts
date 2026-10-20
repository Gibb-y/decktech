import type { ElementGeometry } from '../../core/store';

/**
 * Pure geometry of the editing canvas. Everything here is in stage units (arc42 §8.1); converting
 * from screen pixels is the viewport's job (`viewport.ts`). Angles are in degrees, like
 * `ElementBase.rotation`; rotation is clockwise around the centre of the element, as in CSS.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The frame of an element: its unrotated rectangle plus the rotation about its centre. */
export interface Box extends Rect {
  rotation: number;
}

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Which edges a handle moves: -1 left/top, +1 right/bottom, 0 not at all. */
export const HANDLES: Readonly<Record<HandleId, { sx: -1 | 0 | 1; sy: -1 | 0 | 1 }>> = {
  nw: { sx: -1, sy: -1 },
  n: { sx: 0, sy: -1 },
  ne: { sx: 1, sy: -1 },
  e: { sx: 1, sy: 0 },
  se: { sx: 1, sy: 1 },
  s: { sx: 0, sy: 1 },
  sw: { sx: -1, sy: 1 },
  w: { sx: -1, sy: 0 },
};

export const HANDLE_IDS = Object.keys(HANDLES) as HandleId[];

/** Smallest width / height a resize produces; resizing never flips an element. */
export const MIN_SIZE = 1;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

export const centerOf = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function rotatePoint(p: Point, about: Point, degrees: number): Point {
  if (!degrees) return { x: p.x, y: p.y };
  const cos = Math.cos(toRad(degrees));
  const sin = Math.sin(toRad(degrees));
  const dx = p.x - about.x;
  const dy = p.y - about.y;
  return { x: about.x + dx * cos - dy * sin, y: about.y + dx * sin + dy * cos };
}

/** Corners in the order top-left, top-right, bottom-right, bottom-left (before rotation). */
export function corners(box: Box): [Point, Point, Point, Point] {
  const c = centerOf(box);
  const raw: [Point, Point, Point, Point] = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ];
  return raw.map((p) => rotatePoint(p, c, box.rotation)) as [Point, Point, Point, Point];
}

/** Axis-aligned bounds of a rotated box. */
export function boundsOf(box: Box): Rect {
  return union(corners(box).map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
}

/** Smallest rectangle containing all of `rects`; callers pass at least one. */
export function union(rects: readonly Rect[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Rectangles that merely touch do not intersect. */
export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Normalises a rectangle dragged in any direction (negative width / height) to positive size. */
export function normalizeRect(from: Point, to: Point): Rect {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
}

// ---------------------------------------------------------------- resize

export interface ResizeOptions {
  /** Keep the aspect ratio of the start box (shift). */
  keepRatio?: boolean;
}

/**
 * The box after dragging `handle` to `pointer`. The opposite edge (or corner) stays where it is
 * on the stage, also when the box is rotated: the pointer is first mapped into the box's own
 * frame. A box never gets smaller than `MIN_SIZE` and never flips.
 */
export function resizeBox(start: Box, handle: HandleId, pointer: Point, options: ResizeOptions = {}): Box {
  const { sx, sy } = HANDLES[handle];
  const c = centerOf(start);
  const local = rotatePoint(pointer, c, -start.rotation);
  const lx = local.x - c.x;
  const ly = local.y - c.y;

  let w = sx ? Math.max(MIN_SIZE, sx * lx + start.w / 2) : start.w;
  let h = sy ? Math.max(MIN_SIZE, sy * ly + start.h / 2) : start.h;

  if (options.keepRatio && start.w > 0 && start.h > 0) {
    const factor = sx && sy ? Math.max(w / start.w, h / start.h) : sx ? w / start.w : h / start.h;
    const scale = Math.max(factor, MIN_SIZE / start.w, MIN_SIZE / start.h);
    w = start.w * scale;
    h = start.h * scale;
  }

  // The anchored edge stays put, so the centre moves by half of the change, along the handle.
  const shift = { x: sx * (w - start.w) / 2, y: sy * (h - start.h) / 2 };
  const centre = rotatePoint({ x: c.x + shift.x, y: c.y + shift.y }, c, start.rotation);
  return { x: centre.x - w / 2, y: centre.y - h / 2, w, h, rotation: start.rotation };
}

/** Maps an unrotated child of `from` to the same relative place in `to` (group resize). */
export function scaleInto<T extends Rect>(child: T, from: Rect, to: Rect): T {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  return { ...child, x: to.x + (child.x - from.x) * sx, y: to.y + (child.y - from.y) * sy, w: child.w * sx, h: child.h * sy };
}

/** Rotation in degrees (0 ≤ r < 360) that points the rotate handle, above the box, at `pointer`. */
export function angleTowards(center: Point, pointer: Point, stepDegrees = 0): number {
  let angle = (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI + 90;
  if (stepDegrees > 0) angle = Math.round(angle / stepDegrees) * stepDegrees;
  return normalizeAngle(angle);
}

export function normalizeAngle(degrees: number): number {
  const a = degrees % 360;
  // Round away floating-point noise such as 359.99999999999994.
  const r = Math.round((a < 0 ? a + 360 : a) * 1e6) / 1e6;
  return r === 360 ? 0 : r;
}

// -------------------------------------------------------------- align

export type AlignKind = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type DistributeAxis = 'horizontal' | 'vertical';

export interface Placed {
  id: string;
  box: Box;
}

/**
 * Geometry changes that align the (rotated) bounds of `items` to each other, or to `within` (the
 * slide) when there is only one. Only items that actually move are returned.
 */
export function alignItems(items: readonly Placed[], kind: AlignKind, within: Rect): ElementGeometry[] {
  if (items.length === 0) return [];
  const bounds = items.map((i) => boundsOf(i.box));
  const reference = items.length === 1 ? within : union(bounds);
  return items.flatMap((item, i) => {
    const b = bounds[i];
    let dx = 0;
    let dy = 0;
    if (kind === 'left') dx = reference.x - b.x;
    else if (kind === 'center') dx = reference.x + reference.w / 2 - (b.x + b.w / 2);
    else if (kind === 'right') dx = reference.x + reference.w - (b.x + b.w);
    else if (kind === 'top') dy = reference.y - b.y;
    else if (kind === 'middle') dy = reference.y + reference.h / 2 - (b.y + b.h / 2);
    else dy = reference.y + reference.h - (b.y + b.h);
    return moved(item, dx, dy);
  });
}

/**
 * Spaces three or more items so the gaps between their bounds are equal; the outermost two stay
 * where they are. Fewer than three items give no change.
 */
export function distributeItems(items: readonly Placed[], axis: DistributeAxis): ElementGeometry[] {
  if (items.length < 3) return [];
  const horizontal = axis === 'horizontal';
  const entries = items
    .map((item) => ({ item, b: boundsOf(item.box) }))
    .sort((a, b) => (horizontal ? a.b.x - b.b.x : a.b.y - b.b.y));
  const size = (r: Rect): number => (horizontal ? r.w : r.h);
  const start = (r: Rect): number => (horizontal ? r.x : r.y);
  const first = entries[0].b;
  const last = entries[entries.length - 1].b;
  const span = start(last) + size(last) - start(first);
  const gap = (span - entries.reduce((sum, e) => sum + size(e.b), 0)) / (entries.length - 1);
  let cursor = start(first);
  return entries.flatMap(({ item, b }) => {
    const delta = cursor - start(b);
    cursor += size(b) + gap;
    return moved(item, horizontal ? delta : 0, horizontal ? 0 : delta);
  });
}

function moved(item: Placed, dx: number, dy: number): ElementGeometry[] {
  // Differences below a thousandth of a stage unit are floating-point noise, not movement.
  if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) return [];
  const { x, y, w, h } = item.box;
  return [{ id: item.id, x: x + dx, y: y + dy, w, h }];
}
