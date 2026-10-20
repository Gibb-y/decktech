import type { Stage } from '../../core/model';
import type { Point } from './geometry';

/**
 * Where the stage sits in the canvas area: `zoom` is the scale factor `k` (screen pixels per stage
 * unit) and `panX` / `panY` the screen position of the stage's top-left corner relative to the
 * area. Viewport state is UI state and not part of history (arc42 §8.4).
 */
export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
/** Space kept around the slide by "fit", in screen pixels. */
export const FIT_MARGIN = 24;
/** How much of the slide must stay inside the area when panning, in screen pixels. */
const KEEP_VISIBLE = 64;

export const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** The largest zoom at which the whole stage fits the area, centred. */
export function fitViewport(area: Size, stage: Stage, margin = FIT_MARGIN): Viewport {
  const zoom = clampZoom(
    Math.min(Math.max(area.width - 2 * margin, 1) / stage.width, Math.max(area.height - 2 * margin, 1) / stage.height),
  );
  return centered(area, stage, zoom);
}

/** Zoom `zoom` with the stage centred in the area. */
export function centered(area: Size, stage: Stage, zoom: number): Viewport {
  const z = clampZoom(zoom);
  return { zoom: z, panX: (area.width - stage.width * z) / 2, panY: (area.height - stage.height * z) / 2 };
}

/** Changes the zoom while the stage point under `anchor` (area pixels) stays under it. */
export function zoomAt(view: Viewport, zoom: number, anchor: Point): Viewport {
  const z = clampZoom(zoom);
  const ratio = z / view.zoom;
  return { zoom: z, panX: anchor.x - (anchor.x - view.panX) * ratio, panY: anchor.y - (anchor.y - view.panY) * ratio };
}

/** Moves the stage by a screen offset, keeping part of it in view so it cannot be lost. */
export function panBy(view: Viewport, dx: number, dy: number, area: Size, stage: Stage): Viewport {
  const w = stage.width * view.zoom;
  const h = stage.height * view.zoom;
  const clamp = (value: number, size: number, areaSize: number): number => {
    const keep = Math.min(KEEP_VISIBLE, size, areaSize);
    return Math.min(areaSize - keep, Math.max(keep - size, value));
  };
  return { ...view, panX: clamp(view.panX + dx, w, area.width), panY: clamp(view.panY + dy, h, area.height) };
}

/** Area pixel (relative to the area's top-left) to stage unit. */
export const toStage = (view: Viewport, p: Point): Point => ({ x: (p.x - view.panX) / view.zoom, y: (p.y - view.panY) / view.zoom });
