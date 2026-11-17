import type { FillId, Settings } from '../settings';
import type { Rect } from '../types';

export interface FillJob {
  /** The camera frame (width × height) the mask belongs to. */
  frame: HTMLCanvasElement;
  width: number;
  height: number;
  /** Frame-sized mask; every pixel with alpha > 0 must be replaced. */
  alpha: Uint8Array;
  /** Bounds of alpha > 0. */
  hole: Rect;
  /** Context window around the hole (from CropTracker), in frame px. */
  rect: Rect;
  settings: Settings;
}

/**
 * A fill produces a phone-free picture of `job.rect`. It may return a canvas of any size
 * (it is scaled to the rect when composited) and may reuse that canvas on the next call.
 */
export interface Fill {
  readonly id: FillId;
  readonly label: string;
  /**
   * How much surrounding picture this fill wants: side of the context window as a multiple
   * of the hole's longer side. (The "inpaint crop size" setting is the lower bound.)
   */
  readonly context: number;
  /** e.g. "webgpu", "wasm", "opencv.js", "canvas". Shown in the debug panel. */
  backend(): string;
  init(onProgress?: (fraction: number) => void): Promise<void>;
  run(job: FillJob): Promise<HTMLCanvasElement>;
}

/** Nearest-neighbour copy of the hole (alpha > 0) into a w×h byte mask covering `rect`. */
export function sampleHole(
  job: FillJob,
  w: number,
  h: number,
  out: Uint8Array,
  holeValue: number,
  keepValue: number,
): void {
  const { alpha, rect, width } = job;
  for (let y = 0; y < h; y++) {
    const fy = rect.y + Math.min(rect.h - 1, Math.floor(((y + 0.5) * rect.h) / h));
    const row = fy * width + rect.x;
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(rect.w - 1, Math.floor(((x + 0.5) * rect.w) / w));
      out[o + x] = alpha[row + fx] > 0 ? holeValue : keepValue;
    }
  }
}
