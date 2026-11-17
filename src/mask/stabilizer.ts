import { expandRect, unionRect, type Rect } from '../types';
import { DistanceField } from './distance';

export interface StabilizerParams {
  dilate: number;
  feather: number;
  /** Frames to keep the mask frozen after the detector loses the phone. */
  holdFrames: number;
  /** Frames a pixel stays in the mask after it was last detected as phone (>= 1). */
  persistFrames: number;
}

export interface StableMask {
  /** False when there is nothing to erase this frame. */
  present: boolean;
  /** True when this frame is running on a held mask (the detector found nothing). */
  held: boolean;
  /** Frame-sized. 255 inside the dilated phone mask, ramping to 0 across the feather. */
  alpha: Uint8Array;
  /** Bounds of alpha > 0. Everything inside this with alpha > 0 has to be filled. */
  roi: Rect;
}

const EMPTY: Rect = { x: 0, y: 0, w: 0, h: 0 };

/**
 * Turns the raw per-frame detector mask into a temporally stable, dilated, feathered alpha.
 * Flicker is the most visible failure of the piece, so three things happen here:
 *  - persistence: a pixel that was phone recently stays masked for a few frames (union over time),
 *    so a mask edge that wobbles between frames never exposes a sliver of phone;
 *  - hold: when the detector drops out entirely the whole mask is frozen for `holdFrames`;
 *  - dilation + feather from one distance field, so the edge is round and soft.
 */
export class MaskStabilizer {
  readonly alpha: Uint8Array;
  private age: Uint8Array;
  private ageBounds: Rect | null = null;
  private alphaRoi: Rect | null = null;
  private misses = Number.MAX_SAFE_INTEGER;
  private dist = new Float32Array(0);
  private field = new DistanceField();

  constructor(
    private width: number,
    private height: number,
  ) {
    this.alpha = new Uint8Array(width * height);
    this.age = new Uint8Array(width * height);
  }

  reset(): void {
    this.age.fill(0);
    this.alpha.fill(0);
    this.ageBounds = null;
    this.alphaRoi = null;
    this.misses = Number.MAX_SAFE_INTEGER;
  }

  update(raw: Uint8Array | null, rawBounds: Rect | null, p: StabilizerParams): StableMask {
    const detected = raw !== null && rawBounds !== null;
    this.misses = detected ? 0 : Math.min(this.misses + 1, Number.MAX_SAFE_INTEGER);
    const held = !detected && this.ageBounds !== null && this.misses <= p.holdFrames;

    if (!held) this.decay();
    if (detected) this.stamp(raw, rawBounds, Math.max(1, Math.min(255, Math.round(p.persistFrames))));

    this.clearAlpha();
    if (!this.ageBounds) return { present: false, held: false, alpha: this.alpha, roi: EMPTY };

    const reach = Math.ceil(p.dilate + p.feather) + 1;
    const roi = expandRect(this.ageBounds, reach, this.width, this.height);
    if (this.dist.length < roi.w * roi.h) this.dist = new Float32Array(roi.w * roi.h);
    this.field.compute(this.age, this.width, roi, this.dist);

    const { alpha, dist, width } = this;
    const feather = Math.max(p.feather, 0.001);
    for (let y = 0; y < roi.h; y++) {
      const o = (roi.y + y) * width + roi.x;
      const s = y * roi.w;
      for (let x = 0; x < roi.w; x++) {
        const t = (dist[s + x] - p.dilate) / feather;
        // smoothstep falloff across the feather band
        alpha[o + x] = t <= 0 ? 255 : t >= 1 ? 0 : Math.round(255 * (1 - t * t * (3 - 2 * t)));
      }
    }
    this.alphaRoi = roi;
    return { present: true, held, alpha, roi };
  }

  private decay(): void {
    const b = this.ageBounds;
    if (!b) return;
    const { age, width } = this;
    let x1 = b.x + b.w;
    let y1 = b.y + b.h;
    let x2 = b.x - 1;
    let y2 = b.y - 1;
    for (let y = b.y; y < b.y + b.h; y++) {
      const row = y * width;
      for (let x = b.x; x < b.x + b.w; x++) {
        const a = age[row + x];
        if (a === 0) continue;
        if (a > 1) {
          if (x < x1) x1 = x;
          if (x > x2) x2 = x;
          if (y < y1) y1 = y;
          if (y > y2) y2 = y;
        }
        age[row + x] = a - 1;
      }
    }
    this.ageBounds = x2 >= x1 && y2 >= y1 ? { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 } : null;
  }

  private stamp(raw: Uint8Array, b: Rect, frames: number): void {
    const { age, width } = this;
    let any = false;
    for (let y = b.y; y < b.y + b.h; y++) {
      const row = y * width;
      for (let x = b.x; x < b.x + b.w; x++) {
        if (raw[row + x]) {
          age[row + x] = frames;
          any = true;
        }
      }
    }
    if (any) this.ageBounds = unionRect(this.ageBounds, b);
  }

  private clearAlpha(): void {
    const r = this.alphaRoi;
    if (!r) return;
    for (let y = r.y; y < r.y + r.h; y++) {
      const row = y * this.width;
      this.alpha.fill(0, row + r.x, row + r.x + r.w);
    }
    this.alphaRoi = null;
  }
}
