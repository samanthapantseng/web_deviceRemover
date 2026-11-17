import type { Rect } from '../types';

/** Keep the current window while the hole stays this far (fraction of the side) inside it. */
const MARGIN = 0.06;

/**
 * Chooses the (square, where the frame allows) window around the hole that is handed to the
 * inpainter, and keeps it still for as long as possible.
 *
 * A generative inpainter gives a visibly different result when its input window shifts by a
 * few pixels. Following the detector box frame by frame makes the fill shimmer, so the window
 * only jumps when the hole gets close to its edge or changes size a lot.
 */
export class CropTracker {
  private rect: Rect | null = null;

  constructor(
    private width: number,
    private height: number,
  ) {}

  reset(): void {
    this.rect = null;
  }

  /**
   * @param minSide  smallest allowed window side, frame px
   * @param context  window side as a multiple of the hole's longer side
   */
  update(hole: Rect, minSide: number, context: number): Rect {
    const want = Math.max(minSide, Math.max(hole.w, hole.h) * context);
    const w = Math.min(this.width, Math.round(want / 2) * 2);
    const h = Math.min(this.height, Math.round(want / 2) * 2);

    const cur = this.rect;
    if (cur && cur.w >= w * 0.8 && cur.w <= w * 1.35 && cur.h >= h * 0.8 && cur.h <= h * 1.35 && this.holds(cur, hole)) {
      return cur;
    }

    const x = Math.round(Math.min(Math.max(hole.x + hole.w / 2 - w / 2, 0), this.width - w));
    const y = Math.round(Math.min(Math.max(hole.y + hole.h / 2 - h / 2, 0), this.height - h));
    this.rect = { x, y, w, h };
    return this.rect;
  }

  /** True if `hole` sits comfortably inside `r` (a side lying on the frame edge needs no margin). */
  private holds(r: Rect, hole: Rect): boolean {
    const mx = r.w * MARGIN;
    const my = r.h * MARGIN;
    const left = hole.x - r.x;
    const top = hole.y - r.y;
    const right = r.x + r.w - (hole.x + hole.w);
    const bottom = r.y + r.h - (hole.y + hole.h);
    if (left < 0 || top < 0 || right < 0 || bottom < 0) return false;
    return (
      (left >= mx || r.x === 0) &&
      (top >= my || r.y === 0) &&
      (right >= mx || r.x + r.w === this.width) &&
      (bottom >= my || r.y + r.h === this.height)
    );
  }
}
