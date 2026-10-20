import {
  HANDLE_IDS,
  MIN_SIZE,
  alignItems,
  angleTowards,
  boundsOf,
  corners,
  distributeItems,
  normalizeAngle,
  normalizeRect,
  rectsIntersect,
  resizeBox,
  rotatePoint,
  scaleInto,
  union,
  type Box,
  type HandleId,
  type Placed,
  type Point,
} from './geometry';

const close = (actual: number, expected: number): void => expect(actual).toBeCloseTo(expected, 6);
const closePoint = (actual: Point, expected: Point): void => {
  close(actual.x, expected.x);
  close(actual.y, expected.y);
};

const box = (x: number, y: number, w: number, h: number, rotation = 0): Box => ({ x, y, w, h, rotation });

describe('rotation and bounds', () => {
  it('rotates clockwise about a point, as CSS does', () => {
    closePoint(rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90), { x: 0, y: 10 });
    closePoint(rotatePoint({ x: 3, y: 4 }, { x: 3, y: 4 }, 123), { x: 3, y: 4 });
  });

  it('returns the corners of a rotated box and their axis-aligned bounds', () => {
    const [tl, tr, br, bl] = corners(box(0, 0, 100, 50, 90));
    // Rotated 90° about (50, 25): the box now spans x 25..75, y -25..75.
    closePoint(tl, { x: 75, y: -25 });
    closePoint(tr, { x: 75, y: 75 });
    closePoint(br, { x: 25, y: 75 });
    closePoint(bl, { x: 25, y: -25 });
    const b = boundsOf(box(0, 0, 100, 50, 90));
    expect([b.x, b.y, b.w, b.h].map((n) => Math.round(n))).toEqual([25, -25, 50, 100]);
  });

  it('unions rectangles and detects intersection (touching is not intersecting)', () => {
    expect(union([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: -5, w: 5, h: 5 }])).toEqual({ x: 0, y: -5, w: 25, h: 15 });
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it('normalises a rectangle dragged up and to the left', () => {
    expect(normalizeRect({ x: 50, y: 40 }, { x: 10, y: 5 })).toEqual({ x: 10, y: 5, w: 40, h: 35 });
  });
});

describe('resizeBox', () => {
  const start = box(100, 100, 200, 100);

  it('keeps the opposite edge when an edge handle is dragged', () => {
    expect(resizeBox(start, 'e', { x: 400, y: 999 })).toEqual(box(100, 100, 300, 100));
    expect(resizeBox(start, 'w', { x: 50, y: 0 })).toEqual(box(50, 100, 250, 100));
    expect(resizeBox(start, 's', { x: 0, y: 260 })).toEqual(box(100, 100, 200, 160));
    expect(resizeBox(start, 'n', { x: 0, y: 40 })).toEqual(box(100, 40, 200, 160));
  });

  it('keeps the opposite corner when a corner handle is dragged', () => {
    expect(resizeBox(start, 'se', { x: 350, y: 250 })).toEqual(box(100, 100, 250, 150));
    expect(resizeBox(start, 'nw', { x: 60, y: 80 })).toEqual(box(60, 80, 240, 120));
  });

  it.each(HANDLE_IDS)('does not flip or collapse past the opposite side with %s', (handle: HandleId) => {
    const far = resizeBox(start, handle, { x: 200, y: 150 });
    expect(far.w).toBeGreaterThanOrEqual(MIN_SIZE);
    expect(far.h).toBeGreaterThanOrEqual(MIN_SIZE);
    const beyond = resizeBox(start, handle, { x: -5000, y: -5000 });
    expect(beyond.w).toBeGreaterThanOrEqual(MIN_SIZE);
    expect(beyond.h).toBeGreaterThanOrEqual(MIN_SIZE);
  });

  it('keeps the aspect ratio with shift, for corners and edges', () => {
    const corner = resizeBox(start, 'se', { x: 500, y: 200 }, { keepRatio: true });
    close(corner.w / corner.h, 2);
    expect([corner.x, corner.y]).toEqual([100, 100]);
    const edge = resizeBox(start, 'e', { x: 500, y: 0 }, { keepRatio: true });
    close(edge.w, 400);
    close(edge.h, 200);
    // The edge handle scales the other side about its centre line, so the left edge stays.
    close(edge.x, 100);
    close(edge.y, 50);
  });

  it('keeps the dragged-from corner fixed on the stage when the box is rotated', () => {
    const rotated = box(100, 100, 200, 100, 30);
    const anchor = corners(rotated)[0]; // top-left is opposite to the south-east handle
    // Drag the south-east corner outwards along the box's own axes (not the stage's).
    const pointer = rotatePoint({ x: 400, y: 250 }, { x: 200, y: 150 }, 30);
    const next = resizeBox(rotated, 'se', pointer);
    // The pointer is (200, 100) from the centre in the box's frame: 200 + 100 wide, 100 + 50 high.
    close(next.w, 300);
    close(next.h, 150);
    closePoint(corners(next)[0], anchor);
    expect(next.rotation).toBe(30);
  });

  it('lands the dragged edge under the pointer for a rotated box', () => {
    const rotated = box(0, 0, 100, 100, 90);
    const target = { x: 50, y: 50 + 80 }; // straight down from the centre; the box's "east" side now points down
    const next = resizeBox(rotated, 'e', target);
    close(next.w, 130);
    closePoint(rotatePoint({ x: next.x + next.w, y: next.y + next.h / 2 }, { x: next.x + next.w / 2, y: next.y + next.h / 2 }, 90), {
      x: target.x - 0,
      y: target.y + 0,
    });
  });

  it('does not ask for a ratio from a zero-height box such as a line', () => {
    const line = box(0, 0, 100, 0);
    const next = resizeBox(line, 'e', { x: 300, y: 0 }, { keepRatio: true });
    expect(next.w).toBe(300);
    expect(next.h).toBe(0);
  });
});

describe('scaleInto', () => {
  it('maps a child to the same relative place in the resized group', () => {
    const from = { x: 0, y: 0, w: 100, h: 100 };
    const to = { x: 10, y: 20, w: 200, h: 50 };
    expect(scaleInto({ id: 'a', x: 50, y: 50, w: 10, h: 20 }, from, to)).toEqual({ id: 'a', x: 110, y: 45, w: 20, h: 10 });
  });

  it('leaves the child alone along an axis where the group has no extent', () => {
    expect(scaleInto({ x: 5, y: 5, w: 4, h: 4 }, { x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 10, h: 10 })).toEqual({ x: 5, y: 5, w: 4, h: 4 });
  });
});

describe('angles', () => {
  it('points the rotate handle (above the box) at the pointer', () => {
    const c = { x: 0, y: 0 };
    close(angleTowards(c, { x: 0, y: -100 }), 0);
    close(angleTowards(c, { x: 100, y: 0 }), 90);
    close(angleTowards(c, { x: 0, y: 100 }), 180);
    close(angleTowards(c, { x: -100, y: 0 }), 270);
  });

  it('snaps to a step', () => {
    close(angleTowards({ x: 0, y: 0 }, { x: 26, y: -100 }, 15), 15);
    expect(angleTowards({ x: 0, y: 0 }, { x: 1, y: -100 }, 15)).toBe(0);
  });

  it.each([
    [360, 0],
    [-90, 270],
    [725, 5],
    [359.9999999999, 0],
  ])('normalises %d to %d', (input, expected) => close(normalizeAngle(input), expected));
});

describe('alignItems', () => {
  const items: Placed[] = [
    { id: 'a', box: box(100, 100, 100, 100) },
    { id: 'b', box: box(400, 300, 50, 50) },
    { id: 'c', box: box(250, 500, 200, 20) },
  ];
  const slide = { x: 0, y: 0, w: 1920, h: 1080 };
  const byId = (changes: ReturnType<typeof alignItems>) => Object.fromEntries(changes.map((c) => [c.id, c]));

  it('aligns to the bounds of the selection', () => {
    expect(byId(alignItems(items, 'left', slide))).toEqual({ b: { id: 'b', x: 100, y: 300, w: 50, h: 50 }, c: { id: 'c', x: 100, y: 500, w: 200, h: 20 } });
    // Only `a` is off the right edge (450) of the selection; the others do not move and are not reported.
    expect(alignItems(items, 'right', slide)).toEqual([{ id: 'a', x: 350, y: 100, w: 100, h: 100 }]);
    expect(byId(alignItems(items, 'top', slide))['c'].y).toBe(100);
    expect(byId(alignItems(items, 'bottom', slide))['a'].y).toBe(420);
    // Centre: the selection spans x 100..450, so its centre is 275.
    expect(byId(alignItems(items, 'center', slide))['a'].x).toBe(225);
    expect(byId(alignItems(items, 'middle', slide))['b'].y).toBe(285);
  });

  it('aligns a single element to the slide', () => {
    expect(alignItems([items[0]], 'center', slide)).toEqual([{ id: 'a', x: 910, y: 100, w: 100, h: 100 }]);
    expect(alignItems([items[0]], 'bottom', slide)).toEqual([{ id: 'a', x: 100, y: 980, w: 100, h: 100 }]);
  });

  it('uses the rotated bounds and reports nothing when already aligned', () => {
    const turned: Placed = { id: 't', box: box(0, 0, 100, 50, 90) }; // bounds x 25..75
    expect(alignItems([turned], 'left', slide)[0].x).toBe(-25);
    expect(alignItems([items[0]], 'left', { x: 100, y: 0, w: 10, h: 10 })).toEqual([]);
    expect(alignItems([], 'left', slide)).toEqual([]);
  });
});

describe('distributeItems', () => {
  const placed = (id: string, x: number, w: number): Placed => ({ id, box: box(x, 0, w, 10) });

  it('makes the gaps between bounds equal and keeps the outer two in place', () => {
    const changes = distributeItems([placed('a', 0, 100), placed('b', 120, 50), placed('c', 400, 100)], 'horizontal');
    // span 0..500, widths 250, so two gaps of 125.
    expect(changes).toEqual([{ id: 'b', x: 225, y: 0, w: 50, h: 10 }]);
  });

  it('sorts by position, not by the order given', () => {
    const changes = distributeItems([placed('c', 400, 100), placed('a', 0, 100), placed('b', 120, 50)], 'horizontal');
    expect(changes.map((c) => c.id)).toEqual(['b']);
  });

  it('distributes vertically', () => {
    const v = (id: string, y: number): Placed => ({ id, box: box(0, y, 10, 10) });
    expect(distributeItems([v('a', 0), v('b', 5), v('c', 90)], 'vertical')).toEqual([{ id: 'b', x: 0, y: 45, w: 10, h: 10 }]);
  });

  it('needs three elements', () => {
    expect(distributeItems([placed('a', 0, 10), placed('b', 50, 10)], 'horizontal')).toEqual([]);
  });
});
