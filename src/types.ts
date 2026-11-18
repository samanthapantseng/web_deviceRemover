export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A box by its corners, in frame pixels. */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Intersection over union of two boxes: 0 apart, 1 identical. */
export function iou(a: Box, b: Box): number {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter);
}

export interface CanvasPair {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/**
 * `readback: true` keeps the canvas on the CPU, which makes getImageData cheap. Use it for
 * canvases whose pixels are read every frame (model inputs); leave it off for canvases that
 * are only ever drawn to the screen.
 */
export function makeCanvas(w: number, h: number, readback = false): CanvasPair {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: readback });
  if (!ctx) throw new Error('2D canvas is not available');
  return { canvas, ctx };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Grow a rect by `pad` px on every side and clip it to a w×h frame. */
export function expandRect(r: Rect, pad: number, w: number, h: number): Rect {
  const x = Math.max(0, r.x - pad);
  const y = Math.max(0, r.y - pad);
  return { x, y, w: Math.min(w, r.x + r.w + pad) - x, h: Math.min(h, r.y + r.h + pad) - y };
}

export function sameRect(a: Rect | null, b: Rect | null): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
