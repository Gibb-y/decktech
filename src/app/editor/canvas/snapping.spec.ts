import { SNAP_DISTANCE_PX, snapMove, snapTargets, snapValue } from './snapping';
import { MAX_ZOOM, MIN_ZOOM, centered, clampZoom, fitViewport, panBy, toStage, zoomAt } from './viewport';

const stage = { width: 1920, height: 1080 };

describe('snapTargets', () => {
  it('has the slide edges and centre, plus edges and centre of the other elements', () => {
    const t = snapTargets(stage, [{ x: 100, y: 200, w: 300, h: 100 }]);
    expect([...t.xs].sort((a, b) => a - b)).toEqual([0, 100, 250, 400, 960, 1920]);
    expect([...t.ys].sort((a, b) => a - b)).toEqual([0, 200, 250, 300, 540, 1080]);
  });

  it('lists a shared line once', () => {
    const t = snapTargets(stage, [{ x: 0, y: 0, w: 1920, h: 1080 }]);
    expect(t.xs).toHaveLength(3);
  });
});

describe('snapMove', () => {
  const targets = snapTargets(stage, [{ x: 500, y: 500, w: 100, h: 100 }]);

  it('snaps the left edge to the slide edge and reports the guide', () => {
    const r = snapMove({ x: 4, y: 300, w: 100, h: 50 }, targets, 8);
    expect(r.dx).toBe(-4);
    expect(r.dy).toBe(0);
    expect(r.guides).toContainEqual({ axis: 'x', position: 0 });
  });

  it('snaps the centre to the slide centre', () => {
    const r = snapMove({ x: 905, y: 300, w: 100, h: 50 }, targets, 8);
    expect(r.dx).toBe(5);
    expect(r.guides).toContainEqual({ axis: 'x', position: 960 });
  });

  it('snaps to another element on each axis independently', () => {
    const r = snapMove({ x: 603, y: 402, w: 40, h: 100 }, targets, 8);
    // Left edge 603 → 600 (the other's right edge); bottom edge 502 → 500 (its top).
    expect([r.dx, r.dy]).toEqual([-3, -2]);
    expect(r.guides).toEqual(expect.arrayContaining([{ axis: 'x', position: 600 }, { axis: 'y', position: 500 }]));
  });

  it('picks the nearest of several candidates', () => {
    const r = snapMove({ x: 497, y: 300, w: 4, h: 4 }, targets, 8);
    // Edges at 497, 499 and 501 all reach the line at 500; the centre (distance 1) beats the left edge (3).
    expect(r.dx).toBe(1);
  });

  it('does nothing when no line is within the distance', () => {
    expect(snapMove({ x: 300, y: 300, w: 10, h: 10 }, targets, 8)).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it('works in stage units, so the threshold shrinks with the zoom', () => {
    // 6 screen pixels at zoom 0.5 are 12 stage units.
    expect(SNAP_DISTANCE_PX / 0.5).toBe(12);
    expect(snapMove({ x: 11, y: 300, w: 10, h: 10 }, targets, SNAP_DISTANCE_PX / 0.5).dx).toBe(-11);
    expect(snapMove({ x: 11, y: 300, w: 10, h: 10 }, targets, SNAP_DISTANCE_PX / 2).dx).toBe(0);
  });
});

describe('snapValue', () => {
  it('snaps a coordinate or leaves it', () => {
    expect(snapValue(958, [0, 960, 1920], 8)).toBe(960);
    expect(snapValue(900, [0, 960, 1920], 8)).toBe(900);
  });
});

describe('viewport', () => {
  const area = { width: 1000, height: 600 };

  it('fits the stage with a margin and centres it', () => {
    const v = fitViewport(area, stage, 20);
    // Width allows 960/1920 = 0.5, height 560/1080 ≈ 0.518: width wins.
    expect(v.zoom).toBeCloseTo(0.5);
    expect(v.panX).toBeCloseTo(20);
    expect(v.panY).toBeCloseTo((600 - 540) / 2);
  });

  it('survives an empty area', () => {
    const v = fitViewport({ width: 0, height: 0 }, stage);
    expect(Number.isFinite(v.zoom)).toBe(true);
    expect(v.zoom).toBe(MIN_ZOOM);
  });

  it('clamps zoom', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(centered(area, stage, 100).zoom).toBe(MAX_ZOOM);
  });

  it('keeps the stage point under the anchor fixed while zooming', () => {
    const before = { zoom: 0.5, panX: 20, panY: 30 };
    const anchor = { x: 300, y: 200 };
    const under = toStage(before, anchor);
    const after = zoomAt(before, 1.5, anchor);
    expect(after.zoom).toBe(1.5);
    const again = toStage(after, anchor);
    expect(again.x).toBeCloseTo(under.x);
    expect(again.y).toBeCloseTo(under.y);
  });

  it('converts area pixels to stage units at a non-1 zoom', () => {
    expect(toStage({ zoom: 0.5, panX: 100, panY: 50 }, { x: 300, y: 150 })).toEqual({ x: 400, y: 200 });
  });

  it('does not let the stage be panned out of sight', () => {
    const view = { zoom: 0.5, panX: 20, panY: 30 };
    const far = panBy(view, 100000, -100000, area, stage);
    expect(far.panX).toBe(area.width - 64);
    expect(far.panY).toBe(64 - 540);
    expect(panBy(view, 10, -10, area, stage)).toEqual({ zoom: 0.5, panX: 30, panY: 20 });
  });
});
